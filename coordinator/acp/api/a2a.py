"""A2A 1.0 JSON-RPC 服务端（协调服务器本身是一个 A2A Agent）。

方法名同时接受 1.0 写法与旧写法。技能由 params.message.metadata.skill 指定：
subscribe_assignments（流式）、report_progress、request_input、create_task。
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from starlette.responses import StreamingResponse

from .. import __version__
from ..broker import broker
from ..config import get_settings
from ..db import session_scope
from ..kernel import agents as KA
from ..kernel import tasks as K
from ..kernel.core import commit, get_task, iso_utc, serialize_task
from ..kernel.errors import ApiError
from ..models import Agent, MergeRequest, Task, utcnow
from ..security import Principal
from .deps import bearer, resolve_principal

log = logging.getLogger("acp.a2a")
router = APIRouter()

ALIASES = {
    "message/send": "SendMessage",
    "message/stream": "SendStreamingMessage",
    "tasks/get": "GetTask",
    "tasks/cancel": "CancelTask",
    "tasks/resubscribe": "SubscribeToTask",
    "tasks/subscribe": "SubscribeToTask",
}


def agent_card() -> dict[str, Any]:
    s = get_settings()
    base = s.issuer
    return {
        "protocolVersion": "1.0",
        "name": "ACP 协调服务器",
        "description": "多 Agent 任务协作平台的协调 Agent：建单、派工、Agent 互相求助、进度回传。",
        "url": f"{base}/a2a",
        "preferredTransport": "JSONRPC",
        "version": __version__,
        "provider": {"organization": "ACP", "url": base},
        "capabilities": {"streaming": True, "pushNotifications": False, "stateTransitionHistory": True},
        "defaultInputModes": ["text/plain", "application/json"],
        "defaultOutputModes": ["text/plain", "application/json"],
        "securitySchemes": {"bearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}},
        "security": [{"bearer": []}],
        "skills": [
            {"id": "subscribe_assignments", "name": "订阅派工", "description": "接入程序长期订阅派给本人 Agent 的任务（流式）", "tags": ["dispatch"]},
            {"id": "report_progress", "name": "回报进度", "description": "回传进度、结论、产物（分支、MR）", "tags": ["progress"]},
            {"id": "request_input", "name": "请求补充信息", "description": "任务转为待补充，并通知发布者", "tags": ["input"]},
            {"id": "create_task", "name": "发起求助", "description": "创建求助子任务，平台路由给合适的 Agent", "tags": ["help"]},
        ],
    }


def _rpc_result(rid: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _rpc_error(rid: Any, code: int, message: str, data: Any = None) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": rid, "error": err}


def _error_code(exc: ApiError) -> int:
    return {"not_found": -32001, "invalid_state": -32002, "forbidden": -32007, "validation_error": -32602}.get(exc.code, -32000)


async def a2a_task(db, task: Task) -> dict[str, Any]:
    mrs = list((await db.execute(select(MergeRequest).where(MergeRequest.task_id == task.id))).scalars())
    artifacts = [
        {
            "artifactId": f"mr-{m.id}",
            "name": f"{m.repo} {m.branch}",
            "parts": [{"kind": "data", "data": {"repo": m.repo, "branch": m.branch, "url": m.url, "state": m.state, "pipeline": m.pipeline_status}}],
        }
        for m in mrs
    ]
    return {
        "kind": "task",
        "id": str(task.id),
        "contextId": f"root-{task.root_id or task.id}",
        "status": {"state": task.state, "timestamp": iso_utc(task.state_changed_at)},
        "artifacts": artifacts,
        "metadata": {"key": task.key, "title": task.title, "type": task.type, "parent_id": task.parent_id},
    }


def _status_update(task_ref: str, state: str, data: dict[str, Any], final: bool = False) -> dict[str, Any]:
    return {
        "kind": "status-update",
        "taskId": task_ref,
        "contextId": task_ref,
        "status": {
            "state": state,
            "timestamp": iso_utc(utcnow()),
            "message": {"kind": "message", "role": "agent", "messageId": uuid.uuid4().hex, "parts": [{"kind": "data", "data": data}]},
        },
        "final": final,
    }


def _text_of(message: dict[str, Any]) -> str:
    parts = message.get("parts") or []
    out = []
    for p in parts:
        if p.get("kind", p.get("type")) == "text" or "text" in p:
            out.append(str(p.get("text") or ""))
    return "\n".join(x for x in out if x).strip()


def _sse(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


@router.get("/.well-known/agent-card.json")
@router.get("/.well-known/agent.json")
@router.get("/a2a/.well-known/agent-card.json")
async def card() -> dict[str, Any]:
    return agent_card()


@router.post("/a2a")
@router.post("/a2a/")
async def rpc(request: Request):
    try:
        body = json.loads(await request.body() or b"{}")
    except ValueError:
        return JSONResponse(_rpc_error(None, -32700, "JSON 解析失败"))
    rid = body.get("id")
    method = ALIASES.get(body.get("method"), body.get("method"))
    params = body.get("params") or {}
    async with session_scope() as db:
        try:
            p = await resolve_principal(bearer(request), db)
        except ApiError as exc:
            return JSONResponse(_rpc_error(rid, -32010, exc.message), status_code=401)
    if method == "SendStreamingMessage":
        skill = ((params.get("message") or {}).get("metadata") or {}).get("skill")
        if skill == "subscribe_assignments":
            return await _subscribe(request, rid, p, params)
        result = await _dispatch_send(rid, p, params)
        return StreamingResponse(iter([_sse(result)]), media_type="text/event-stream")
    if method == "SendMessage":
        return JSONResponse(await _dispatch_send(rid, p, params))
    if method == "GetTask":
        return JSONResponse(await _get_task(rid, p, params))
    if method == "CancelTask":
        return JSONResponse(await _cancel(rid, p, params))
    if method == "SubscribeToTask":
        return await _subscribe_task(request, rid, p, params)
    return JSONResponse(_rpc_error(rid, -32601, f"不支持的方法 {body.get('method')}"))


async def _dispatch_send(rid: Any, p: Principal, params: dict[str, Any]) -> dict[str, Any]:
    message = params.get("message") or {}
    meta = message.get("metadata") or {}
    skill = meta.get("skill")
    text = _text_of(message)
    try:
        async with session_scope() as db:
            if skill == "report_progress":
                task = await get_task(db, int(meta["task_id"]), lock=True)
                if p.type == "member" and meta.get("agent_id"):
                    agent = await KA.get_own_agent(db, p, uuid.UUID(str(meta["agent_id"])))
                    p = Principal(type="agent", member_id=p.member_id, name=f"{agent.name}", roles=p.roles + ["agent"], task_id=task.id, agent_id=agent.id) if task.assignee_id == p.member_id else p
                await K.agent_report(
                    db, p, task, state=meta.get("state"), kind=meta.get("kind") or "progress", text=text, artifacts=meta.get("artifacts")
                )
            elif skill == "request_input":
                task = await get_task(db, int(meta["task_id"]), lock=True)
                if p.type == "member" and meta.get("agent_id") and task.assignee_id == p.member_id:
                    agent = await KA.get_own_agent(db, p, uuid.UUID(str(meta["agent_id"])))
                    p = Principal(type="agent", member_id=p.member_id, name=agent.name, roles=p.roles + ["agent"], task_id=task.id, agent_id=agent.id)
                await K.request_input(db, p, task, meta.get("question") or text or "需要补充信息")
            elif skill == "create_task":
                parent = await get_task(db, int(meta["parent_id"]), lock=True)
                target = meta.get("target_member_id")
                task = await K.create_help(
                    db,
                    p,
                    parent,
                    title=meta.get("title") or text[:60] or "求助",
                    description=meta.get("description") or text,
                    target_skill=meta.get("target_skill"),
                    target_member_id=uuid.UUID(str(target)) if target else None,
                )
            else:
                return _rpc_error(rid, -32004, f"不支持的技能 {skill}")
            await commit(db)
            return _rpc_result(rid, await a2a_task(db, task))
    except ApiError as exc:
        return _rpc_error(rid, _error_code(exc), exc.message)
    except (KeyError, ValueError) as exc:
        return _rpc_error(rid, -32602, f"参数不正确：{exc}")


async def _get_task(rid: Any, p: Principal, params: dict[str, Any]) -> dict[str, Any]:
    try:
        async with session_scope() as db:
            task = await get_task(db, int(params.get("id")))
            return _rpc_result(rid, await a2a_task(db, task))
    except ApiError as exc:
        return _rpc_error(rid, _error_code(exc), exc.message)
    except (TypeError, ValueError):
        return _rpc_error(rid, -32602, "id 不正确")


async def _cancel(rid: Any, p: Principal, params: dict[str, Any]) -> dict[str, Any]:
    try:
        async with session_scope() as db:
            task = await get_task(db, int(params.get("id")), lock=True)
            await K.cancel(db, p, task, "A2A CancelTask")
            await commit(db)
            return _rpc_result(rid, await a2a_task(db, task))
    except ApiError as exc:
        return _rpc_error(rid, _error_code(exc), exc.message)


async def _subscribe(request: Request, rid: Any, p: Principal, params: dict[str, Any]):
    meta = (params.get("message") or {}).get("metadata") or {}
    try:
        agent_id = uuid.UUID(str(meta.get("agent_id")))
    except ValueError:
        return JSONResponse(_rpc_error(rid, -32602, "metadata.agent_id 不正确"))
    if p.type != "member":
        return JSONResponse(_rpc_error(rid, -32007, "订阅派工需要成员令牌"))
    try:
        async with session_scope() as db:
            agent = await KA.get_own_agent(db, p, agent_id)
            agent.status = "online"
            agent.last_heartbeat_at = utcnow()
            pending = await KA.pending_for_agent(db, agent)
            initial = [await serialize_task(db, t) for t in pending]
            reasons = {t.id: t.run_reason or "new" for t in pending}
            await commit(db)
    except ApiError as exc:
        return JSONResponse(_rpc_error(rid, _error_code(exc), exc.message))
    sub_ref = f"sub-{agent_id}"

    async def gen():
        async with broker.subscribe(KA.agent_channel(agent_id)) as q:
            yield _sse(_rpc_result(rid, {"kind": "task", "id": sub_ref, "contextId": sub_ref, "status": {"state": "working", "timestamp": iso_utc(utcnow())}}))
            for t in initial:
                yield _sse(_rpc_result(rid, _status_update(sub_ref, "working", {"type": "assignment", "task": t, "reason": reasons.get(t["id"], "new")})))
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=30)
                except TimeoutError:
                    try:
                        async with session_scope() as db:
                            a = await db.get(Agent, agent_id)
                            if a is not None:
                                a.last_heartbeat_at = utcnow()
                                if a.status == "offline":
                                    a.status = "online"
                    except Exception:  # noqa: BLE001
                        log.warning("订阅心跳写库失败")
                    yield _sse(_rpc_result(rid, _status_update(sub_ref, "working", {"type": "ping"})))
                    continue
                yield _sse(_rpc_result(rid, _status_update(sub_ref, "working", msg)))

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def _subscribe_task(request: Request, rid: Any, p: Principal, params: dict[str, Any]):
    try:
        task_id = int(params.get("id"))
        async with session_scope() as db:
            task = await get_task(db, task_id)
            first = await a2a_task(db, task)
    except ApiError as exc:
        return JSONResponse(_rpc_error(rid, _error_code(exc), exc.message))
    except (TypeError, ValueError):
        return JSONResponse(_rpc_error(rid, -32602, "id 不正确"))

    async def gen():
        async with broker.subscribe(f"task:{task_id}") as q:
            yield _sse(_rpc_result(rid, first))
            if first["status"]["state"] in ("completed", "failed", "canceled", "rejected"):
                return
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=30)
                except TimeoutError:
                    yield ": ping\n\n"
                    continue
                if msg.get("event") == "task":
                    st = msg["data"]["state"]
                    final = st in ("completed", "failed", "canceled", "rejected")
                    yield _sse(_rpc_result(rid, _status_update(str(task_id), st, {"type": "task", "task": msg["data"]}, final=final)))
                    if final:
                        break
                elif msg.get("event") == "timeline":
                    yield _sse(_rpc_result(rid, _status_update(str(task_id), first["status"]["state"], {"type": "timeline", "item": msg["data"]})))

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
