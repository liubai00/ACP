"""请求级依赖：认证、数据库会话、限流。"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import get_session
from ..kernel.errors import ApiError
from ..models import ApiToken, Member
from ..security import (
    Principal,
    TokenError,
    connector_principal,
    constant_eq,
    decode_token,
    principal_from_claims,
)


def bearer(request: Request) -> str | None:
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    q = request.query_params.get("access_token")
    return q or None


async def resolve_principal(token: str | None, db: AsyncSession) -> Principal:
    s = get_settings()
    if not token:
        raise ApiError("unauthorized", "需要登录", 401)
    if s.connector_token and constant_eq(token, s.connector_token):
        return connector_principal()
    try:
        claims = decode_token(token)
    except TokenError as exc:
        raise ApiError("unauthorized", f"令牌无效：{exc}", 401) from exc
    p = principal_from_claims(claims)
    if claims.get("pat") and p.jti:  # 个人访问令牌：可吊销
        row = await db.get(ApiToken, p.jti)
        if row is None or row.revoked_at is not None:
            raise ApiError("unauthorized", "个人访问令牌已吊销", 401)
    if p.type == "service":
        if p.jti:
            row = await db.get(ApiToken, p.jti)
            if row is None or row.revoked_at is not None:
                raise ApiError("unauthorized", "服务令牌已吊销", 401)
        return p
    if p.member_id is not None:
        m = await db.get(Member, p.member_id)
        if m is None or not m.is_active:
            raise ApiError("unauthorized", "成员不存在或已停用", 401)
        if p.type == "member":
            p.roles = list(m.roles or [])  # 角色以数据库为准，改角色即时生效
            p.name = m.name
    return p


async def current(request: Request, db: AsyncSession = Depends(get_session)) -> Principal:
    p = await resolve_principal(bearer(request), db)
    _rate_limit(p, request)
    request.state.principal = p
    return p


async def current_member(p: Principal = Depends(current)) -> Principal:
    if p.type not in ("member", "agent"):
        raise ApiError("forbidden", "需要成员身份", 403)
    return p


async def current_human(p: Principal = Depends(current)) -> Principal:
    if p.type != "member":
        raise ApiError("forbidden", "需要成员本人登录（Agent 令牌不能调用这个接口）", 403)
    return p


async def current_admin(p: Principal = Depends(current)) -> Principal:
    if not p.is_admin:
        raise ApiError("forbidden", "需要管理员权限", 403)
    return p


async def current_connector(p: Principal = Depends(current)) -> Principal:
    if not p.has("connector", "admin"):
        raise ApiError("forbidden", "需要连接器服务令牌", 403)
    return p


_buckets: dict[str, deque[float]] = defaultdict(deque)


def _rate_limit(p: Principal, request: Request) -> None:
    limit = get_settings().rate_limit_per_minute
    if limit <= 0 or p.type == "service":
        return
    key = f"{p.type}:{p.agent_id or p.member_id}"
    now = time.monotonic()
    q = _buckets[key]
    while q and q[0] < now - 60:
        q.popleft()
    if len(q) >= limit:
        raise ApiError("rate_limited", "请求太频繁，请稍后再试", 429)
    q.append(now)
