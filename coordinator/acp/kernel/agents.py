"""Agent 注册、心跳、派工投递。派工通过订阅流推给开发者电脑上的接入程序。"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..broker import broker
from ..config import get_settings
from ..models import Agent, Member, Task, utcnow
from ..security import Principal
from . import states as S
from .core import iso_utc, member_ref, publish_after_commit, record_event, serialize_task
from .errors import forbidden, not_found, validation


def is_online(a: Agent) -> bool:
    if a.is_demo:
        return a.status != "offline"
    if a.status == "offline" or a.last_heartbeat_at is None:
        return False
    return a.last_heartbeat_at >= utcnow() - timedelta(seconds=get_settings().agent_offline_seconds)


async def agent_load(db: AsyncSession, agent_id: uuid.UUID) -> int:
    return (
        await db.execute(
            select(func.count())
            .select_from(Task)
            .where(Task.assignee_agent_id == agent_id, Task.state == S.WORKING, Task.agent_run_done.is_(False))
        )
    ).scalar_one()


async def serialize_agents(db: AsyncSession, agents: list[Agent]) -> list[dict[str, Any]]:
    if not agents:
        return []
    mids = {a.member_id for a in agents}
    members = {m.id: m for m in (await db.execute(select(Member).where(Member.id.in_(mids)))).scalars()}
    current: dict[uuid.UUID, list[int]] = {}
    rows = await db.execute(
        select(Task.assignee_agent_id, Task.id).where(
            Task.assignee_agent_id.in_([a.id for a in agents]), Task.state == S.WORKING, Task.agent_run_done.is_(False)
        )
    )
    for aid, tid in rows:
        current.setdefault(aid, []).append(tid)
    out = []
    for a in agents:
        online = is_online(a)
        cur = current.get(a.id, [])
        status = "offline" if not online else ("busy" if len(cur) >= max(1, a.max_concurrency) else "online")
        out.append(
            {
                "id": str(a.id),
                "member": member_ref(members.get(a.member_id)),
                "name": a.name,
                "kind": a.kind,
                "version": a.version,
                "host": a.host,
                "skills": list(a.skills or []),
                "repos": list(a.repos or []),
                "max_concurrency": a.max_concurrency,
                "auto_accept_help": a.auto_accept_help,
                "status": status,
                "last_heartbeat_at": iso_utc(a.last_heartbeat_at),
                "current_task_ids": cur,
                "created_at": iso_utc(a.created_at),
            }
        )
    return out


async def register_agent(db: AsyncSession, actor: Principal, body: dict[str, Any]) -> Agent:
    if actor.type != "member" or actor.member_id is None:
        raise forbidden("只有成员令牌可以注册 Agent")
    name = (body.get("name") or "").strip()
    if not name:
        raise validation("name 不能为空")
    agent = (
        await db.execute(select(Agent).where(Agent.member_id == actor.member_id, Agent.name == name))
    ).scalar_one_or_none()
    if agent is None:
        agent = Agent(member_id=actor.member_id, name=name, created_at=utcnow())
        db.add(agent)
    agent.kind = (body.get("kind") or "other")[:40]
    agent.version = (body.get("version") or None) and str(body["version"])[:40]
    agent.host = (body.get("host") or None) and str(body["host"])[:200]
    agent.skills = [str(s)[:80] for s in (body.get("skills") or [])][:50]
    agent.repos = [str(s)[:200] for s in (body.get("repos") or [])][:100]
    agent.max_concurrency = max(1, min(3, int(body.get("max_concurrency") or 1)))
    agent.auto_accept_help = bool(body.get("auto_accept_help"))
    agent.card = {k: body.get(k) for k in ("name", "kind", "version", "host", "skills", "repos")}
    agent.status = "online"
    agent.last_heartbeat_at = utcnow()
    await db.flush()
    return agent


async def get_own_agent(db: AsyncSession, actor: Principal, agent_id: uuid.UUID) -> Agent:
    agent = await db.get(Agent, agent_id)
    if agent is None:
        raise not_found("Agent")
    if agent.member_id != actor.member_id and not actor.is_admin:
        raise forbidden("不是你的 Agent")
    return agent


async def heartbeat(db: AsyncSession, actor: Principal, agent_id: uuid.UUID, status: str | None = None) -> Agent:
    agent = await get_own_agent(db, actor, agent_id)
    agent.last_heartbeat_at = utcnow()
    agent.status = "busy" if status == "busy" else "online"
    return agent


async def pick_agent(db: AsyncSession, member_id: uuid.UUID, prefer: uuid.UUID | None = None) -> Agent | None:
    agents = (await db.execute(select(Agent).where(Agent.member_id == member_id))).scalars().all()
    candidates = []
    for a in agents:
        if not is_online(a):
            continue
        load = await agent_load(db, a.id)
        if load >= max(1, a.max_concurrency):
            continue
        candidates.append((0 if a.id == prefer else 1, load, a.created_at, a))
    if not candidates:
        return None
    candidates.sort(key=lambda x: (x[0], x[1], x[2]))
    return candidates[0][3]


async def deliver_assignment(db: AsyncSession, task: Task, reason: str | None = None) -> Agent | None:
    """负责人已定、任务进行中：挑一个负责人在线且有空的 Agent，推送派工。没有在线 Agent 就等它上线。"""
    if task.state != S.WORKING or task.assignee_id is None:
        return None
    agent = None
    if task.assignee_agent_id:
        current = await db.get(Agent, task.assignee_agent_id)
        if current is not None and current.member_id == task.assignee_id and is_online(current):
            agent = current
    if agent is None:
        agent = await pick_agent(db, task.assignee_id)
        if agent is None:
            task.assignee_agent_id = None
            return None
        task.assignee_agent_id = agent.id
        await record_event(
            db, task, "agent.assigned", f"派给 Agent「{agent.name}」执行", data={"agent_id": str(agent.id)}
        )
    task.agent_acked = False
    task.agent_run_done = False
    if reason:
        task.run_reason = reason
    summary = await serialize_task(db, task)
    publish_after_commit(
        db,
        f"agent:{agent.id}",
        {"type": "assignment", "task": summary, "reason": task.run_reason or "new"},
    )
    return agent


async def pending_for_agent(db: AsyncSession, agent: Agent) -> list[Task]:
    """订阅建立时：重发未确认的派工；把负责人名下尚未分配 Agent 的进行中任务派给它。"""
    out: list[Task] = []
    unacked = (
        await db.execute(
            select(Task)
            .where(Task.assignee_agent_id == agent.id, Task.state == S.WORKING, Task.agent_acked.is_(False))
            .order_by(Task.id)
        )
    ).scalars().all()
    out.extend(unacked)
    capacity = max(1, agent.max_concurrency) - await agent_load(db, agent.id)
    if capacity > 0:
        waiting = (
            await db.execute(
                select(Task)
                .where(Task.assignee_id == agent.member_id, Task.state == S.WORKING, Task.assignee_agent_id.is_(None))
                .order_by(_priority_rank().desc(), Task.id)
                .limit(capacity)
            )
        ).scalars().all()
        for t in waiting:
            t.assignee_agent_id = agent.id
            t.agent_acked = False
            t.agent_run_done = False
            t.run_reason = t.run_reason or "new"
            await record_event(db, t, "agent.assigned", f"派给 Agent「{agent.name}」执行", data={"agent_id": str(agent.id)})
            out.append(t)
    return out


def _priority_rank():
    from .dispatch import PRIORITY_RANK

    return PRIORITY_RANK


def agent_channel(agent_id: uuid.UUID) -> str:
    return f"agent:{agent_id}"


def is_subscribed(agent_id: uuid.UUID) -> bool:
    return broker.subscribers(agent_channel(agent_id)) > 0
