"""测试环境：真实 uvicorn + 本地 Postgres（ACP_TEST_DATABASE_URL），每次测试会话重建表结构。"""

from __future__ import annotations

import asyncio
import os
import socket
import sys
import tempfile
from pathlib import Path

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

_port_file = Path(__file__).resolve().parents[2] / ".local" / "devpg.port"
_pg_port = _port_file.read_text().strip() if _port_file.exists() else "5432"
os.environ.setdefault("ACP_TEST_DATABASE_URL", f"postgresql+psycopg://acp:acp@127.0.0.1:{_pg_port}/acp_test")

_tmp = tempfile.mkdtemp(prefix="acp-test-")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


PORT = _free_port()
BASE = f"http://127.0.0.1:{PORT}"
os.environ.update(
    {
        "ACP_DATABASE_URL": os.environ["ACP_TEST_DATABASE_URL"],
        "ACP_PUBLIC_URL": BASE,
        "ACP_JWT_PRIVATE_KEY_FILE": str(Path(_tmp) / "jwt.pem"),
        "ACP_JWT_AUTOGEN": "true",
        "ACP_DEV_LOGIN": "true",
        "ACP_ADMIN_PASSWORD": "test-admin-pass",
        "ACP_CONNECTOR_TOKEN": "test-connector-token",
        "ACP_GITLAB_WEBHOOK_TOKEN": "test-gitlab-secret",
        "ACP_BRIDGE_TOKEN": "test-bridge-token",
        "ACP_NOTIFY_MODE": "log",
        "ACP_RATE_LIMIT_PER_MINUTE": "0",
        "ACP_FEISHU_CHAT_IDS": "",
        "ACP_FEISHU_INTAKE_MODE": "at_mention,shortcut,all",
        "ACP_LOG_LEVEL": "warning",
    }
)

import httpx  # noqa: E402
import pytest  # noqa: E402
import uvicorn  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402


async def _reset_db() -> None:
    url = os.environ["ACP_TEST_DATABASE_URL"]
    admin_url = url.rsplit("/", 1)[0] + "/acp"
    eng = create_async_engine(admin_url, isolation_level="AUTOCOMMIT")
    async with eng.connect() as conn:
        await conn.execute(text("DROP DATABASE IF EXISTS acp_test WITH (FORCE)"))
        await conn.execute(text("CREATE DATABASE acp_test"))
    await eng.dispose()
    from acp.models import Base

    eng = create_async_engine(url)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await eng.dispose()


@pytest.fixture(scope="session")
async def server():
    await _reset_db()
    from acp.main import create_app

    app = create_app(background=True)
    config = uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning", lifespan="on")
    srv = uvicorn.Server(config)
    task = asyncio.create_task(srv.serve())
    for _ in range(100):
        if srv.started:
            break
        await asyncio.sleep(0.05)
    yield BASE
    srv.should_exit = True
    await asyncio.wait_for(task, timeout=10)


@pytest.fixture(scope="session")
async def client(server):
    async with httpx.AsyncClient(base_url=server, timeout=20) as c:
        yield c


async def login(client: httpx.AsyncClient, name: str, admin: bool = False) -> tuple[str, dict]:
    r = await client.post("/auth/dev", json={"name": name, "admin": admin})
    assert r.status_code == 200, r.text
    data = r.json()
    return data["token"], data["member"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


CONNECTOR = {"Authorization": "Bearer test-connector-token"}
