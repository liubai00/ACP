"""内核公共部分：事务提交、事件记录、消息、序列化。"""

from __future__ import annotations

import inspect
import uuid
from collections.abc import Awaitable, Callable, Iterable
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..broker import broker, outbox_wakeup
from ..models import (
    Agent,
    Approval,
    Event,
    Member,
    MergeRequest,
    Message,
    Setting,
    Suggestion,
    Task,
    utcnow,
)
from ..security import Principal
from .errors import not_found

AfterCommit = Callable[[], Awaitable[None] | None]


# ---------------------------------------------------------------- 事务

def after_commit(db: AsyncSession, fn: AfterCommit) -> None:
    db.info.setdefault("after_commit", []).append(fn)


async def commit(db: AsyncSession) -> None:
    await db.commit()
    hooks: list[AfterCommit] = db.info.pop("after_commit", [])
    for fn in hooks:
        res = fn()
        if inspect.isawaitable(res):
            await res


def publish_after_commit(db: AsyncSession, channel: str, message: Any) -> None:
    after_commit(db, lambda: broker.publish(channel, message) and None)


def wake_outbox(db: AsyncSession) -> None:
    after_commit(db, lambda: outbox_wakeup.set())


# ---------------------------------------------------------------- 工具

def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone().isoformat() if dt.tzinfo else dt.isoformat() + "Z"


def iso_utc(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.isoformat().replace("+00:00", "Z")


def member_ref(m: Member | None) -> dict[str, Any] | None:
    if m is None:
        return None
    return {"id": str(m.id), "name": m.name, "avatar_url": m.avatar_url}


async def get_task(db: AsyncSession, task_id: int, *, lock: bool = False) -> Task:
    stmt = select(Task).where(Task.id == task_id)
    if lock:
        stmt = stmt.with_for_update()
    task = (await db.execute(stmt)).scalar_one_or_none()
    if task is None:
        raise not_found("任务")
    return task


async def get_member(db: AsyncSession, member_id: uuid.UUID | None) -> Member | None:
    if member_id is None:
        return None
    return await db.get(Member, member_id)


async def get_setting(db: AsyncSession, key: str, default: Any = None) -> Any:
    row = await db.get(Setting, key)
    return default if row is None else row.value


async def set_setting(db: AsyncSession, key: str, value: Any) -> None:
    row = await db.get(Setting, key)
    if row is None:
        db.add(Setting(key=key, value=value, updated_at=utcnow()))
    else:
        row.value = value
        row.updated_at = utcnow()


# ---------------------------------------------------------------- 事件与消息

def actor_of(p: Principal) -> tuple[str, str | None, str]:
    return p.actor_type, p.actor_id, p.name or {"system": "系统", "connector": "n8n"}.get(p.actor_type, "未知")


async def record_event(
    db: AsyncSession,
    task: Task | None,
    etype: str,
    text: str,
    actor: Principal | None = None,
    data: dict[str, Any] | None = None,
) -> Event:
    a_type, a_id, a_name = actor_of(actor) if actor else ("system", None, "系统")
    ev = Event(
        task_id=task.id if task else None,
        type=etype,
        actor_type=a_type,
        actor_id=a_id,
        actor_name=a_name,
        text=text,
        data=data,
        created_at=utcnow(),
    )
    db.add(ev)
    await db.flush()
    if task is not None:
        task.updated_at = ev.created_at
        task.last_activity_at = ev.created_at
        item = timeline_item_event(ev)
        publish_after_commit(db, f"task:{task.id}", {"event": "timeline", "data": item})
        publish_after_commit(db, "activity", {**item, "task_id": task.id, "task_key": task.key, "task_title": task.title})
    return ev


async def add_message(
    db: AsyncSession,
    task: Task,
    content: str,
    actor: Principal,
    kind: str = "message",
    data: dict[str, Any] | None = None,
) -> Message:
    a_type, a_id, a_name = actor_of(actor)
    msg = Message(
        task_id=task.id,
        sender_type="agent" if a_type == "agent" else ("member" if a_type == "member" else "system"),
        sender_id=a_id,
        sender_name=a_name,
        kind=kind,
        content=content,
        data=data,
        created_at=utcnow(),
    )
    db.add(msg)
    await db.flush()
    task.updated_at = msg.created_at
    task.last_activity_at = msg.created_at
    publish_after_commit(db, f"task:{task.id}", {"event": "timeline", "data": timeline_item_message(msg)})
    return msg


def timeline_item_event(ev: Event) -> dict[str, Any]:
    return {
        "id": f"e{ev.id}",
        "kind": "event",
        "type": ev.type,
        "at": iso_utc(ev.created_at),
        "actor": {"type": ev.actor_type, "id": ev.actor_id, "name": ev.actor_name},
        "text": ev.text,
        "data": ev.data,
    }


def timeline_item_message(m: Message) -> dict[str, Any]:
    data = dict(m.data or {})
    data.setdefault("kind", m.kind)
    return {
        "id": f"m{m.id}",
        "kind": "message",
        "type": "message",
        "at": iso_utc(m.created_at),
        "actor": {"type": m.sender_type, "id": m.sender_id, "name": m.sender_name},
        "text": m.content,
        "data": data,
    }


# ---------------------------------------------------------------- 序列化

def _ci_status(statuses: Iterable[str]) -> str:
    s = [x for x in statuses if x and x != "none"]
    if not s:
        return "none"
    if "failed" in s:
        return "failed"
    if "running" in s:
        return "running"
    if "pending" in s:
        return "pending"
    if all(x == "success" for x in s):
        return "success"
    return "running"


async def serialize_tasks(db: AsyncSession, tasks: list[Task]) -> list[dict[str, Any]]:
    if not tasks:
        return []
    ids = [t.id for t in tasks]
    member_ids = {x for t in tasks for x in (t.creator_id, t.assignee_id, t.suggested_assignee_id) if x}
    agent_ids = {t.assignee_agent_id for t in tasks if t.assignee_agent_id}
    members: dict[uuid.UUID, Member] = {}
    if member_ids:
        for m in (await db.execute(select(Member).where(Member.id.in_(member_ids)))).scalars():
            members[m.id] = m
    agents: dict[uuid.UUID, Agent] = {}
    if agent_ids:
        for a in (await db.execute(select(Agent).where(Agent.id.in_(agent_ids)))).scalars():
            agents[a.id] = a
    children: dict[int, int] = {}
    rows = await db.execute(select(Task.parent_id, func.count()).where(Task.parent_id.in_(ids)).group_by(Task.parent_id))
    for pid, cnt in rows:
        children[pid] = cnt
    mrs: dict[int, list[MergeRequest]] = {}
    for mr in (await db.execute(select(MergeRequest).where(MergeRequest.task_id.in_(ids)))).scalars():
        mrs.setdefault(mr.task_id, []).append(mr)

    out = []
    for t in tasks:
        tm = mrs.get(t.id, [])
        ag = agents.get(t.assignee_agent_id) if t.assignee_agent_id else None
        out.append(
            {
                "id": t.id,
                "key": t.key,
                "title": t.title,
                "state": t.state,
                "type": t.type,
                "priority": t.priority,
                "source": t.source,
                "repos": list(t.repos or []),
                "skills": list(t.skills or []),
                "labels": list(t.labels or []),
                "creator": member_ref(members.get(t.creator_id)) if t.creator_id else None,
                "assignee": member_ref(members.get(t.assignee_id)) if t.assignee_id else None,
                "assignee_agent": {"id": str(ag.id), "name": ag.name, "kind": ag.kind} if ag else None,
                "suggested_assignee": member_ref(members.get(t.suggested_assignee_id)) if t.suggested_assignee_id else None,
                "parent_id": t.parent_id,
                "root_id": t.root_id or t.id,
                "depth": t.depth,
                "children_count": children.get(t.id, 0),
                "mr_count": len([m for m in tm if m.iid or m.url]),
                "mr_merged": len([m for m in tm if m.state == "merged"]),
                "ci_status": _ci_status(m.pipeline_status for m in tm),
                "created_at": iso_utc(t.created_at),
                "updated_at": iso_utc(t.updated_at),
                "state_changed_at": iso_utc(t.state_changed_at),
                "closed_at": iso_utc(t.closed_at),
                "is_demo": t.is_demo,
            }
        )
    return out


async def serialize_task(db: AsyncSession, task: Task) -> dict[str, Any]:
    return (await serialize_tasks(db, [task]))[0]


def serialize_mr(mr: MergeRequest) -> dict[str, Any]:
    return {
        "id": mr.id,
        "repo": mr.repo,
        "branch": mr.branch,
        "iid": mr.iid,
        "url": mr.url,
        "state": mr.state,
        "pipeline_status": mr.pipeline_status,
        "updated_at": iso_utc(mr.updated_at),
    }


async def serialize_approvals(db: AsyncSession, approvals: list[Approval]) -> list[dict[str, Any]]:
    ids = {x for a in approvals for x in (a.requested_by_id, a.decided_by_id) if x}
    members = {}
    if ids:
        members = {m.id: m for m in (await db.execute(select(Member).where(Member.id.in_(ids)))).scalars()}
    return [
        {
            "id": a.id,
            "gate": a.gate,
            "status": a.status,
            "note": a.note,
            "requested_by": member_ref(members.get(a.requested_by_id)) if a.requested_by_id else None,
            "decided_by": member_ref(members.get(a.decided_by_id)) if a.decided_by_id else None,
            "comment": a.comment,
            "created_at": iso_utc(a.created_at),
            "decided_at": iso_utc(a.decided_at),
        }
        for a in approvals
    ]


async def serialize_suggestions(db: AsyncSession, items: list[Suggestion]) -> list[dict[str, Any]]:
    ids = {s.decided_by_id for s in items if s.decided_by_id}
    members = {}
    if ids:
        members = {m.id: m for m in (await db.execute(select(Member).where(Member.id.in_(ids)))).scalars()}
    return [
        {
            "id": s.id,
            "task_id": s.task_id,
            "scenario": s.scenario,
            "level": s.level,
            "status": s.status,
            "summary": s.summary,
            "payload": s.payload,
            "engine": s.engine,
            "created_at": iso_utc(s.created_at),
            "decided_by": member_ref(members.get(s.decided_by_id)) if s.decided_by_id else None,
        }
        for s in items
    ]


async def task_timeline(db: AsyncSession, task_id: int, limit: int = 500) -> list[dict[str, Any]]:
    evs = (
        await db.execute(select(Event).where(Event.task_id == task_id).order_by(Event.id.desc()).limit(limit))
    ).scalars().all()
    msgs = (
        await db.execute(select(Message).where(Message.task_id == task_id).order_by(Message.id.desc()).limit(limit))
    ).scalars().all()
    items = [timeline_item_event(e) for e in evs] + [timeline_item_message(m) for m in msgs]
    items.sort(key=lambda x: (x["at"] or "", x["id"]))
    return items[-limit:]


def serialize_member(m: Member, stats: dict[str, int] | None = None) -> dict[str, Any]:
    return {
        "id": str(m.id),
        "name": m.name,
        "avatar_url": m.avatar_url,
        "roles": list(m.roles or []),
        "team": m.team,
        "gitlab_username": m.gitlab_username,
        "feishu_open_id": m.feishu_open_id,
        "is_active": m.is_active,
        "created_at": iso_utc(m.created_at),
        "last_login_at": iso_utc(m.last_login_at),
        "stats": stats or {"open": 0, "working": 0, "completed_30d": 0},
    }
