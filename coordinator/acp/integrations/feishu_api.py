"""飞书开放平台接口（仅用到的几个）。

协调服务器持有 App ID / App Secret 用于 OAuth 登录；ACP_NOTIFY_MODE=direct 时也用它发消息。
"""

from __future__ import annotations

import json
import time
from typing import Any
from urllib.parse import urlencode

import httpx

from ..config import get_settings


class FeishuError(Exception):
    pass


_tenant_token: tuple[str, float] | None = None
_bot_open_id: str | None = None


def _base() -> str:
    return get_settings().feishu_base_url.rstrip("/")


async def tenant_access_token(client: httpx.AsyncClient | None = None) -> str:
    global _tenant_token
    if _tenant_token and _tenant_token[1] > time.time() + 60:
        return _tenant_token[0]
    s = get_settings()
    if not s.feishu_enabled:
        raise FeishuError("飞书 App ID / App Secret 未配置")
    own = client is None
    client = client or httpx.AsyncClient(timeout=10)
    try:
        r = await client.post(
            f"{_base()}/open-apis/auth/v3/tenant_access_token/internal",
            json={"app_id": s.feishu_app_id, "app_secret": s.feishu_app_secret},
        )
        data = r.json()
        if data.get("code") != 0:
            raise FeishuError(f"获取 tenant_access_token 失败：{data.get('msg')}")
        _tenant_token = (data["tenant_access_token"], time.time() + int(data.get("expire", 3600)))
        return _tenant_token[0]
    finally:
        if own:
            await client.aclose()


async def _call(method: str, path: str, *, params: dict[str, Any] | None = None, body: Any = None) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=15) as client:
        token = await tenant_access_token(client)
        r = await client.request(
            method,
            f"{_base()}{path}",
            params=params,
            json=body,
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            data = r.json()
        except ValueError as exc:
            raise FeishuError(f"飞书返回非 JSON：HTTP {r.status_code}") from exc
        if data.get("code") != 0:
            raise FeishuError(f"飞书接口错误 {data.get('code')}：{data.get('msg')}")
        return data.get("data") or {}


async def bot_open_id() -> str | None:
    global _bot_open_id
    if _bot_open_id:
        return _bot_open_id
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            token = await tenant_access_token(client)
            r = await client.get(f"{_base()}/open-apis/bot/v3/info", headers={"Authorization": f"Bearer {token}"})
            data = r.json()
            _bot_open_id = (data.get("bot") or {}).get("open_id")
    except Exception:  # noqa: BLE001
        return None
    return _bot_open_id


async def send_message(receive_id_type: str, receive_id: str, msg_type: str, content: dict[str, Any]) -> dict[str, Any]:
    return await _call(
        "POST",
        "/open-apis/im/v1/messages",
        params={"receive_id_type": receive_id_type},
        body={"receive_id": receive_id, "msg_type": msg_type, "content": json.dumps(content, ensure_ascii=False)},
    )


async def reply_message(message_id: str, msg_type: str, content: dict[str, Any]) -> dict[str, Any]:
    return await _call(
        "POST",
        f"/open-apis/im/v1/messages/{message_id}/reply",
        body={"msg_type": msg_type, "content": json.dumps(content, ensure_ascii=False)},
    )


async def update_card(message_id: str, card: dict[str, Any]) -> dict[str, Any]:
    return await _call(
        "PATCH",
        f"/open-apis/im/v1/messages/{message_id}",
        body={"content": json.dumps(card, ensure_ascii=False)},
    )


async def get_message(message_id: str) -> dict[str, Any]:
    return await _call("GET", f"/open-apis/im/v1/messages/{message_id}")


async def get_user(open_id: str) -> dict[str, Any] | None:
    try:
        data = await _call("GET", f"/open-apis/contact/v3/users/{open_id}", params={"user_id_type": "open_id"})
        return data.get("user")
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------- OAuth（用户身份登录）

def authorize_url(redirect_uri: str, state: str) -> str:
    s = get_settings()
    q = urlencode({"client_id": s.feishu_app_id, "redirect_uri": redirect_uri, "state": state, "response_type": "code"})
    return f"{s.feishu_accounts_url.rstrip('/')}/open-apis/authen/v1/authorize?{q}"


async def exchange_code(code: str, redirect_uri: str) -> dict[str, Any]:
    """用授权码换用户信息。优先 v2 OAuth 接口，失败时回退到 v1 OIDC 接口。"""
    s = get_settings()
    async with httpx.AsyncClient(timeout=15) as client:
        user_token = None
        r = await client.post(
            f"{_base()}/open-apis/authen/v2/oauth/token",
            json={
                "grant_type": "authorization_code",
                "client_id": s.feishu_app_id,
                "client_secret": s.feishu_app_secret,
                "code": code,
                "redirect_uri": redirect_uri,
            },
        )
        data = r.json()
        if data.get("access_token"):
            user_token = data["access_token"]
        else:
            app_token = await tenant_access_token(client)
            r = await client.post(
                f"{_base()}/open-apis/authen/v1/oidc/access_token",
                json={"grant_type": "authorization_code", "code": code},
                headers={"Authorization": f"Bearer {app_token}"},
            )
            d1 = r.json()
            if d1.get("code") != 0:
                raise FeishuError(f"飞书授权码换取失败：{data.get('error_description') or d1.get('msg')}")
            user_token = d1["data"]["access_token"]
        r = await client.get(
            f"{_base()}/open-apis/authen/v1/user_info", headers={"Authorization": f"Bearer {user_token}"}
        )
        info = r.json()
        if info.get("code") != 0:
            raise FeishuError(f"获取飞书用户信息失败：{info.get('msg')}")
        return info["data"]
