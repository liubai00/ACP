"""通知：飞书卡片模板 + outbox 投递。卡片按钮 value 统一为 {acp:1, action, task_id, ...}。"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..broker import outbox_wakeup
from ..config import get_settings
from ..db import session_scope
from ..integrations import feishu_api, gitlab_api
from ..models import Approval, Member, MergeRequest, Outbox, Suggestion, Task, utcnow
from .core import get_setting, wake_outbox
from .states import LABELS, PRIORITY_LABELS, SOURCE_LABELS

log = logging.getLogger("acp.notify")

STATE_COLORS = {
    "submitted": "blue",
    "working": "wathet",
    "input-required": "orange",
    "auth-required": "purple",
    "completed": "green",
    "failed": "red",
    "canceled": "grey",
    "rejected": "grey",
}


def task_url(task_id: int) -> str:
    return f"{get_settings().public_url.rstrip('/')}/tasks/{task_id}"


def _btn(text: str, action: str, *, kind: str = "default", **value: Any) -> dict[str, Any]:
    return {
        "tag": "button",
        "text": {"tag": "plain_text", "content": text},
        "type": kind,
        "value": {"acp": 1, "action": action, **value},
    }


def _link_btn(text: str, url: str) -> dict[str, Any]:
    return {"tag": "button", "text": {"tag": "plain_text", "content": text}, "type": "default", "url": url}


def _field(label: str, value: str) -> dict[str, Any]:
    return {"is_short": True, "text": {"tag": "lark_md", "content": f"**{label}**\n{value or '—'}"}}


def _card(title: str, color: str, elements: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {"template": color, "title": {"tag": "plain_text", "content": title[:100]}},
        "elements": elements,
    }


def _trim(text: str, n: int = 400) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def task_card(task: Task, *, assignee: Member | None, suggested: Member | None, note: str | None = None) -> dict[str, Any]:
    fields = [
        _field("状态", LABELS.get(task.state, task.state)),
        _field("优先级", PRIORITY_LABELS.get(task.priority, task.priority)),
        _field("负责人", assignee.name if assignee else "待认领"),
        _field("来源", SOURCE_LABELS.get(task.source, task.source)),
    ]
    if suggested and not assignee:
        fields.append(_field("推荐负责人", suggested.name))
    if task.repos:
        fields.append(_field("涉及仓库", "、".join(task.repos)))
    elements: list[dict[str, Any]] = [{"tag": "div", "fields": fields}]
    if task.description and task.description.strip() != task.title.strip():
        elements.append({"tag": "div", "text": {"tag": "lark_md", "content": _trim(task.description)}})
    if note:
        elements.append({"tag": "note", "elements": [{"tag": "lark_md", "content": _trim(note, 200)}]})
    actions = []
    if task.state == "submitted":
        actions.append(_btn("认领", "claim", kind="primary", task_id=task.id))
    actions.append(_link_btn("查看详情", task_url(task.id)))
    elements.append({"tag": "action", "actions": actions})
    return _card(f"{task.key} {task.title}", STATE_COLORS.get(task.state, "blue"), elements)


def dispatch_card(task: Task, member: Member, reason: str) -> dict[str, Any]:
    elements = [
        {"tag": "div", "text": {"tag": "lark_md", "content": f"**{task.key} {task.title}**\n{_trim(task.description, 200)}"}},
        {"tag": "note", "elements": [{"tag": "lark_md", "content": f"推荐给 {member.name}：{_trim(reason, 160)}"}]},
        {
            "tag": "action",
            "actions": [
                _btn("接受", "accept", kind="primary", task_id=task.id),
                _btn("不接", "decline", task_id=task.id),
                _link_btn("查看详情", task_url(task.id)),
            ],
        },
    ]
    return _card("派工提醒", "blue", elements)


def approval_card(task: Task, approval: Approval, mrs: list[MergeRequest]) -> dict[str, Any]:
    lines = [f"- [{m.repo} !{m.iid}]({m.url}) CI：{m.pipeline_status}" for m in mrs if m.url]
    body = "\n".join(lines) or "（无 MR 链接）"
    gate = {"merge": "合并前审批", "high_risk": "高风险操作审批", "claim": "认领审批"}.get(approval.gate, approval.gate)
    elements = [
        {"tag": "div", "text": {"tag": "lark_md", "content": f"**{task.key} {task.title}**\n{body}"}},
    ]
    if approval.note:
        elements.append({"tag": "note", "elements": [{"tag": "lark_md", "content": _trim(approval.note, 200)}]})
    elements.append(
        {
            "tag": "action",
            "actions": [
                _btn("同意", "approve", kind="primary", task_id=task.id, approval_id=approval.id),
                _btn("驳回", "reject", kind="danger", task_id=task.id, approval_id=approval.id),
                _link_btn("查看详情", task_url(task.id)),
            ],
        }
    )
    return _card(gate, "purple", elements)


def input_card(task: Task, question: str) -> dict[str, Any]:
    elements = [
        {"tag": "div", "text": {"tag": "lark_md", "content": f"**{task.key} {task.title}**\nAgent 需要补充信息：\n{_trim(question, 500)}"}},
        {"tag": "note", "elements": [{"tag": "lark_md", "content": "在任务详情页回答，或直接回复这条消息并 @机器人"}]},
        {"tag": "action", "actions": [_link_btn("去回答", task_url(task.id))]},
    ]
    return _card("需要补充信息", "orange", elements)


def suggestion_card(s: Suggestion, task: Task | None) -> dict[str, Any]:
    head = f"**{task.key} {task.title}**\n" if task else ""
    elements: list[dict[str, Any]] = [
        {"tag": "div", "text": {"tag": "lark_md", "content": head + _trim(s.summary, 600)}},
        {"tag": "note", "elements": [{"tag": "lark_md", "content": f"协调建议 · {s.scenario} · {s.level}"}]},
    ]
    actions = []
    if s.status == "proposed":
        actions = [
            _btn("采纳", "suggestion_accept", kind="primary", suggestion_id=s.id, task_id=s.task_id),
            _btn("忽略", "suggestion_reject", suggestion_id=s.id, task_id=s.task_id),
        ]
    elif s.status == "executed" and s.undo:
        actions = [_btn("撤销", "suggestion_undo", kind="danger", suggestion_id=s.id, task_id=s.task_id)]
    if task:
        actions.append(_link_btn("查看详情", task_url(task.id)))
    if actions:
        elements.append({"tag": "action", "actions": actions})
    return _card("协调建议", "indigo", elements)


def intake_confirm_card(text: str, message_id: str, chat_id: str) -> dict[str, Any]:
    elements = [
        {"tag": "div", "text": {"tag": "lark_md", "content": f"这条消息看起来像一个需求：\n> {_trim(text, 300)}"}},
        {
            "tag": "action",
            "actions": [
                _btn("建单", "create_from_message", kind="primary", payload={"message_id": message_id, "chat_id": chat_id}),
                _btn("忽略", "ignore", payload={"message_id": message_id}),
            ],
        },
    ]
    return _card("要建单吗？", "blue", elements)


# ---------------------------------------------------------------- outbox

async def default_chat_id(db: AsyncSession) -> str | None:
    ids = await get_setting(db, "feishu_chat_ids", None)
    if ids is None:
        ids = get_settings().chat_ids
    return ids[0] if ids else None


def enqueue(db: AsyncSession, kind: str, payload: dict[str, Any], task_id: int | None = None) -> None:
    db.add(Outbox(kind=kind, payload=payload, task_id=task_id, status="pending", next_attempt_at=utcnow()))
    wake_outbox(db)


async def notify_task_card(db: AsyncSession, task: Task, note: str | None = None, *, new_message: bool = False) -> None:
    """发送或更新任务卡片。任务来自飞书群时发回该群；否则发默认群。"""
    assignee = await db.get(Member, task.assignee_id) if task.assignee_id else None
    suggested = await db.get(Member, task.suggested_assignee_id) if task.suggested_assignee_id else None
    card = task_card(task, assignee=assignee, suggested=suggested, note=note)
    if task.feishu_card_message_id and not new_message:
        enqueue(db, "feishu.card", {"update_message_id": task.feishu_card_message_id, "card": card}, task.id)
        return
    chat_id = task.feishu_chat_id or await default_chat_id(db)
    if not chat_id:
        return
    payload: dict[str, Any] = {"receive_id_type": "chat_id", "receive_id": chat_id, "card": card, "track_task_card": task.id}
    reply_to = (task.source_ref or {}).get("message_id") if task.source == "feishu" else None
    if reply_to and not task.feishu_card_message_id:
        payload["reply_to_message_id"] = reply_to
    enqueue(db, "feishu.card", payload, task.id)


def notify_member_card(db: AsyncSession, member: Member | None, card: dict[str, Any], task_id: int | None = None) -> bool:
    if member is None or not member.feishu_open_id:
        return False
    enqueue(db, "feishu.card", {"receive_id_type": "open_id", "receive_id": member.feishu_open_id, "card": card}, task_id)
    return True


def notify_text(db: AsyncSession, receive_id_type: str, receive_id: str, text: str, *, reply_to: str | None = None, task_id: int | None = None) -> None:
    payload: dict[str, Any] = {"receive_id_type": receive_id_type, "receive_id": receive_id, "text": text}
    if reply_to:
        payload["reply_to_message_id"] = reply_to
    enqueue(db, "feishu.text", payload, task_id)


async def _deliver(item: Outbox, mode: str, client: httpx.AsyncClient) -> dict[str, Any] | None:
    s = get_settings()
    p = item.payload
    if mode == "log":
        log.info("outbox[log] %s %s", item.kind, str(p)[:300])
        return {"mode": "log"}
    if mode == "n8n":
        r = await client.post(
            s.n8n_notify_url,
            json={"kind": item.kind, **p},
            headers={"X-ACP-Token": s.notify_token},
            timeout=20,
        )
        if r.status_code >= 300:
            raise RuntimeError(f"n8n HTTP {r.status_code}: {r.text[:200]}")
        try:
            return r.json() if r.content else {}
        except ValueError:
            return {"raw": r.text[:500]}
    # direct
    if item.kind == "feishu.card":
        if p.get("update_message_id"):
            return await feishu_api.update_card(p["update_message_id"], p["card"])
        if p.get("reply_to_message_id"):
            return await feishu_api.reply_message(p["reply_to_message_id"], "interactive", p["card"])
        return await feishu_api.send_message(p["receive_id_type"], p["receive_id"], "interactive", p["card"])
    if item.kind == "feishu.text":
        content = {"text": p["text"]}
        if p.get("reply_to_message_id"):
            return await feishu_api.reply_message(p["reply_to_message_id"], "text", content)
        return await feishu_api.send_message(p["receive_id_type"], p["receive_id"], "text", content)
    if item.kind == "gitlab.comment":
        return await gitlab_api.mr_comment(p["project"], int(p["mr_iid"]), p["body"])
    raise RuntimeError(f"未知通知类型 {item.kind}")


def _message_id(result: dict[str, Any] | None) -> str | None:
    if not result:
        return None
    for key in ("message_id",):
        if isinstance(result.get(key), str):
            return result[key]
    data = result.get("data")
    if isinstance(data, dict) and isinstance(data.get("message_id"), str):
        return data["message_id"]
    return None


async def process_outbox_once(limit: int = 20) -> int:
    s = get_settings()
    done = 0
    async with session_scope() as db:
        mode = await get_setting(db, "notify_mode", s.notify_mode)
        items = (
            await db.execute(
                select(Outbox)
                .where(Outbox.status == "pending", Outbox.next_attempt_at <= utcnow())
                .order_by(Outbox.id)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        ).scalars().all()
        if not items:
            return 0
        async with httpx.AsyncClient() as client:
            for item in items:
                if mode != "log" and item.kind.startswith("feishu.") and not s.feishu_enabled:
                    item.status = "skipped"
                    item.last_error = "飞书 App ID / App Secret 未配置，跳过"
                    done += 1
                    continue
                if mode != "log" and item.kind == "gitlab.comment" and not (s.gitlab_url and (mode == "n8n" or s.gitlab_bot_token)):
                    item.status = "skipped"
                    item.last_error = "GitLab 地址或机器人令牌未配置，跳过"
                    done += 1
                    continue
                item.attempts += 1
                try:
                    result = await _deliver(item, mode, client)
                    item.status = "sent"
                    item.sent_at = utcnow()
                    item.result = result if isinstance(result, dict) else None
                    item.last_error = None
                    tracked = item.payload.get("track_task_card")
                    mid = _message_id(result)
                    if tracked and mid:
                        await db.execute(update(Task).where(Task.id == int(tracked)).values(feishu_card_message_id=mid))
                except Exception as exc:  # noqa: BLE001
                    item.last_error = str(exc)[:1000]
                    if item.attempts >= 8:
                        item.status = "failed"
                    else:
                        item.next_attempt_at = utcnow() + timedelta(seconds=min(600, 5 * 2 ** item.attempts))
                    log.warning("outbox %s 投递失败（第 %s 次）：%s", item.id, item.attempts, exc)
                done += 1
    return done


async def outbox_worker(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            n = await process_outbox_once()
        except Exception as exc:  # noqa: BLE001
            log.exception("outbox worker 出错：%s", exc)
            n = 0
        if n == 0:
            outbox_wakeup.clear()
            try:
                await asyncio.wait_for(outbox_wakeup.wait(), timeout=5)
            except TimeoutError:
                pass
