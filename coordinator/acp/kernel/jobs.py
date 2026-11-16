"""后台定时任务：Agent 离线判定、30 分钟无心跳回收、定时巡检。"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from sqlalchemy import select

from ..config import get_settings
from ..db import session_scope
from ..models import Agent, Task, utcnow
from ..security import SYSTEM
from . import states as S
from .agents import is_subscribed
from .core import commit, record_event
from .tasks import release

log = logging.getLogger("acp.jobs")


async def heartbeat_sweep() -> dict[str, int]:
    s = get_settings()
    now = utcnow()
    offline = reclaimed = 0
    async with session_scope() as db:
        agents = (await db.execute(select(Agent).where(Agent.status != "offline", Agent.is_demo.is_(False)))).scalars().all()
        for a in agents:
            stale = a.last_heartbeat_at is None or a.last_heartbeat_at < now - timedelta(seconds=s.agent_offline_seconds)
            if stale and not is_subscribed(a.id):
                a.status = "offline"
                offline += 1
        cutoff = now - timedelta(minutes=s.heartbeat_timeout_minutes)
        rows = (
            await db.execute(
                select(Task, Agent)
                .join(Agent, Agent.id == Task.assignee_agent_id)
                .where(
                    Task.state == S.WORKING,
                    Task.is_demo.is_(False),
                    Task.agent_run_done.is_(False),
                    Agent.last_heartbeat_at < cutoff,
                )
            )
        ).all()
        for task, agent in rows:
            if is_subscribed(agent.id):
                continue
            await record_event(db, task, "task.reclaimed", f"Agent「{agent.name}」{s.heartbeat_timeout_minutes} 分钟无心跳，任务回收", SYSTEM)
            await release(db, SYSTEM, task, f"{s.heartbeat_timeout_minutes} 分钟无心跳，已回收")
            reclaimed += 1
        await commit(db)
    return {"offline": offline, "reclaimed": reclaimed}


async def scheduler(stop: asyncio.Event) -> None:
    from ..agent.scenarios import run_patrol

    tick = 0
    while not stop.is_set():
        try:
            await heartbeat_sweep()
            if tick % 30 == 5:
                await run_patrol()
        except Exception as exc:  # noqa: BLE001
            log.exception("定时任务出错：%s", exc)
        tick += 1
        try:
            await asyncio.wait_for(stop.wait(), timeout=60)
        except TimeoutError:
            pass
