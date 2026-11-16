"""规则派工：按仓库归属、技能、在线状态、当前负载给任务推荐负责人。只给建议，成员本人点接受才执行。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Agent, Member, Task
from . import states as S
from .agents import is_online

PRIORITY_RANK = case(
    (Task.priority == "urgent", 4), (Task.priority == "high", 3), (Task.priority == "normal", 2), else_=1
)


@dataclass
class Candidate:
    member: Member
    score: float
    reason: str
    agent: Agent | None


def _norm(s: str) -> str:
    return s.strip().lower().rstrip("/").removesuffix(".git")


def _repo_match(task_repo: str, agent_repo: str) -> bool:
    a, b = _norm(task_repo), _norm(agent_repo)
    return a == b or a.endswith("/" + b) or b.endswith("/" + a) or a.split("/")[-1] == b.split("/")[-1]


async def rank_candidates(
    db: AsyncSession,
    task: Task,
    *,
    exclude: set[uuid.UUID] | None = None,
    skill: str | None = None,
) -> list[Candidate]:
    exclude = exclude or set()
    members = (
        await db.execute(select(Member).where(Member.is_active.is_(True), Member.is_demo.is_(task.is_demo)))
    ).scalars().all()
    agents = (await db.execute(select(Agent))).scalars().all()
    by_member: dict[uuid.UUID, list[Agent]] = {}
    for a in agents:
        by_member.setdefault(a.member_id, []).append(a)
    loads = dict(
        (
            await db.execute(
                select(Task.assignee_id, func.count())
                .where(Task.state.in_([S.WORKING, S.INPUT_REQUIRED, S.AUTH_REQUIRED]), Task.assignee_id.isnot(None))
                .group_by(Task.assignee_id)
            )
        ).all()
    )
    wanted_skills = {s.lower() for s in (task.skills or [])}
    if skill:
        wanted_skills.add(skill.lower())
    out: list[Candidate] = []
    for m in members:
        if m.id in exclude:
            continue
        mine = by_member.get(m.id, [])
        if not mine and "developer" not in (m.roles or []):
            continue
        score = 0.0
        reasons: list[str] = []
        repo_hits = {r for r in (task.repos or []) for a in mine for ar in (a.repos or []) if _repo_match(r, ar)}
        if repo_hits:
            score += 3 * len(repo_hits)
            reasons.append(f"熟悉仓库 {'、'.join(sorted(repo_hits))}")
        skill_hits = {s for a in mine for s in (a.skills or []) if s.lower() in wanted_skills}
        if skill_hits:
            score += 2 * len(skill_hits)
            reasons.append(f"技能匹配 {'、'.join(sorted(skill_hits))}")
        online = [a for a in mine if is_online(a)]
        if online:
            score += 1.5
            reasons.append("Agent 在线")
        load = int(loads.get(m.id, 0))
        score -= 0.8 * load
        if load:
            reasons.append(f"手上 {load} 个任务")
        if score <= 0 and not online:
            continue
        out.append(Candidate(member=m, score=score, reason="，".join(reasons) or "可用", agent=online[0] if online else None))
    out.sort(key=lambda c: c.score, reverse=True)
    return out


async def suggest(db: AsyncSession, task: Task, **kw) -> Candidate | None:
    ranked = await rank_candidates(db, task, **kw)
    return ranked[0] if ranked else None
