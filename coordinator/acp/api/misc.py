"""其余 REST：我、全貌、成员、Agent、数据来源、设置、自动化流程、连接器入口、健康检查。"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import timedelta
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import StreamingResponse

from .. import MIN_LINK_VERSION, __version__
from ..config import get_settings
from ..db import get_session
from ..kernel import agents as KA
from ..kernel import feishu as KF
from ..kernel import gitlab as KG
from ..kernel import states as S
from ..kernel import tasks as K
from ..kernel.core import commit, get_setting, get_task, iso_utc, serialize_member, set_setting
from ..kernel.errors import ApiError, forbidden, validation
from ..kernel.overview import overview, source_events, sources
from ..models import Agent, ApiToken, Member, Task, utcnow
from ..security import Principal, agent_token, constant_eq, issue_token, jwks
from .deps import current, current_admin, current_connector, current_human

router = APIRouter()


# ---------------------------------------------------------------- 公共

@router.get("/healthz")
async def healthz(db: AsyncSession = Depends(get_session)) -> dict:
    db_ok = "ok"
    try:
        await db.execute(text("select 1"))
    except Exception:  # noqa: BLE001
        db_ok = "error"
    return {"status": "ok" if db_ok == "ok" else "degraded", "version": __version__, "db": db_ok}


@router.get("/.well-known/jwks.json")
async def well_known_jwks() -> dict:
    return jwks()


@router.get("/api/ping/stream")
async def ping_stream(request: Request) -> StreamingResponse:
    async def gen():
        yield "event: ping\ndata: {\"n\":0}\n\n"
        for i in range(1, 4):
            for _ in range(30):
                if await request.is_disconnected():
                    return
                await asyncio.sleep(1)
            yield f"event: ping\ndata: {{\"n\":{i}}}\n\n"
            if i * 30 >= 95:
                return
        await asyncio.sleep(5)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- 我与全貌

@router.get("/api/me")
async def me(p: Principal = Depends(current), db: AsyncSession = Depends(get_session)) -> dict:
    if p.member_id is None:
        return {"member": None, "principal": {"type": p.type, "name": p.name, "roles": p.roles}}
    m = await db.get(Member, p.member_id)
    return {"member": serialize_member(m) if m else None, "principal": {"type": p.type, "name": p.name, "roles": p.roles}}


@router.get("/api/overview")
async def get_overview(days: int = 14, demo: bool | None = None, p: Principal = Depends(current), db: AsyncSession = Depends(get_session)) -> dict:
    return await overview(db, days, demo)


# ---------------------------------------------------------------- 个人访问令牌（手动配置个人 Agent 的 MCP 用）

@router.get("/api/me/tokens")
async def my_tokens(p: Principal = Depends(current_human), db: AsyncSession = Depends(get_session)) -> dict:
    rows = (
        await db.execute(select(ApiToken).where(ApiToken.member_id == p.member_id).order_by(ApiToken.created_at.desc()))
    ).scalars().all()
    return {
        "items": [
            {"id": r.jti, "name": r.name, "created_at": iso_utc(r.created_at), "expires_at": iso_utc(r.expires_at),
             "revoked_at": iso_utc(r.revoked_at)}
            for r in rows
        ]
    }


@router.post("/api/me/tokens")
async def create_my_token(body: dict, p: Principal = Depends(current_human), db: AsyncSession = Depends(get_session)) -> dict:
    name = str(body.get("name") or "personal").strip()[:100]
    days = max(1, min(90, int(body.get("days") or 90)))
    m = await db.get(Member, p.member_id)
    token, exp = issue_token(sub=str(p.member_id), name=m.name if m else p.name, roles=list(m.roles if m else p.roles),
                             act="member", ttl=timedelta(days=days), extra={"pat": True})
    import jwt as _jwt

    jti = _jwt.decode(token, options={"verify_signature": False})["jti"]
    db.add(ApiToken(jti=jti, name=name, roles=list(m.roles if m else []), member_id=p.member_id, created_at=utcnow(), expires_at=exp))
    await commit(db)
    s = get_settings()
    return {"id": jti, "token": token, "expires_at": exp.isoformat(), "mcp_url": f"{s.issuer}/mcp"}


@router.delete("/api/me/tokens/{token_id}")
async def revoke_my_token(token_id: str, p: Principal = Depends(current_human), db: AsyncSession = Depends(get_session)) -> dict:
    row = await db.get(ApiToken, token_id)
    if row is None or (row.member_id != p.member_id and not p.is_admin):
        raise ApiError("not_found", "令牌不存在", 404)
    row.revoked_at = utcnow()
    await commit(db)
    return {"ok": True}


# ---------------------------------------------------------------- 成员

async def _member_stats(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, dict[str, int]]:
    if not ids:
        return {}
    since = utcnow() - timedelta(days=30)
    rows = (
        await db.execute(
            select(
                Task.assignee_id,
                func.count().filter(Task.state.in_(list(S.OPEN))),
                func.count().filter(Task.state == S.WORKING),
                func.count().filter((Task.state == S.COMPLETED) & (Task.closed_at >= since)),
            )
            .where(Task.assignee_id.in_(ids))
            .group_by(Task.assignee_id)
        )
    ).all()
    return {mid: {"open": o, "working": w, "completed_30d": c} for mid, o, w, c in rows}


@router.get("/api/members")
async def members(
    q: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    p: Principal = Depends(current),
    db: AsyncSession = Depends(get_session),
) -> dict:
    stmt = select(Member)
    if q:
        stmt = stmt.where(or_(Member.name.ilike(f"%{q}%"), Member.team.ilike(f"%{q}%"), Member.gitlab_username.ilike(f"%{q}%")))
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = list((await db.execute(stmt.order_by(Member.is_active.desc(), Member.name).offset((page - 1) * page_size).limit(page_size))).scalars())
    stats = await _member_stats(db, [m.id for m in rows])
    return {"items": [serialize_member(m, stats.get(m.id)) for m in rows], "total": total, "page": page, "page_size": page_size}


@router.patch("/api/members/{member_id}")
async def patch_member(member_id: uuid.UUID, body: dict, p: Principal = Depends(current_admin), db: AsyncSession = Depends(get_session)) -> dict:
    m = await db.get(Member, member_id)
    if m is None:
        raise ApiError("not_found", "成员不存在", 404)
    allowed = {"member", "developer", "reviewer", "admin", "agent_caller"}
    if "roles" in body and body["roles"] is not None:
        roles = sorted({r for r in body["roles"] if r in allowed} | {"member"})
        if m.id == p.member_id and "admin" not in roles:
            raise forbidden("不能移除自己的管理员角色")
        m.roles = roles
    for key in ("team", "gitlab_username"):
        if key in body:
            setattr(m, key, (body[key] or None))
    if "is_active" in body and m.id != p.member_id:
        m.is_active = bool(body["is_active"])
    if "name" in body and body["name"]:
        m.name = str(body["name"])[:100]
    await commit(db)
    stats = await _member_stats(db, [m.id])
    return serialize_member(m, stats.get(m.id))


# ---------------------------------------------------------------- Agent（接入程序用）

@router.get("/api/agents")
async def agents(p: Principal = Depends(current), db: AsyncSession = Depends(get_session)) -> dict:
    rows = list((await db.execute(select(Agent).order_by(Agent.created_at))).scalars())
    return {"items": await KA.serialize_agents(db, rows)}


@router.post("/api/agents/register")
async def register(body: dict, p: Principal = Depends(current_human), db: AsyncSession = Depends(get_session)) -> dict:
    agent = await KA.register_agent(db, p, body)
    await commit(db)
    return (await KA.serialize_agents(db, [agent]))[0]


@router.post("/api/agents/{agent_id}/heartbeat")
async def heartbeat(agent_id: uuid.UUID, body: dict | None = None, p: Principal = Depends(current_human), db: AsyncSession = Depends(get_session)) -> dict:
    await KA.heartbeat(db, p, agent_id, (body or {}).get("status"))
    await commit(db)
    return {"ok": True, "min_link_version": MIN_LINK_VERSION, "server_version": __version__}


@router.post("/api/tasks/{task_id}/agent-token")
async def task_agent_token(task_id: int, body: dict, p: Principal = Depends(current_human), db: AsyncSession = Depends(get_session)) -> dict:
    task = await get_task(db, task_id)
    try:
        agent_id = uuid.UUID(str(body.get("agent_id")))
    except ValueError as exc:
        raise validation("agent_id 格式不正确") from exc
    agent = await KA.get_own_agent(db, p, agent_id)
    if task.assignee_id != p.member_id or task.assignee_agent_id not in (None, agent.id):
        raise forbidden("只能为自己负责、并派给这个 Agent 的任务申请令牌")
    if task.state in S.TERMINAL:
        raise ApiError("invalid_state", "任务已结束", 409)
    m = await db.get(Member, p.member_id)
    token, exp = agent_token(p.member_id, f"{m.name} 的 Agent" if m else p.name, list(m.roles if m else p.roles), task.id, agent.id)
    s = get_settings()
    return {"token": token, "expires_at": exp.isoformat(), "mcp_url": f"{s.issuer}/mcp"}


# ---------------------------------------------------------------- 数据来源

@router.get("/api/sources")
async def get_sources(p: Principal = Depends(current), db: AsyncSession = Depends(get_session)) -> dict:
    return {"items": await sources(db)}


@router.get("/api/sources/events")
async def get_source_events(
    source: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    p: Principal = Depends(current),
    db: AsyncSession = Depends(get_session),
) -> dict:
    return await source_events(db, source, page, page_size)


# ---------------------------------------------------------------- 设置

async def _settings_view(db: AsyncSession) -> dict[str, Any]:
    s = get_settings()
    from ..agent import llm

    return {
        "autonomy": await K.autonomy(db),
        "intake_modes": await get_setting(db, "intake_modes", s.intake_modes),
        "feishu_chat_ids": await get_setting(db, "feishu_chat_ids", s.chat_ids),
        "notify_mode": await get_setting(db, "notify_mode", s.notify_mode),
        "llm_enabled": llm.enabled(),
        "llm_model": s.llm_model or None,
        "feishu_enabled": s.feishu_enabled,
        "version": __version__,
        "public_url": s.issuer,
        "n8n_url": s.n8n_public_url or None,
    }


@router.get("/api/settings")
async def get_settings_api(p: Principal = Depends(current), db: AsyncSession = Depends(get_session)) -> dict:
    return await _settings_view(db)


@router.put("/api/settings")
async def put_settings(body: dict, p: Principal = Depends(current_admin), db: AsyncSession = Depends(get_session)) -> dict:
    if "autonomy" in body and isinstance(body["autonomy"], dict):
        cur = await get_setting(db, "autonomy", {}) or {}
        for k, v in body["autonomy"].items():
            if k in K.SCENARIOS and v in ("off", "L0", "L1", "L2"):
                cur[k] = v
        await set_setting(db, "autonomy", cur)
    if "intake_modes" in body and isinstance(body["intake_modes"], list):
        await set_setting(db, "intake_modes", [m for m in body["intake_modes"] if m in ("at_mention", "shortcut", "all")])
    if "feishu_chat_ids" in body and isinstance(body["feishu_chat_ids"], list):
        await set_setting(db, "feishu_chat_ids", [str(c).strip() for c in body["feishu_chat_ids"] if str(c).strip()])
    if body.get("notify_mode") in ("log", "n8n", "direct"):
        await set_setting(db, "notify_mode", body["notify_mode"])
    from ..kernel.core import record_event

    await record_event(db, None, "settings.changed", f"{p.name} 修改了平台设置", p, data={k: body[k] for k in body if k != "secret"})
    await commit(db)
    return await _settings_view(db)


# ---------------------------------------------------------------- 自动化流程（n8n）

@router.get("/api/workflows")
async def workflows(p: Principal = Depends(current)) -> dict:
    s = get_settings()
    base = {"enabled": False, "n8n_url": s.n8n_public_url or None, "workflows": [], "executions": []}
    if not s.n8n_api_key:
        return {**base, "reason": "no_key", "message": "未配置 n8n API Key（ACP_N8N_API_KEY），只显示入口链接"}
    headers = {"X-N8N-API-KEY": s.n8n_api_key, "accept": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r_wf = await client.get(f"{s.n8n_internal_url}/api/v1/workflows", headers=headers, params={"limit": 100})
            r_ex = await client.get(f"{s.n8n_internal_url}/api/v1/executions", headers=headers, params={"limit": 100})
    except Exception as exc:  # noqa: BLE001
        return {**base, "reason": "unreachable", "message": f"连接 n8n 失败：{exc}"}
    codes = {r_wf.status_code, r_ex.status_code}
    if codes & {401, 403}:
        # n8n 的 API Key 默认 30 天过期，过期后这里不能再当成“没有工作流”
        return {
            **base,
            "reason": "unauthorized",
            "message": "n8n 的 API Key 无效或已过期：在 n8n 的 Settings → n8n API 重新生成，更新 .env 里的 N8N_API_KEY 后执行 docker compose up -d",
        }
    if max(codes) >= 400:
        return {**base, "reason": "error", "message": f"n8n 接口返回 HTTP {max(codes)}"}
    try:
        wf, ex = r_wf.json(), r_ex.json()
    except ValueError:
        return {**base, "reason": "error", "message": "n8n 接口返回的不是 JSON"}
    names = {w.get("id"): w.get("name") for w in wf.get("data", [])}
    return {
        "enabled": True,
        "n8n_url": s.n8n_public_url or None,
        "workflows": [
            {"id": w.get("id"), "name": w.get("name"), "active": bool(w.get("active")), "updated_at": w.get("updatedAt")}
            for w in wf.get("data", [])
        ],
        "executions": [
            {
                "id": e.get("id"),
                "workflow_name": names.get(e.get("workflowId"), e.get("workflowId")),
                "status": e.get("status") or ("success" if e.get("finished") else "running"),
                "started_at": e.get("startedAt"),
                "stopped_at": e.get("stoppedAt"),
                "mode": e.get("mode"),
            }
            for e in ex.get("data", [])
        ],
    }


# ---------------------------------------------------------------- 连接器入口（n8n）与直连入口

@router.post("/api/events/feishu")
async def events_feishu(body: dict, p: Principal = Depends(current_connector), db: AsyncSession = Depends(get_session)) -> dict:
    ev = body
    if "kind" not in ev and ("header" in ev or "event" in ev):
        ev = KF.normalize_raw(ev)
    result = await KF.handle_event(db, ev)
    await commit(db)
    return result


@router.post("/api/events/gitlab")
async def events_gitlab(body: dict, p: Principal = Depends(current_connector), db: AsyncSession = Depends(get_session)) -> dict:
    ev = body
    if "object_kind" in ev and "kind" not in ev:
        ev = KG.normalize_raw(ev)
    result = await KG.handle_event(db, ev, event_uuid=body.get("event_uuid"))
    await commit(db)
    return result


@router.post("/api/hooks/gitlab")
async def hook_gitlab(request: Request, db: AsyncSession = Depends(get_session)) -> dict:
    s = get_settings()
    if not constant_eq(request.headers.get("x-gitlab-token", ""), s.gitlab_webhook_token):
        raise ApiError("unauthorized", "X-Gitlab-Token 不正确", 401)
    raw = json.loads(await request.body() or b"{}")
    ev = KG.normalize_raw(raw)
    result = await KG.handle_event(db, ev, event_uuid=request.headers.get("x-gitlab-event-uuid"))
    await commit(db)
    return result


@router.post("/api/hooks/feishu-bridge")
async def hook_feishu_bridge(request: Request, db: AsyncSession = Depends(get_session)) -> dict:
    s = get_settings()
    if not constant_eq(request.headers.get("x-bridge-token", ""), s.bridge_token):
        raise ApiError("unauthorized", "X-Bridge-Token 不正确", 401)
    raw = json.loads(await request.body() or b"{}")
    ev = raw if "kind" in raw else KF.normalize_raw(raw)
    result = await KF.handle_event(db, ev)
    await commit(db)
    return result
