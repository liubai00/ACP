"""任务 REST 接口。"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import StreamingResponse

from ..broker import broker
from ..db import get_session, session_scope
from ..kernel import states as S
from ..kernel import tasks as K
from ..kernel.core import commit, get_task, serialize_task, serialize_tasks, timeline_item_message
from ..kernel.dispatch import PRIORITY_RANK
from ..kernel.errors import ApiError, validation
from ..models import Task
from ..security import Principal
from .deps import bearer, current, current_member, resolve_principal

router = APIRouter(prefix="/api")

SORTS = {
    "updated_at": Task.updated_at,
    "created_at": Task.created_at,
    "state_changed_at": Task.state_changed_at,
    "id": Task.id,
    "priority": PRIORITY_RANK,
    "title": Task.title,
}


def _uuid(v: Any, what: str = "id") -> uuid.UUID:
    try:
        return uuid.UUID(str(v))
    except (ValueError, TypeError) as exc:
        raise validation(f"{what} 格式不正确") from exc


@router.get("/tasks")
async def list_tasks(
    p: Principal = Depends(current),
    db: AsyncSession = Depends(get_session),
    q: str | None = None,
    state: str | None = None,
    assignee: str | None = None,
    creator: str | None = None,
    source: str | None = None,
    repo: str | None = None,
    priority: str | None = None,
    type: str | None = None,
    parent: int | None = None,
    demo: bool | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort: str = "-updated_at",
) -> dict[str, Any]:
    stmt = select(Task)
    if q:
        like = f"%{q.strip()}%"
        conds = [Task.title.ilike(like), Task.description.ilike(like)]
        digits = q.strip().upper().removeprefix("ACP-")
        if digits.isdigit():
            conds.append(Task.id == int(digits))
        stmt = stmt.where(or_(*conds))
    if state:
        stmt = stmt.where(Task.state.in_([s for s in state.split(",") if s]))
    if assignee:
        if assignee == "me":
            stmt = stmt.where(Task.assignee_id == p.member_id)
        elif assignee == "none":
            stmt = stmt.where(Task.assignee_id.is_(None))
        else:
            stmt = stmt.where(Task.assignee_id.in_([_uuid(x) for x in assignee.split(",") if x]))
    if creator:
        stmt = stmt.where(Task.creator_id == (p.member_id if creator == "me" else _uuid(creator)))
    if source:
        stmt = stmt.where(Task.source.in_(source.split(",")))
    if repo:
        stmt = stmt.where(Task.repos.overlap(repo.split(",")))
    if priority:
        stmt = stmt.where(Task.priority.in_(priority.split(",")))
    if type:
        stmt = stmt.where(Task.type.in_(type.split(",")))
    if parent is not None:
        stmt = stmt.where(Task.parent_id == parent)
    if demo is not None:
        stmt = stmt.where(Task.is_demo.is_(demo))
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    desc = sort.startswith("-")
    col = SORTS.get(sort.lstrip("-"), Task.updated_at)
    stmt = stmt.order_by(col.desc() if desc else col.asc(), Task.id.desc()).offset((page - 1) * page_size).limit(page_size)
    tasks = list((await db.execute(stmt)).scalars())
    return {"items": await serialize_tasks(db, tasks), "total": total, "page": page, "page_size": page_size}


@router.post("/tasks")
async def create(body: dict, p: Principal = Depends(current_member), db: AsyncSession = Depends(get_session)) -> dict:
    if p.type == "agent":
        raise ApiError("forbidden", "Agent 只能通过 ask_agent 发起求助子任务", 403)
    sugg = body.get("suggested_assignee_id")
    task = await K.create_task(
        db,
        p,
        title=body.get("title", ""),
        description=body.get("description") or "",
        repos=body.get("repos"),
        priority=body.get("priority") or "normal",
        skills=body.get("skills"),
        labels=body.get("labels"),
        parent_id=body.get("parent_id"),
        suggested_assignee_id=_uuid(sugg, "suggested_assignee_id") if sugg else None,
        source="board",
    )
    await commit(db)
    return await K.task_detail(db, p, task)


@router.get("/tasks/{task_id}")
async def detail(task_id: int, p: Principal = Depends(current), db: AsyncSession = Depends(get_session)) -> dict:
    task = await get_task(db, task_id)
    return await K.task_detail(db, p, task)


@router.patch("/tasks/{task_id}")
async def patch(task_id: int, body: dict, p: Principal = Depends(current_member), db: AsyncSession = Depends(get_session)) -> dict:
    task = await get_task(db, task_id, lock=True)
    await K.edit(db, p, task, body)
    await commit(db)
    return await K.task_detail(db, p, task)


async def _act(task_id: int, p: Principal, db: AsyncSession, fn, *args) -> dict:
    task = await get_task(db, task_id, lock=True)
    await fn(db, p, task, *args)
    await commit(db)
    return await K.task_detail(db, p, task)


@router.post("/tasks/{task_id}/claim")
async def claim(task_id: int, p: Principal = Depends(current_member), db: AsyncSession = Depends(get_session)) -> dict:
    return await _act(task_id, p, db, K.claim)


@router.post("/tasks/{task_id}/assign")
async def assign(task_id: int, body: dict, p: Principal = Depends(current_member), db: AsyncSession = Depends(get_session)) -> dict:
    return await _act(task_id, p, db, K.assign, _uuid(body.get("member_id"), "member_id"))


@router.post("/tasks/{task_id}/accept")
async def accept(task_id: int, p: Principal = Depends(current_member), db: AsyncSession = Depends(get_session)) -> dict:
    return await _act(task_id, p, db, K.accept)


@router.post("/tasks/{task_id}/decline")
async def decline(task_id: int, body: dict | None = None, p: Principal = Depends(current_member), db: AsyncSession = Depends(get_session)) -> dict:
    return await _act(task_id, p, db, K.decline, (body or {}).get("reason"))


@router.post("/tasks/{task_id}/cancel")
async def cancel(task_id: int, body: dict | None = None, p: Principal = Depends(current_member), db: AsyncSession = Depends(get_session)) -> dict:
    return await _act(task_id, p, db, K.cancel, (body or {}).get("reason"))


@router.post("/tasks/{task_id}/complete")
async def complete(task_id: int, body: dict | None = None, p: Principal = Depends(current_member), db: AsyncSession = Depends(get_session)) -> dict:
    return await _act(task_id, p, db, K.complete, (body or {}).get("note"))


@router.post("/tasks/{task_id}/input")
async def answer_input(task_id: int, body: dict, p: Principal = Depends(current_member), db: AsyncSession = Depends(get_session)) -> dict:
    content = str(body.get("content") or "").strip()
    if not content:
        raise validation("内容不能为空")
    return await _act(task_id, p, db, K.answer_input, content)


@router.post("/tasks/{task_id}/messages")
async def message(task_id: int, body: dict, p: Principal = Depends(current_member), db: AsyncSession = Depends(get_session)) -> dict:
    task = await get_task(db, task_id)
    msg = await K.post_message(db, p, task, str(body.get("content") or ""))
    await commit(db)
    return timeline_item_message(msg)


@router.post("/tasks/{task_id}/request-approval")
async def request_approval(task_id: int, body: dict | None = None, p: Principal = Depends(current_member), db: AsyncSession = Depends(get_session)) -> dict:
    body = body or {}
    task = await get_task(db, task_id, lock=True)
    await K.request_approval(db, p, task, body.get("gate") or "merge", body.get("note"))
    await commit(db)
    return await K.task_detail(db, p, task)


@router.post("/approvals/{approval_id}/decide")
async def decide(approval_id: int, body: dict, p: Principal = Depends(current_member), db: AsyncSession = Depends(get_session)) -> dict:
    task = await K.decide_approval(db, p, approval_id, str(body.get("decision") or ""), body.get("comment"))
    await commit(db)
    return await K.task_detail(db, p, task)


@router.post("/suggestions/{suggestion_id}/{verb}")
async def suggestion(suggestion_id: int, verb: str, p: Principal = Depends(current_member), db: AsyncSession = Depends(get_session)) -> dict:
    from ..agent.suggestions import decide_suggestion
    from ..kernel.core import serialize_suggestions

    if verb not in ("accept", "reject", "undo"):
        raise validation("只支持 accept / reject / undo")
    s = await decide_suggestion(db, p, suggestion_id, verb)
    await commit(db)
    return (await serialize_suggestions(db, [s]))[0]


@router.get("/tasks/{task_id}/stream")
async def stream(task_id: int, request: Request) -> StreamingResponse:
    async with session_scope() as db:
        await resolve_principal(bearer(request), db)
        task = await get_task(db, task_id)
        first = await serialize_task(db, task)

    async def gen():
        async with broker.subscribe(f"task:{task_id}") as q:
            yield f"event: task\ndata: {json.dumps(first, ensure_ascii=False)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=25)
                except TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield f"event: {msg['event']}\ndata: {json.dumps(msg['data'], ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def open_states() -> list[str]:
    return list(S.OPEN)
