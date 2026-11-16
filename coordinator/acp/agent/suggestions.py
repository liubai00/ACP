"""建议的记录、采纳、撤销。模型提议，规则裁决：落地动作只调用内核函数。"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from ..kernel import notify
from ..kernel import states as S
from ..kernel.core import get_member, get_task, publish_after_commit, record_event, serialize_suggestions
from ..kernel.errors import forbidden, invalid_state, not_found
from ..models import Member, Suggestion, Task, utcnow
from ..security import SYSTEM, Principal

SCENARIO_LABELS = {
    "intake": "建单整理",
    "dispatch": "派工推荐",
    "help_routing": "求助路由",
    "input_answer": "代答补充信息",
    "ci_triage": "CI 失败归类",
    "qa": "问答",
    "patrol": "定时巡检",
}


async def propose(
    db: AsyncSession,
    *,
    task: Task | None,
    scenario: str,
    level: str,
    summary: str,
    actions: list[dict[str, Any]],
    engine: str,
    notify_member: Member | None = None,
    extra: dict[str, Any] | None = None,
) -> Suggestion | None:
    """按等级处理一条建议：L0 只建议；L1 执行并通知（可撤销）；L2 执行不通知。"""
    if level == "off":
        return None
    s = Suggestion(
        task_id=task.id if task else None,
        scenario=scenario,
        level=level,
        status="proposed",
        summary=summary,
        payload={"actions": actions, **(extra or {})},
        engine=engine,
        created_at=utcnow(),
    )
    db.add(s)
    await db.flush()
    label = SCENARIO_LABELS.get(scenario, scenario)
    if task is not None:
        await record_event(
            db, task, "suggestion.created", f"协调建议（{label}，{level}）：{summary[:200]}",
            Principal(type="system", name="协调 Agent", roles=["admin"]), data={"suggestion_id": s.id},
        )
    if level in ("L1", "L2") and actions:
        await _execute(db, s, SYSTEM)
    if level != "L2" and task is not None and not task.is_demo:
        notify.notify_member_card(db, notify_member, notify.suggestion_card(s, task), task.id)
    if task is not None:
        publish_after_commit(db, f"task:{task.id}", {"event": "suggestion", "data": (await serialize_suggestions(db, [s]))[0]})
    return s


async def decide_suggestion(db: AsyncSession, actor: Principal, suggestion_id: int, verb: str) -> Suggestion:
    s = await db.get(Suggestion, suggestion_id, with_for_update=True)
    if s is None:
        raise not_found("建议")
    task = await get_task(db, s.task_id) if s.task_id else None
    if actor.type not in ("member", "system"):
        raise forbidden("建议只能由成员处理")
    if task is not None and not (
        actor.is_admin or actor.member_id in (task.creator_id, task.assignee_id, task.suggested_assignee_id)
    ):
        raise forbidden("只有发布者、负责人或管理员可以处理这条建议")
    if verb == "accept":
        if s.status != "proposed":
            raise invalid_state("这条建议已经处理过了")
        if not await _still_applies(db, s):
            raise invalid_state("任务状态已经变了，这条建议已失效，可以忽略")
        await _execute(db, s, actor)
        s.status = "accepted"
    elif verb == "reject":
        if s.status != "proposed":
            raise invalid_state("这条建议已经处理过了")
        s.status = "rejected"
    elif verb == "undo":
        if s.status not in ("executed", "accepted") or not s.undo:
            raise invalid_state("这条建议不能撤销")
        await _undo(db, s, actor)
        s.status = "undone"
    else:
        raise invalid_state("未知操作")
    s.decided_by_id = actor.member_id
    s.decided_at = utcnow()
    if task is not None:
        text = {"accept": "采纳", "reject": "忽略", "undo": "撤销"}[verb]
        await record_event(db, task, f"suggestion.{verb}", f"{actor.name} {text}了协调建议：{s.summary[:120]}", actor, data={"suggestion_id": s.id})
    return s


async def _still_applies(db: AsyncSession, s: Suggestion) -> bool:
    """建议里至少有一个动作在当前任务状态下还能落地。只有提示、没有动作的建议采纳即表示知悉。"""
    actions = (s.payload or {}).get("actions", [])
    if not actions:
        return True
    for act in actions:
        op = act.get("op")
        if op in ("message", "notify_text"):
            return True
        task = await db.get(Task, int(act["task_id"])) if act.get("task_id") else None
        if task is None:
            continue
        if op == "update_fields" and task.state not in S.TERMINAL:
            return True
        if op == "offer" and task.state == S.SUBMITTED:
            return True
        if op == "answer_input" and task.state == S.INPUT_REQUIRED:
            return True
    return False


async def _execute(db: AsyncSession, s: Suggestion, actor: Principal) -> None:
    from ..kernel import tasks as K

    undo: list[dict[str, Any]] = []
    for act in (s.payload or {}).get("actions", []):
        op = act.get("op")
        task = await get_task(db, int(act["task_id"])) if act.get("task_id") else None
        if op == "update_fields" and task is not None and task.state not in S.TERMINAL:
            fields = act.get("fields") or {}
            before = {k: getattr(task, k) for k in ("title", "description", "repos", "skills", "priority") if k in fields}
            undo.append({"op": "update_fields", "task_id": task.id, "fields": {k: (list(v) if isinstance(v, list) else v) for k, v in before.items()}})
            await K.edit(db, SYSTEM, task, fields)
        elif op == "offer" and task is not None and task.state == S.SUBMITTED:
            member = await get_member(db, uuid.UUID(act["member_id"]))
            if member is not None:
                undo.append({"op": "clear_offer", "task_id": task.id, "previous": str(task.suggested_assignee_id) if task.suggested_assignee_id else None})
                await K._offer(db, actor, task, member, act.get("reason") or "协调 Agent 推荐")
        elif op == "answer_input" and task is not None and task.state == S.INPUT_REQUIRED:
            await K.answer_input(db, SYSTEM, task, f"（协调 Agent 代答）{act.get('text', '')}")
        elif op == "message" and task is not None:
            await K.post_message(db, SYSTEM, task, act.get("text", ""), kind="progress")
        elif op == "notify_text":
            chat = act.get("chat_id") or (task.feishu_chat_id if task else None) or await notify.default_chat_id(db)
            if chat:
                notify.notify_text(db, "chat_id", chat, act.get("text", ""), task_id=task.id if task else None)
    s.status = "executed"
    s.undo = {"actions": undo} if undo else None


async def _undo(db: AsyncSession, s: Suggestion, actor: Principal) -> None:
    from ..kernel import tasks as K

    for act in (s.undo or {}).get("actions", []):
        task = await get_task(db, int(act["task_id"]))
        if act["op"] == "update_fields":
            await K.edit(db, SYSTEM, task, act.get("fields") or {})
        elif act["op"] == "clear_offer" and task.state == S.SUBMITTED:
            task.suggested_assignee_id = uuid.UUID(act["previous"]) if act.get("previous") else None
            await record_event(db, task, "task.offer_undone", "已撤销派工推荐", actor)
