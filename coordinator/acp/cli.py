"""管理命令：docker compose exec coordinator acp-admin <命令>"""

from __future__ import annotations

import asyncio
import sys

if sys.platform == "win32":  # psycopg 异步模式不支持 Windows 默认的 Proactor 循环
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
import uuid
from datetime import timedelta

import typer
from sqlalchemy import delete, select

from .db import dispose, session_scope
from .models import ApiToken, Member, utcnow
from .security import issue_token

app = typer.Typer(help="ACP 管理命令", no_args_is_help=True)


def _run(coro):
    async def wrapper():
        try:
            return await coro
        finally:
            await dispose()

    return asyncio.run(wrapper())


@app.command("list-members")
def list_members() -> None:
    """列出成员与角色。"""

    async def go():
        async with session_scope() as db:
            rows = (await db.execute(select(Member).order_by(Member.created_at))).scalars().all()
            for m in rows:
                flag = "" if m.is_active else " [停用]"
                demo = " [示例]" if m.is_demo else ""
                typer.echo(f"{m.id}  {m.name}{flag}{demo}  roles={','.join(m.roles or [])}  feishu={m.feishu_open_id or '-'}")

    _run(go())


@app.command("grant-role")
def grant_role(member: str = typer.Option(..., help="成员 ID 或名字"), role: str = typer.Option(...)) -> None:
    """给成员加角色：developer / reviewer / admin / agent_caller。"""

    async def go():
        async with session_scope() as db:
            m = await _find(db, member)
            m.roles = sorted(set(m.roles or []) | {role, "member"})
            typer.echo(f"{m.name}: {','.join(m.roles)}")

    _run(go())


@app.command("revoke-role")
def revoke_role(member: str = typer.Option(...), role: str = typer.Option(...)) -> None:
    async def go():
        async with session_scope() as db:
            m = await _find(db, member)
            m.roles = sorted(set(m.roles or []) - {role} | {"member"})
            typer.echo(f"{m.name}: {','.join(m.roles)}")

    _run(go())


@app.command("issue-service-token")
def issue_service_token(name: str = typer.Option("n8n"), role: str = typer.Option("connector"), days: int = typer.Option(365)) -> None:
    """签发长期服务令牌（JWT），可在 api_tokens 表吊销。"""

    async def go():
        token, exp = issue_token(sub=f"service:{name}", name=name, roles=[role], act="service", ttl=timedelta(days=days))
        import jwt as _jwt

        jti = _jwt.decode(token, options={"verify_signature": False})["jti"]
        async with session_scope() as db:
            db.add(ApiToken(jti=jti, name=name, roles=[role], created_at=utcnow(), expires_at=exp))
        typer.echo(token)

    _run(go())


@app.command("revoke-service-token")
def revoke_service_token(jti: str) -> None:
    async def go():
        async with session_scope() as db:
            row = await db.get(ApiToken, jti)
            if row is None:
                raise typer.BadParameter("找不到这个令牌")
            row.revoked_at = utcnow()
            typer.echo("已吊销")

    _run(go())


@app.command("seed-demo")
def seed_demo() -> None:
    """写入一批示例数据（标记为示例，可用 purge-demo 一键删除），用来预览任务榜。"""
    from .demo import seed

    n = _run(seed())
    typer.echo(f"已写入示例任务 {n} 个")


@app.command("purge-demo")
def purge_demo() -> None:
    """删除全部示例数据。"""
    from .models import Agent, Task

    async def go():
        async with session_scope() as db:
            t = await db.execute(delete(Task).where(Task.is_demo.is_(True)))
            a = await db.execute(delete(Agent).where(Agent.is_demo.is_(True)))
            m = await db.execute(delete(Member).where(Member.is_demo.is_(True)))
            typer.echo(f"已删除示例任务 {t.rowcount}、Agent {a.rowcount}、成员 {m.rowcount}")

    _run(go())


async def _find(db, key: str) -> Member:
    try:
        m = await db.get(Member, uuid.UUID(key))
    except ValueError:
        m = (await db.execute(select(Member).where(Member.name == key))).scalars().first()
    if m is None:
        raise typer.BadParameter(f"找不到成员 {key}")
    return m


if __name__ == "__main__":
    app()
