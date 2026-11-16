"""飞书先确认收到事件，后台根据原话处理。入站记录、任务和回复可以一起提交。"""

import asyncio
import logging
from datetime import timedelta

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..agent import feishu_intent
from ..agent.scenarios import answer_question
from ..config import get_settings
from ..db import session_scope
from ..models import InboundEvent, Task
from . import feishu, notify
from . import states as S
from .core import after_commit, commit
from .errors import ApiError
from .tasks import answer_input, autonomy

log = logging.getLogger("acp.feishu.intent")
PENDING = "message.intent_pending"
wakeup = asyncio.Event()


async def enqueue_message(db: AsyncSession, row: InboundEvent, direct: bool, suggested: dict | None, message: dict) -> dict:
    source = row.payload or {}
    message_id = source.get("message_id")
    if message_id:
        await feishu._lock_message(db, message_id)
        await db.flush()
        prior = await db.scalar(select(InboundEvent).where(
            InboundEvent.id != row.id, InboundEvent.source == "feishu",
            InboundEvent.payload["kind"].astext == "message", InboundEvent.payload["message_id"].astext == message_id,
        ).order_by(InboundEvent.id).limit(1))
        if prior:
            row.kind, row.status, row.task_id = "message.duplicate", "ignored", prior.task_id
            return {"ok": True, "duplicate": True, "task_id": prior.task_id}
    row.kind, row.status = PENDING, "pending"
    row.payload = {**source, "direct": direct, "suggested": suggested,
                   "thread": message.get("thread_id") or message.get("root_id")}
    after_commit(db, wakeup.set)
    return {"ok": True, "queued": True}


async def _last_turn(db: AsyncSession, row: InboundEvent) -> dict | None:
    source = row.payload
    if not source["direct"] or not source.get("sender_open_id"):
        return None
    thread = source.get("thread")
    scope = InboundEvent.payload["thread"].astext
    stmt = select(InboundEvent).where(
        InboundEvent.source == "feishu", InboundEvent.id < row.id,
        InboundEvent.created_at >= row.created_at - timedelta(minutes=30),
        InboundEvent.payload["direct"].as_boolean().is_(True), InboundEvent.status == "processed",
        InboundEvent.payload["sender_open_id"].astext == source["sender_open_id"],
        InboundEvent.payload["chat_id"].astext == source.get("chat_id"),
        or_(scope == thread, InboundEvent.payload["message_id"].astext == thread) if thread else scope.is_(None),
    ).order_by(InboundEvent.id.desc()).limit(1)
    previous = await db.scalar(stmt)
    if not previous:
        return None
    turn = {"原话": previous.payload.get("request_text") or feishu.AT_PLACEHOLDER.sub("", previous.payload.get("text", "")).strip()}
    if previous.kind == "message.clarify":
        turn["追问"] = previous.payload["clarification"]
    if previous.task_id:
        turn["关联任务"] = f"ACP-{previous.task_id}"
    return turn


def _reply(db: AsyncSession, row: InboundEvent, kind: str, text: str) -> None:
    row.kind = kind
    source = row.payload
    notify.notify_text(db, "chat_id", source["chat_id"], text[:3000], reply_to=source.get("message_id"))


async def process_message(db: AsyncSession, row: InboundEvent) -> None:
    source = row.payload
    text = feishu.AT_PLACEHOLDER.sub("", source.get("text") or "").strip()
    chat_id, message_id, direct = source.get("chat_id"), source.get("message_id"), source["direct"]
    if not chat_id or not await feishu._chat_allowed(db, chat_id, source.get("chat_type")):
        row.kind, row.status = "message.ignored", "ignored"
        return
    previous = await _last_turn(db, row)
    decision = await feishu_intent.interpret(text, direct=direct, previous=previous)
    row.status = "processed"
    if decision is None:
        row.kind, row.status, row.error = "message.intent_failed", "error", "未取得有效的意图判断"
        if direct:
            _reply(db, row, row.kind, "这次没能判断你的意思。请重发这条消息，或在原消息上选择「ACP 建单」。")
        return
    intent = decision.intent
    row.payload = {**source, "intent": intent, "intent_model": get_settings().llm_model}
    if not direct:
        if intent == "create" and message_id:
            row.kind = "message.suspected"
            notify.enqueue(db, "feishu.card", {
                "receive_id_type": "chat_id", "receive_id": chat_id, "reply_to_message_id": message_id,
                "card": notify.intake_confirm_card(text, message_id, chat_id),
            })
        else:
            row.kind, row.status = "message.ignored", "ignored"
        return
    request = previous["原话"] + "\n" + text if previous and decision.continuation else text
    if intent == "clarify":
        row.payload = {**row.payload, "request_text": request, "clarification": decision.text}
        _reply(db, row, "message.clarify", decision.text)
    elif intent == "create":
        sender = await feishu.member_by_open_id(db, source.get("sender_open_id"))
        if not sender or not (message_id or row.external_id):
            raise ApiError("validation_error", "缺少原消息或发送者信息，请重新发送需求。", 422)
        await feishu._create_from_message(
            db, feishu.as_principal(sender), message_id, chat_id, row, text=request,
            title=decision.text[:120], via="message", suggested=source.get("suggested"),
        )
    elif intent == "supplement":
        number = feishu.TASK_KEY.match(text)
        body = text[number.end():].strip(" ：:") if number else ""
        task = await db.get(Task, int(number[1]), with_for_update=True) if body else None
        if task is None or task.state != S.INPUT_REQUIRED:
            _reply(db, row, "message.reply", "这段补充对应哪个待补充任务？请在内容前写上它的 ACP 编号。")
            return
        sender = await feishu.member_by_open_id(db, source.get("sender_open_id"))
        if not sender:
            raise ApiError("unauthorized", "无法识别操作人", 401)
        await answer_input(db, feishu.as_principal(sender), task, body)
        row.task_id = task.id
        _reply(db, row, "message.answer", f"已把补充信息转给 {task.key} 的 Agent")
    elif intent == "lookup":
        asker = await feishu.member_by_open_id(db, source.get("sender_open_id"))
        levels = await autonomy(db)
        if previous and decision.continuation and previous.get("关联任务"):
            request = previous["关联任务"] + "\n" + request
        reply = await answer_question(db, request, asker, enabled=levels.get("qa") != "off")
        _reply(db, row, "message.qa", reply)
    else:
        enabled = (await autonomy(db)).get("qa") != "off"
        reply = decision.text if enabled and intent == "reply" else feishu._help_text()
        _reply(db, row, "message.reply", reply)


async def inbox_worker(stop: asyncio.Event) -> None:
    while not stop.is_set():
        wakeup.clear()
        try:
            async with session_scope() as db:
                # 按收到顺序处理，追问的下一句可见上一轮事务；重启后继续待处理记录。
                row = await db.scalar(select(InboundEvent).where(
                    InboundEvent.source == "feishu", InboundEvent.kind == PENDING,
                ).order_by(InboundEvent.id).limit(1).with_for_update())
                if row:
                    try:
                        async with db.begin_nested():
                            await process_message(db, row)
                    except Exception as exc:
                        db.info.pop("after_commit", None)
                        await db.refresh(row)
                        reason = exc.message if isinstance(exc, ApiError) else "这次处理未完成，请重发这条消息。"
                        log.warning("飞书事件 %s 处理失败：%s", row.id, type(exc).__name__)
                        row.kind, row.status, row.error = "message.intent_failed", "error", reason
                        if row.payload.get("direct") and row.payload.get("chat_id"):
                            _reply(db, row, row.kind, reason)
                    await commit(db)
                    continue
        except Exception:
            log.exception("读取飞书待处理消息失败")
        try:
            await asyncio.wait_for(wakeup.wait(), timeout=15)
        except TimeoutError:
            pass
