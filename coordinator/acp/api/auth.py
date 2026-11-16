"""登录：飞书 OAuth、本地管理员（引导用）、开发登录、设备授权（接入程序用）。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from datetime import timedelta
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import get_session
from ..integrations import feishu_api
from ..kernel.core import commit, serialize_member
from ..kernel.errors import ApiError
from ..models import DeviceCode, Member, utcnow
from ..security import Principal, constant_eq, member_token, new_device_code, new_user_code
from .deps import current, current_human

router = APIRouter()

ADMIN_ROLES = ["member", "developer", "reviewer", "admin"]


def _secret() -> bytes:
    s = get_settings()
    return (s.connector_token or s.admin_password or "acp-dev-secret").encode()


def _sign_state(data: dict) -> str:
    raw = base64.urlsafe_b64encode(json.dumps(data, separators=(",", ":")).encode()).decode().rstrip("=")
    sig = hmac.new(_secret(), raw.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{raw}.{sig}"


def _verify_state(state: str) -> dict:
    try:
        raw, sig = state.rsplit(".", 1)
    except ValueError as exc:
        raise ApiError("unauthorized", "登录状态无效", 401) from exc
    expect = hmac.new(_secret(), raw.encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(sig, expect):
        raise ApiError("unauthorized", "登录状态校验失败", 401)
    data = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    if data.get("exp", 0) < time.time():
        raise ApiError("unauthorized", "登录已超时，请重试", 401)
    return data


def _safe_redirect(path: str | None) -> str:
    if not path or not path.startswith("/") or path.startswith("//"):
        return "/"
    return path


def _token_response(m: Member) -> dict:
    token, exp = member_token(m.id, m.name, list(m.roles or []))
    return {"token": token, "expires_at": exp.isoformat(), "member": serialize_member(m)}


@router.get("/auth/providers")
async def providers() -> dict:
    s = get_settings()
    return {"feishu": s.feishu_enabled, "local": bool(s.admin_password), "dev": s.dev_login}


@router.get("/auth/feishu/login")
async def feishu_login(redirect: str = "/") -> RedirectResponse:
    s = get_settings()
    if not s.feishu_enabled:
        raise ApiError("unconfigured", "飞书登录未配置", 400)
    state = _sign_state({"r": _safe_redirect(redirect), "n": secrets.token_hex(8), "exp": time.time() + 600})
    return RedirectResponse(feishu_api.authorize_url(f"{s.issuer}/auth/feishu/callback", state), status_code=302)


@router.get("/auth/feishu/callback")
async def feishu_callback(code: str = "", state: str = "", db: AsyncSession = Depends(get_session)) -> RedirectResponse:
    s = get_settings()
    data = _verify_state(state)
    if not code:
        raise ApiError("unauthorized", "飞书没有返回授权码", 401)
    info = await feishu_api.exchange_code(code, f"{s.issuer}/auth/feishu/callback")
    open_id = info.get("open_id")
    if not open_id:
        raise ApiError("unauthorized", "飞书没有返回 open_id", 401)
    m = (await db.execute(select(Member).where(Member.feishu_open_id == open_id))).scalar_one_or_none()
    if m is None:
        m = Member(feishu_open_id=open_id, name=info.get("name") or "飞书用户", roles=["member", "developer"], created_at=utcnow())
        db.add(m)
        await db.flush()
    m.name = info.get("name") or m.name
    m.avatar_url = info.get("avatar_url") or info.get("avatar_middle") or m.avatar_url
    m.email = info.get("email") or info.get("enterprise_email") or m.email
    m.feishu_union_id = info.get("union_id") or m.feishu_union_id
    if m.last_login_at is None and "developer" not in (m.roles or []):
        m.roles = sorted(set(m.roles or []) | {"member", "developer"})
    has_admin = (
        await db.execute(
            select(func.count()).select_from(Member).where(Member.roles.overlap(["admin"]), Member.feishu_open_id.isnot(None), Member.is_demo.is_(False))
        )
    ).scalar_one()
    if not has_admin:
        m.roles = sorted(set(m.roles or []) | set(ADMIN_ROLES))
    m.last_login_at = utcnow()
    await commit(db)
    token = _token_response(m)["token"]
    return RedirectResponse(f"/login/callback#token={token}&redirect={quote(data.get('r') or '/')}", status_code=302)


@router.post("/auth/local")
async def local_login(body: dict, db: AsyncSession = Depends(get_session)) -> dict:
    s = get_settings()
    if not s.admin_password:
        raise ApiError("forbidden", "本地管理员登录未开启", 403)
    if not (constant_eq(str(body.get("username", "")), s.admin_username) and constant_eq(str(body.get("password", "")), s.admin_password)):
        raise ApiError("unauthorized", "用户名或密码错误", 401)
    m = (await db.execute(select(Member).where(Member.local_username == s.admin_username))).scalar_one_or_none()
    if m is None:
        m = Member(local_username=s.admin_username, name="平台管理员", roles=ADMIN_ROLES, created_at=utcnow())
        db.add(m)
        await db.flush()
    m.last_login_at = utcnow()
    await commit(db)
    return _token_response(m)


@router.post("/auth/dev")
async def dev_login(body: dict, db: AsyncSession = Depends(get_session)) -> dict:
    s = get_settings()
    if not s.dev_login:
        raise ApiError("forbidden", "开发登录未开启", 403)
    name = str(body.get("name") or "").strip()[:50]
    if not name:
        raise ApiError("validation_error", "请输入名字", 422)
    username = f"dev:{name}"
    m = (await db.execute(select(Member).where(Member.local_username == username))).scalar_one_or_none()
    if m is None:
        roles = ["member", "developer"] + (["reviewer", "admin"] if body.get("admin") else [])
        m = Member(local_username=username, name=name, roles=roles, created_at=utcnow())
        db.add(m)
        await db.flush()
    m.last_login_at = utcnow()
    await commit(db)
    return _token_response(m)


@router.post("/auth/refresh")
async def refresh(p: Principal = Depends(current), db: AsyncSession = Depends(get_session)) -> dict:
    if p.type != "member" or p.member_id is None:
        raise ApiError("forbidden", "只有成员令牌可以刷新", 403)
    m = await db.get(Member, p.member_id)
    assert m is not None
    return _token_response(m)


# ---------------------------------------------------------------- 设备授权（acp-link 登录）

@router.post("/auth/device/code")
async def device_code(request: Request, body: dict | None = None, db: AsyncSession = Depends(get_session)) -> dict:
    s = get_settings()
    body = body or {}
    dc = DeviceCode(
        device_code=new_device_code(),
        user_code=new_user_code(),
        client=str(body.get("client") or "acp-link")[:60],
        hostname=str(body.get("hostname") or "")[:200] or None,
        status="pending",
        expires_at=utcnow() + timedelta(minutes=10),
        created_at=utcnow(),
    )
    db.add(dc)
    await commit(db)
    base = s.issuer
    return {
        "device_code": dc.device_code,
        "user_code": dc.user_code,
        "verification_uri": f"{base}/device",
        "verification_uri_complete": f"{base}/device?code={dc.user_code}",
        "expires_in": 600,
        "interval": 3,
    }


@router.post("/auth/device/token")
async def device_token(body: dict, db: AsyncSession = Depends(get_session)):
    dc = await db.get(DeviceCode, str(body.get("device_code") or ""), with_for_update=True)
    if dc is None:
        return JSONResponse({"error": "invalid_grant", "message": "设备码无效"}, status_code=400)
    if dc.expires_at < utcnow():
        return JSONResponse({"error": "expired_token", "message": "设备码已过期，请重新登录"}, status_code=400)
    if dc.status == "pending":
        return JSONResponse({"error": "authorization_pending", "message": "等待在浏览器里确认"}, status_code=400)
    if dc.status != "approved" or dc.member_id is None:
        return JSONResponse({"error": "invalid_grant", "message": "设备码已使用"}, status_code=400)
    m = await db.get(Member, dc.member_id)
    if m is None or not m.is_active:
        return JSONResponse({"error": "access_denied", "message": "成员不可用"}, status_code=400)
    dc.status = "consumed"
    await commit(db)
    token, exp = member_token(m.id, m.name, list(m.roles or []))
    return {
        "access_token": token,
        "token_type": "Bearer",
        "expires_in": int((exp - utcnow()).total_seconds()),
        "member": serialize_member(m),
    }


@router.post("/api/device/approve")
async def device_approve(body: dict, p: Principal = Depends(current_human), db: AsyncSession = Depends(get_session)) -> dict:
    code = str(body.get("user_code") or "").strip().upper()
    if len(code) == 8 and "-" not in code:
        code = f"{code[:4]}-{code[4:]}"
    dc = (await db.execute(select(DeviceCode).where(DeviceCode.user_code == code).with_for_update())).scalar_one_or_none()
    if dc is None or dc.expires_at < utcnow():
        raise ApiError("not_found", "验证码不存在或已过期", 404)
    if dc.status != "pending":
        raise ApiError("conflict", "这个验证码已经用过了", 409)
    dc.member_id = p.member_id
    dc.status = "approved"
    await commit(db)
    return {"ok": True, "client": dc.client, "hostname": dc.hostname}
