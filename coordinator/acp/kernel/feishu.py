"""飞书事件：内核先分流，卡片按钮直接执行，只有自然语言才唤醒协调 Agent。

三种进单方式（ACP_FEISHU_INTAKE_MODE / 设置页可改）：
- at_mention：模型理解发给机器人的话，受理工作、回答咨询或追问
- shortcut：在任意消息上点消息快捷操作“ACP 建单” → 用那条消息建单
- all：读取群内全部消息（需敏感权限），疑似需求先发“要建单吗？”确认卡，不自动建单
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..agent import llm
from ..config import get_settings
from ..integrations import feishu_api
from ..models import InboundEvent, Member, Task, utcnow
from ..security import Principal
from . import notify
from . import states as S
from .core import get_setting
from .errors import ApiError
from .hooks import trigger_after_commit
from .tasks import accept, answer_input, autonomy, claim, create_task, decide_approval, decline

AT_PLACEHOLDER = re.compile(r"@_user_\d+")
TASK_KEY = re.compile(r"ACP-(\d+)", re.I)
CREATE_COMMAND = re.compile(r"^(?:请)?(?:帮我)?(?:建单|创建任务|新建任务)(?=$|[\s:：])[\s:：]*")
NEED_WORDS = ("需求", "帮忙", "帮我", "麻烦", "修复", "修一下", "实现", "开发", "支持", "新增", "添加", "优化", "bug", "报错", "改一下", "适配", "需要")
QUESTION_WORDS = ("进度", "状态", "谁在", "多少", "查一下", "查询", "怎么样", "有哪些", "我的任务", "帮助", "help")
QUESTION = re.compile(r"[?？]|什么|干嘛|干吗|怎么|如何|为何|为什么|哪些|哪个|能否|是否|可不可以|能不能|吗[呀啊呢。！! ]*$", re.I)
ABOUT = re.compile(r"(?:acp|平台|机器人|你)(?:测试|协调)?\s*(?:是(?:做|干)?什么|.*?(?:干[嘛吗]|干什么|有什么用|是做什么|用来做什么|有何用|能做什么|怎么用))|(?:什么是|介绍一下|介绍下)\s*acp|怎么建单|如何建单", re.I)


def normalize_raw(raw: dict[str, Any]) -> dict[str, Any]:
    """把 feishu-bridge 转发的原始事件归一化（n8n 不可用时的直连通路用；n8n 工作流做同样的事）。"""
    header = raw.get("header") or {}
    event = raw.get("event") or {}
    etype = header.get("event_type") or raw.get("type") or ""
    out: dict[str, Any] = {"event_id": header.get("event_id") or raw.get("uuid"), "event_type": etype, "raw": raw}
    if etype == "im.message.receive_v1":
        msg = event.get("message") or {}
        sender = (event.get("sender") or {}).get("sender_id") or {}
        text = ""
        try:
            content = json.loads(msg.get("content") or "{}")
            text = content.get("text") or ""
            if not text and msg.get("message_type") == "post":
                text = _post_text(content)
        except ValueError:
            text = ""
        bot_id = raw.get("_acp_bot_open_id")
        mentions = []
        for m in msg.get("mentions") or []:
            item = {"open_id": (m.get("id") or {}).get("open_id"), "name": m.get("name"), "key": m.get("key")}
            if bot_id:
                item["is_bot"] = item["open_id"] == bot_id
            mentions.append(item)
        out.update(
            kind="message",
            chat_id=msg.get("chat_id"),
            chat_type=msg.get("chat_type"),
            message_id=msg.get("message_id"),
            sender_open_id=sender.get("open_id"),
            text=text,
            mentions=mentions,
        )
    elif etype == "card.action.trigger":
        action = event.get("action") or {}
        ctx = event.get("context") or {}
        operator = event.get("operator") or {}
        out.update(
            kind="card_action",
            chat_id=ctx.get("open_chat_id"),
            message_id=ctx.get("open_message_id"),
            sender_open_id=operator.get("open_id"),
            action={
                "value": action.get("value") or {},
                "operator_open_id": operator.get("open_id"),
                "open_message_id": ctx.get("open_message_id"),
                "form_value": action.get("form_value"),
                "input_value": action.get("input_value"),
            },
        )
    elif "shortcut" in etype or (event.get("action") or {}).get("type") == "message_shortcut":
        operator = event.get("operator") or {}
        out.update(
            kind="shortcut",
            chat_id=event.get("chat_id") or (event.get("context") or {}).get("open_chat_id"),
            message_id=event.get("message_id") or (event.get("context") or {}).get("open_message_id"),
            sender_open_id=(operator.get("operator_id") or {}).get("open_id") or operator.get("open_id"),
        )
    else:
        out["kind"] = "other"
    return out


def _post_text(content: dict[str, Any]) -> str:
    parts: list[str] = []
    body = content.get("content") or content.get("zh_cn", {}).get("content") or []
    for line in body:
        for seg in line:
            if seg.get("tag") in ("text", "a"):
                parts.append(seg.get("text", ""))
        parts.append("\n")
    return "".join(parts).strip()


async def member_by_open_id(db: AsyncSession, open_id: str | None, name: str | None = None) -> Member | None:
    """按 open_id 找成员；没有就创建一个（第一次在飞书里互动的人）。"""
    if not open_id:
        return None
    m = (await db.execute(select(Member).where(Member.feishu_open_id == open_id))).scalar_one_or_none()
    if m is not None:
        if name and m.name.startswith("飞书用户"):
            m.name = name
        return m
    info = None
    if not name and get_settings().feishu_enabled:
        info = await feishu_api.get_user(open_id)
    m = Member(
        name=(name or (info or {}).get("name") or f"飞书用户{open_id[-4:]}")[:100],
        feishu_open_id=open_id,
        avatar_url=((info or {}).get("avatar") or {}).get("avatar_72"),
        roles=["member"],
        created_at=utcnow(),
    )
    db.add(m)
    await db.flush()
    return m


def as_principal(m: Member) -> Principal:
    return Principal(type="member", member_id=m.id, name=m.name, roles=list(m.roles or []))


async def _chat_allowed(db: AsyncSession, chat_id: str | None, chat_type: str | None) -> bool:
    if chat_type == "p2p":
        return True
    ids = await get_setting(db, "feishu_chat_ids", None)
    if ids is None:
        ids = get_settings().chat_ids
    return not ids or (chat_id in ids)


async def _modes(db: AsyncSession) -> list[str]:
    modes = await get_setting(db, "intake_modes", None)
    return modes if modes is not None else get_settings().intake_modes


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", AT_PLACEHOLDER.sub("", text or "")).strip()


def _title_from(text: str) -> str:
    first = re.split(r"[\n。！？!?；;]", text.strip(), maxsplit=1)[0].strip()
    return (first or text.strip())[:60] or "未命名需求"


async def handle_event(db: AsyncSession, ev: dict[str, Any]) -> dict[str, Any]:
    event_id = ev.get("event_id")
    kind = ev.get("kind") or "other"
    if event_id:
        # 飞书重投可能与原请求同时到达，先按事件串行再查唯一记录。
        await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(f"feishu:event:{event_id}", 0))))
        dup = (
            await db.execute(select(InboundEvent).where(InboundEvent.source == "feishu", InboundEvent.external_id == event_id))
        ).scalar_one_or_none()
        if dup is not None:
            return {"ok": True, "duplicate": True, "task_id": dup.task_id}
    inbound = InboundEvent(
        source="feishu",
        kind=f"{kind}",
        external_id=event_id,
        summary=_clean_text(ev.get("text") or "")[:200] or (ev.get("event_type") or kind),
        payload={k: v for k, v in ev.items() if k != "raw"},
        created_at=utcnow(),
    )
    db.add(inbound)
    try:
        if kind == "message":
            result = await _on_message(db, ev, inbound)
        elif kind == "card_action":
            result = await _on_card_action(db, ev, inbound)
        elif kind == "shortcut":
            result = await _on_shortcut(db, ev, inbound)
        else:
            inbound.status = "ignored"
            result = {"ok": True, "ignored": True}
    except ApiError as exc:
        inbound.status = "error"
        inbound.error = exc.message
        return {"ok": False, "toast": {"type": "error", "content": exc.message[:60]}}
    return result


async def _on_message(db: AsyncSession, ev: dict[str, Any], inbound: InboundEvent) -> dict[str, Any]:
    chat_id, chat_type = ev.get("chat_id"), ev.get("chat_type") or "group"
    if not await _chat_allowed(db, chat_id, chat_type):
        inbound.status = "ignored"
        inbound.error = "不是受理的群"
        return {"ok": True, "ignored": True}
    mentions = ev.get("mentions") or []
    bot_id = await feishu_api.bot_open_id() if mentions and not any("is_bot" in m for m in mentions) and get_settings().feishu_enabled else None
    if any("is_bot" in m for m in mentions):
        bot_mentioned = any(m.get("is_bot") for m in mentions)
        others = [m for m in mentions if not m.get("is_bot")]
    elif bot_id:
        bot_mentioned = any(m.get("open_id") == bot_id for m in mentions)
        others = [m for m in mentions if m.get("open_id") != bot_id]
    else:
        # 不知道机器人的 open_id：约定第一个 @ 是机器人（只开 @机器人 权限时，能收到群消息本身就说明 @了机器人）
        bot_mentioned = bool(mentions)
        others = mentions[1:]
    text = _clean_text(ev.get("text") or "")
    modes = await _modes(db)
    direct = chat_type == "p2p" or (bot_mentioned and "at_mention" in modes)
    if not direct and "all" not in modes:
        inbound.status = "ignored"
        return {"ok": True, "ignored": True}
    raw_event = ((ev.get("raw") or {}).get("event") or {})
    if (raw_event.get("sender") or {}).get("sender_type") == "app" or ev.get("sender_type") == "app":
        inbound.status = "ignored"
        return {"ok": True, "ignored": True}
    if text and llm.enabled():
        from .feishu_inbox import enqueue_message

        return await enqueue_message(db, inbound, direct, others[0] if others else None, raw_event.get("message") or {})

    # 未配置协调模型时仍支持明确命令、卡片和规则查询。
    command = CREATE_COMMAND.match(text)
    message_id = ev.get("message_id")
    question = _looks_like_question(text)
    suspected = any(w in text.lower() for w in NEED_WORDS)
    if not direct and not ("all" in modes and (suspected or command) and not question):
        inbound.status = "ignored"
        return {"ok": True, "ignored": True}

    body = text[command.end():].strip() if command else ""
    command_question = re.match(r"^(?:是什么|是干嘛|怎么|如何|可以吗|能不能|是否|为什么)", body)
    if direct and command and body and not command_question:
        sender = await member_by_open_id(db, ev.get("sender_open_id"))
        actor = as_principal(sender) if sender else Principal(type="system", name="飞书")
        return await _create_from_message(db, actor, message_id, chat_id, inbound, text=body, via="message", suggested=others[0] if others else None)

    if direct and (not text or command or text.lower() in ("帮助", "help", "?", "？") or (not TASK_KEY.search(text) and ABOUT.search(text))):
        notify.notify_text(db, "chat_id", chat_id, _help_text(), reply_to=message_id)
        inbound.kind = "message.help"
        return {"ok": True, "help": True}

    # 只有以任务号开头且带正文的回复才可能是补充资料。
    m = TASK_KEY.match(text)
    if direct and m and not question and (body := text[m.end():].strip(" ：:")):
        task = await db.get(Task, int(m.group(1)))
        if task and task.state == S.INPUT_REQUIRED:
            sender = await member_by_open_id(db, ev.get("sender_open_id"))
            if not sender:
                raise ApiError("unauthorized", "无法识别操作人", 401)
            await answer_input(db, as_principal(sender), task, body)
            inbound.task_id = task.id
            inbound.kind = "message.answer"
            notify.notify_text(db, "chat_id", chat_id, f"已把补充信息转给 {task.key} 的 Agent", reply_to=ev.get("message_id"), task_id=task.id)
            return {"ok": True, "task_id": task.id}

    if not question and (suspected or command) and chat_id and message_id:
        notify.enqueue(db, "feishu.card", {
            "receive_id_type": "chat_id", "receive_id": chat_id, "reply_to_message_id": message_id,
            "card": notify.intake_confirm_card(text, message_id, chat_id),
        })
        inbound.kind = "message.suspected"
        inbound.payload = {**(inbound.payload or {}), "suggested": others[0] if others else None}
        return {"ok": True, "confirm": True}

    if question or TASK_KEY.search(text):
        sender = await member_by_open_id(db, ev.get("sender_open_id"))
        inbound.kind = "message.qa"
        levels = await autonomy(db)
        trigger_after_commit(
            db,
            "agent.qa",
            question=text,
            chat_id=chat_id,
            message_id=ev.get("message_id"),
            asker_id=str(sender.id) if sender else None,
            enabled=levels.get("qa") != "off",
        )
        return {"ok": True, "qa": True}

    notify.notify_text(db, "chat_id", chat_id, _help_text(), reply_to=message_id)
    inbound.kind = "message.help"
    return {"ok": True, "help": True}


def _looks_like_question(text: str) -> bool:
    t = text.strip()
    return bool(QUESTION.search(t)) or t.startswith(("查", "问")) or any(w in t[:12] for w in QUESTION_WORDS)


def _help_text() -> str:
    return (
        "ACP 帮团队把飞书里的开发需求交给负责人和开发机上的 Agent，并跟踪代码评审和合并进度。\n"
        "· 想了解进度，可以问「ACP-12 进度」或「我的任务」。\n"
        "· 直接告诉我希望团队做什么，例如「把首页的白屏问题处理一下」。也可以使用消息快捷操作建单。\n"
        "· 补充已有关联任务的信息，发「ACP-12 补充内容」。"
    )


async def _on_card_action(db: AsyncSession, ev: dict[str, Any], inbound: InboundEvent) -> dict[str, Any]:
    action = ev.get("action") or {}
    value = action.get("value") or {}
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            value = {}
    name = value.get("action")
    operator = await member_by_open_id(db, action.get("operator_open_id") or ev.get("sender_open_id"))
    if operator is None:
        raise ApiError("unauthorized", "无法识别操作人", 401)
    actor = as_principal(operator)
    inbound.kind = f"card.{name}"
    task_id = value.get("task_id")
    task = await db.get(Task, int(task_id), with_for_update=True) if task_id else None
    if task_id and task is None:
        raise ApiError("not_found", "任务不存在", 404)
    inbound.task_id = task.id if task else None

    if name == "claim" and task:
        await claim(db, actor, task)
        return {"ok": True, "task_id": task.id, "toast": {"type": "success", "content": f"已认领 {task.key}"}}
    if name == "accept" and task:
        await accept(db, actor, task)
        return {"ok": True, "task_id": task.id, "toast": {"type": "success", "content": f"已接受 {task.key}"}}
    if name == "decline" and task:
        await decline(db, actor, task)
        return {"ok": True, "task_id": task.id, "toast": {"type": "info", "content": "已拒绝，平台会另找人"}}
    if name in ("approve", "reject") and value.get("approval_id"):
        comment = (action.get("input_value") or "") or None
        await decide_approval(db, actor, int(value["approval_id"]), "approve" if name == "approve" else "reject", comment)
        return {"ok": True, "task_id": task_id, "toast": {"type": "success", "content": "已同意" if name == "approve" else "已驳回"}}
    if name in ("suggestion_accept", "suggestion_reject", "suggestion_undo") and value.get("suggestion_id"):
        from ..agent.suggestions import decide_suggestion

        verb = name.removeprefix("suggestion_")
        await decide_suggestion(db, actor, int(value["suggestion_id"]), verb)
        return {"ok": True, "task_id": task_id, "toast": {"type": "success", "content": {"accept": "已采纳", "reject": "已忽略", "undo": "已撤销"}[verb]}}
    if name == "create_from_message":
        payload = value.get("payload") or {}
        return await _create_from_message(db, actor, payload.get("message_id"), payload.get("chat_id"), inbound, via="confirm")
    if name == "ignore":
        payload = value.get("payload") or {}
        message_id = payload.get("message_id")
        if message_id:
            await _lock_message(db, message_id)
            original = await _pending_message(db, message_id, ev.get("chat_id"))
            if original and not original.task_id:
                original.status = "ignored"
        inbound.status = "ignored"
        return {"ok": True, "toast": {"type": "info", "content": "已忽略"}}
    inbound.status = "ignored"
    return {"ok": True, "ignored": True}


async def _on_shortcut(db: AsyncSession, ev: dict[str, Any], inbound: InboundEvent) -> dict[str, Any]:
    modes = await _modes(db)
    if "shortcut" not in modes:
        inbound.status = "ignored"
        return {"ok": True, "ignored": True, "toast": {"type": "info", "content": "消息快捷操作建单未开启"}}
    operator = await member_by_open_id(db, ev.get("sender_open_id"))
    if operator is None:
        raise ApiError("unauthorized", "无法识别操作人", 401)
    return await _create_from_message(db, as_principal(operator), ev.get("message_id"), ev.get("chat_id"), inbound, text=ev.get("text"))


async def _lock_message(db: AsyncSession, message_id: str) -> None:
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(f"feishu:message:{message_id}", 0))))


async def _pending_message(db: AsyncSession, message_id: str, chat_id: str | None) -> InboundEvent | None:
    return (await db.scalars(select(InboundEvent).where(
        InboundEvent.source == "feishu", InboundEvent.kind == "message.suspected",
        InboundEvent.payload["message_id"].astext == message_id, InboundEvent.payload["chat_id"].astext == chat_id,
    ).order_by(InboundEvent.id).limit(1))).first()


async def _create_from_message(
    db: AsyncSession, actor: Principal, message_id: str | None, chat_id: str | None, inbound: InboundEvent,
    *, text: str | None = None, via: str = "shortcut", suggested: dict | None = None, title: str | None = None,
) -> dict[str, Any]:
    source = inbound.payload or {}
    original = None
    if message_id:
        await _lock_message(db, message_id)
        existing = (
            await db.execute(select(Task).where(Task.source == "feishu", Task.source_ref["message_id"].astext == message_id))
        ).scalar_one_or_none()
        if existing is not None:
            inbound.task_id = existing.id
            return {"ok": True, "task_id": existing.id, "toast": {"type": "info", "content": f"这条消息已建过单：{existing.key}"}}
    if via == "confirm":
        original = await _pending_message(db, message_id, chat_id) if message_id else None
        if original is None:
            raise ApiError("validation_error", "找不到待确认的原消息，请重新发送需求", 422)
        if original.status == "ignored":
            return {"ok": True, "ignored": True, "toast": {"type": "info", "content": "这条需求已忽略"}}
        source = original.payload or {}
        text = source.get("text")
        suggested = source.get("suggested")
    if not text and message_id and get_settings().feishu_enabled:
        try:
            data = await feishu_api.get_message(message_id)
            items = data.get("items") or []
            if items:
                body = items[0].get("body", {}).get("content") or "{}"
                content = json.loads(body)
                text = content.get("text") or _post_text(content)
        except Exception:  # noqa: BLE001
            text = None
    text = _clean_text(text or "")
    if not text:
        raise ApiError("validation_error", "读不到这条消息的内容（需要“获取群组中的消息”权限）", 422)
    assignee = await member_by_open_id(db, suggested.get("open_id"), suggested.get("name")) if suggested else None
    task = await create_task(
        db,
        actor,
        title=title or _title_from(text),
        description=text,
        source="feishu",
        source_ref={"chat_id": chat_id, "message_id": message_id, "via": via, "sender_open_id": source.get("sender_open_id")},
        feishu_chat_id=chat_id,
        suggested_assignee_id=assignee.id if assignee else None,
    )
    inbound.task_id = task.id
    inbound.kind = f"{via}.task"
    if original is not None:
        original.task_id = task.id
    return {"ok": True, "task_id": task.id, "toast": {"type": "success", "content": f"已建单 {task.key}"}}


def new_state_token() -> str:
    return uuid.uuid4().hex
