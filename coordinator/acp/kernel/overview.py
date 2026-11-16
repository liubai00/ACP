"""项目全貌、数据来源统计。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import and_, func, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import Agent, Event, InboundEvent, Member, MergeRequest, Outbox, Task, utcnow
from . import states as S
from .agents import is_online
from .core import iso_utc, member_ref, serialize_tasks, timeline_item_event
from .dispatch import PRIORITY_RANK


async def overview(db: AsyncSession, days: int = 14, demo: bool | None = None) -> dict[str, Any]:
    days = max(7, min(90, days))
    now = utcnow()
    scope = true() if demo is None else Task.is_demo.is_(demo)
    by_state = dict((await db.execute(select(Task.state, func.count()).where(scope).group_by(Task.state))).all())
    total = sum(by_state.values())
    open_n = sum(v for k, v in by_state.items() if k in S.OPEN)
    week = now - timedelta(days=7)
    created_7d = (await db.execute(select(func.count()).select_from(Task).where(scope, Task.created_at >= week))).scalar_one()
    completed_7d = (
        await db.execute(select(func.count()).select_from(Task).where(scope, Task.state == S.COMPLETED, Task.closed_at >= week))
    ).scalar_one()
    lead = (
        await db.execute(
            select(func.avg(func.extract("epoch", Task.closed_at - Task.created_at))).where(
                scope, Task.state == S.COMPLETED, Task.closed_at >= now - timedelta(days=30)
            )
        )
    ).scalar_one()
    pipes = dict(
        (
            await db.execute(
                select(MergeRequest.pipeline_status, func.count())
                .join(Task, Task.id == MergeRequest.task_id)
                .where(scope, MergeRequest.pipeline_status.in_(["success", "failed"]), MergeRequest.updated_at >= now - timedelta(days=30))
                .group_by(MergeRequest.pipeline_status)
            )
        ).all()
    )
    ci_total = pipes.get("success", 0) + pipes.get("failed", 0)
    agents = (await db.scalars(select(Agent).where(true() if demo is None else Agent.is_demo.is_(demo)))).all()
    members_active = (
        await db.execute(
            select(func.count(func.distinct(Task.assignee_id))).where(scope, Task.updated_at >= now - timedelta(days=30), Task.assignee_id.isnot(None))
        )
    ).scalar_one()

    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    created = dict(
        (
            await db.execute(
                select(func.date_trunc("day", Task.created_at).label("d"), func.count()).where(scope, Task.created_at >= start).group_by("d")
            )
        ).all()
    )
    completed = dict(
        (
            await db.execute(
                select(func.date_trunc("day", Task.closed_at).label("d"), func.count())
                .where(scope, Task.state == S.COMPLETED, Task.closed_at >= start)
                .group_by("d")
            )
        ).all()
    )

    def _key(d: datetime) -> str:
        return d.astimezone(UTC).strftime("%Y-%m-%d")

    created_k = {_key(k): v for k, v in created.items()}
    completed_k = {_key(k): v for k, v in completed.items()}
    trend = []
    for i in range(days):
        d = (start + timedelta(days=i)).strftime("%Y-%m-%d")
        trend.append({"date": d, "created": created_k.get(d, 0), "completed": completed_k.get(d, 0)})

    by_source = [{"source": s, "count": c} for s, c in (await db.execute(select(Task.source, func.count()).where(scope).group_by(Task.source))).all()]

    rows = (
        await db.execute(
            select(
                Task.assignee_id,
                func.count().filter(Task.state.in_(list(S.OPEN))),
                func.count().filter(Task.state == S.WORKING),
                func.count().filter(Task.state == S.COMPLETED),
            )
            .where(scope, Task.assignee_id.isnot(None))
            .group_by(Task.assignee_id)
        )
    ).all()
    mids = [r[0] for r in rows]
    members = {m.id: m for m in (await db.execute(select(Member).where(Member.id.in_(mids)))).scalars()} if mids else {}
    by_assignee = sorted(
        [
            {"member": member_ref(members.get(mid)), "open": o, "working": w, "completed": c}
            for mid, o, w, c in rows
            if members.get(mid)
        ],
        key=lambda x: (-x["open"], -x["completed"]),
    )[:15]

    repo_rows = (
        await db.execute(
            select(func.unnest(Task.repos).label("repo"), Task.state).where(scope)
        )
    ).all()
    repo_agg: dict[str, dict[str, int]] = {}
    for repo, state in repo_rows:
        a = repo_agg.setdefault(repo, {"open": 0, "total": 0})
        a["total"] += 1
        if state in S.OPEN:
            a["open"] += 1
    by_repo = sorted([{"repo": r, **v} for r, v in repo_agg.items()], key=lambda x: (-x["open"], -x["total"]))[:15]

    recent_rows = (
        await db.execute(
            select(Event, Task).join(Task, Task.id == Event.task_id).where(scope).order_by(Event.id.desc()).limit(20)
        )
    ).all()
    recent = [{**timeline_item_event(e), "task_id": t.id, "task_key": t.key, "task_title": t.title} for e, t in recent_rows]

    attention_q = (
        select(Task)
        .where(
            scope,
            Task.state.in_([S.INPUT_REQUIRED, S.AUTH_REQUIRED])
            | and_(Task.state == S.WORKING, Task.last_activity_at < now - timedelta(hours=4))
            | and_(Task.state == S.SUBMITTED, Task.created_at < now - timedelta(hours=24))
        )
        .order_by(PRIORITY_RANK.desc(), Task.state_changed_at)
        .limit(10)
    )
    attention = await serialize_tasks(db, list((await db.execute(attention_q)).scalars()))

    return {
        "counts": {"total": total, "open": open_n, "by_state": {s: int(by_state.get(s, 0)) for s in S.ALL_STATES}},
        "kpis": {
            "created_7d": created_7d,
            "completed_7d": completed_7d,
            "avg_lead_time_hours": round(float(lead) / 3600, 1) if lead else None,
            "ci_pass_rate": round(pipes.get("success", 0) / ci_total, 3) if ci_total else None,
            "agents_online": len([a for a in agents if is_online(a)]),
            "members_active": members_active,
        },
        "trend": trend,
        "by_source": by_source,
        "by_assignee": by_assignee,
        "by_repo": by_repo,
        "recent": recent,
        "attention": attention,
    }


SOURCE_DEFS = [
    ("feishu", "飞书"),
    ("gitlab", "GitLab"),
    ("board", "任务榜"),
    ("agent", "Agent 接入"),
    ("system", "通知出口"),
]


async def sources(db: AsyncSession) -> list[dict[str, Any]]:
    s = get_settings()
    now = utcnow()
    out = []
    for key, label in SOURCE_DEFS:
        if key in ("feishu", "gitlab"):
            q = select(func.max(InboundEvent.created_at), func.count().filter(InboundEvent.created_at >= now - timedelta(hours=24)),
                       func.count().filter(InboundEvent.created_at >= now - timedelta(days=7)),
                       func.count().filter(and_(InboundEvent.status == "error", InboundEvent.created_at >= now - timedelta(hours=24)))).where(InboundEvent.source == key)
            last, d1, d7, err = (await db.execute(q)).one()
            if key == "feishu":
                configured = s.feishu_enabled
                detail = "长连接经 feishu-bridge 接入" if configured else "未配置飞书 App ID / Secret"
            else:
                configured = bool(s.gitlab_webhook_token)
                detail = "Webhook 经 n8n 或直连 /api/hooks/gitlab" if configured else "未配置 GitLab Webhook 密钥"
            status = "unconfigured" if not configured and not last else ("error" if err else ("connected" if last and last > now - timedelta(days=1) else "idle"))
            out.append({"source": key, "label": label, "status": status, "last_event_at": iso_utc(last), "events_24h": d1, "events_7d": d7, "detail": detail})
        elif key == "board":
            q = select(func.max(Task.created_at), func.count().filter(Task.created_at >= now - timedelta(hours=24)),
                       func.count().filter(Task.created_at >= now - timedelta(days=7))).where(Task.source == "board")
            last, d1, d7 = (await db.execute(q)).one()
            out.append({"source": key, "label": label, "status": "connected" if last else "idle", "last_event_at": iso_utc(last), "events_24h": d1, "events_7d": d7, "detail": "任务榜表单建单"})
        elif key == "agent":
            agents = (await db.execute(select(Agent).where(Agent.is_demo.is_(False)))).scalars().all()
            online = [a for a in agents if is_online(a)]
            last = max((a.last_heartbeat_at for a in agents if a.last_heartbeat_at), default=None)
            out.append({"source": key, "label": label, "status": "connected" if online else ("idle" if agents else "unconfigured"), "last_event_at": iso_utc(last),
                        "events_24h": len(online), "events_7d": len(agents), "detail": f"在线 {len(online)} / 已注册 {len(agents)}"})
        else:
            q = select(func.max(Outbox.sent_at), func.count().filter(Outbox.created_at >= now - timedelta(hours=24)),
                       func.count().filter(Outbox.created_at >= now - timedelta(days=7)),
                       func.count().filter(Outbox.status == "failed"), func.count().filter(Outbox.status == "pending"))
            last, d1, d7, failed, pending = (await db.execute(q)).one()
            mode = s.notify_mode
            status = "error" if failed else ("unconfigured" if mode == "log" else ("connected" if last else "idle"))
            out.append({"source": key, "label": label, "status": status, "last_event_at": iso_utc(last), "events_24h": d1, "events_7d": d7,
                        "detail": f"投递模式 {mode}；待发 {pending}，失败 {failed}"})
    return out


async def source_events(db: AsyncSession, source: str | None, page: int, page_size: int) -> dict[str, Any]:
    q = select(InboundEvent)
    if source and source not in ("board", "agent", "system"):
        q = q.where(InboundEvent.source == source)
    items: list[dict[str, Any]] = []
    total = 0
    if source in (None, "", "feishu", "gitlab"):
        total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
        rows = (await db.execute(q.order_by(InboundEvent.id.desc()).offset((page - 1) * page_size).limit(page_size))).scalars().all()
        items = [
            {"id": r.id, "source": r.source, "kind": r.kind, "summary": r.summary + (f"（{r.error}）" if r.error else ""),
             "status": r.status, "task_id": r.task_id, "task_key": f"ACP-{r.task_id}" if r.task_id else None, "at": iso_utc(r.created_at)}
            for r in rows
        ]
    elif source == "system":
        total = (await db.execute(select(func.count()).select_from(Outbox))).scalar_one()
        rows = (await db.execute(select(Outbox).order_by(Outbox.id.desc()).offset((page - 1) * page_size).limit(page_size))).scalars().all()
        items = [
            {"id": r.id, "source": "system", "kind": r.kind, "summary": (r.last_error or "通知投递")[:200],
             "status": {"sent": "processed", "pending": "processed", "failed": "error", "skipped": "ignored"}.get(r.status, r.status),
             "task_id": r.task_id, "task_key": f"ACP-{r.task_id}" if r.task_id else None, "at": iso_utc(r.created_at)}
            for r in rows
        ]
    else:
        etypes = {"board": ["task.created"], "agent": ["agent.acked", "agent.assigned", "mr.reported", "agent.finished"]}[source]
        q2 = select(Event).where(Event.type.in_(etypes))
        if source == "board":
            q2 = q2.join(Task, Task.id == Event.task_id).where(Task.source == "board")
        total = (await db.execute(select(func.count()).select_from(q2.subquery()))).scalar_one()
        rows = (await db.execute(q2.order_by(Event.id.desc()).offset((page - 1) * page_size).limit(page_size))).scalars().all()
        items = [
            {"id": r.id, "source": source, "kind": r.type, "summary": r.text, "status": "processed", "task_id": r.task_id,
             "task_key": f"ACP-{r.task_id}" if r.task_id else None, "at": iso_utc(r.created_at)}
            for r in rows
        ]
    return {"items": items, "total": total, "page": page, "page_size": page_size}
