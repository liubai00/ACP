"""身份与令牌：RS256 自签 JWT，公钥以 JWKS 公布。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from .config import get_settings

_private_key: rsa.RSAPrivateKey | None = None
_kid: str | None = None


def _load_key() -> rsa.RSAPrivateKey:
    global _private_key, _kid
    if _private_key is not None:
        return _private_key
    settings = get_settings()
    path = Path(settings.jwt_private_key_file)
    if not path.exists():
        if not settings.jwt_autogen:
            raise RuntimeError(f"JWT 私钥文件不存在：{path}（生产环境请先生成，开发环境可设 ACP_JWT_AUTOGEN=true）")
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    loaded = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(loaded, rsa.RSAPrivateKey):
        raise RuntimeError("JWT 私钥必须是 RSA 私钥")
    _private_key = loaded
    pub = loaded.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    _kid = hashlib.sha256(pub).hexdigest()[:16]
    return loaded


def _b64u(n: int) -> str:
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def jwks() -> dict[str, Any]:
    key = _load_key()
    numbers = key.public_key().public_numbers()
    return {
        "keys": [
            {"kty": "RSA", "use": "sig", "alg": "RS256", "kid": _kid, "n": _b64u(numbers.n), "e": _b64u(numbers.e)}
        ]
    }


@dataclass
class Principal:
    """调用方身份。type: member / agent / service / system。"""

    type: str
    member_id: uuid.UUID | None = None
    name: str = ""
    roles: list[str] = field(default_factory=list)
    task_id: int | None = None
    agent_id: uuid.UUID | None = None
    jti: str | None = None

    def has(self, *roles: str) -> bool:
        return any(r in self.roles for r in roles)

    @property
    def is_admin(self) -> bool:
        return "admin" in self.roles

    @property
    def actor_type(self) -> str:
        return {"member": "member", "agent": "agent", "service": "connector"}.get(self.type, "system")

    @property
    def actor_id(self) -> str | None:
        if self.type == "agent" and self.agent_id:
            return str(self.agent_id)
        return str(self.member_id) if self.member_id else None


SYSTEM = Principal(type="system", name="系统", roles=["admin"])


def issue_token(
    *,
    sub: str,
    name: str,
    roles: list[str],
    act: str = "member",
    ttl: timedelta,
    extra: dict[str, Any] | None = None,
) -> tuple[str, datetime]:
    settings = get_settings()
    key = _load_key()
    now = datetime.now(UTC)
    exp = now + ttl
    payload: dict[str, Any] = {
        "iss": settings.issuer,
        "aud": settings.jwt_audience,
        "sub": sub,
        "name": name,
        "roles": roles,
        "act": act,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "jti": uuid.uuid4().hex,
    }
    if extra:
        payload.update(extra)
    token = jwt.encode(payload, key, algorithm="RS256", headers={"kid": _kid})
    return token, exp


def member_token(member_id: uuid.UUID, name: str, roles: list[str]) -> tuple[str, datetime]:
    settings = get_settings()
    return issue_token(
        sub=str(member_id), name=name, roles=roles, act="member", ttl=timedelta(days=settings.member_token_days)
    )


def agent_token(member_id: uuid.UUID, name: str, roles: list[str], task_id: int, agent_id: uuid.UUID) -> tuple[str, datetime]:
    settings = get_settings()
    narrowed = sorted({r for r in roles if r in ("member", "developer")} | {"agent", "agent_caller"})
    return issue_token(
        sub=str(member_id),
        name=name,
        roles=narrowed,
        act="agent",
        ttl=timedelta(hours=settings.agent_token_hours),
        extra={"task_id": task_id, "agent_id": str(agent_id)},
    )


class TokenError(Exception):
    pass


def decode_token(token: str) -> dict[str, Any]:
    settings = get_settings()
    key = _load_key().public_key()
    try:
        return jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=settings.jwt_audience,
            issuer=settings.issuer,
            options={"require": ["exp", "sub", "iss"]},
            leeway=30,
        )
    except jwt.PyJWTError as exc:  # noqa: PERF203
        raise TokenError(str(exc)) from exc


def principal_from_claims(claims: dict[str, Any]) -> Principal:
    act = claims.get("act", "member")
    member_id = None
    try:
        member_id = uuid.UUID(claims["sub"])
    except (KeyError, ValueError):
        member_id = None
    agent_id = None
    if claims.get("agent_id"):
        try:
            agent_id = uuid.UUID(claims["agent_id"])
        except ValueError:
            agent_id = None
    ptype = {"member": "member", "agent": "agent", "service": "service"}.get(act, "member")
    return Principal(
        type=ptype,
        member_id=member_id if ptype != "service" else None,
        name=claims.get("name", ""),
        roles=list(claims.get("roles") or []),
        task_id=claims.get("task_id"),
        agent_id=agent_id,
        jti=claims.get("jti"),
    )


def connector_principal() -> Principal:
    return Principal(type="service", name="n8n", roles=["connector"])


def constant_eq(a: str, b: str) -> bool:
    if not a or not b:
        return False
    return hmac.compare_digest(a.encode(), b.encode())


def new_user_code() -> str:
    alphabet = "BCDFGHJKLMNPQRSTVWXZ"
    raw = "".join(secrets.choice(alphabet) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def new_device_code() -> str:
    return secrets.token_urlsafe(32)
