"""端到端：建单 → 认领 → 派给 Agent（A2A 订阅流）→ 回报 → GitLab 回执 → 审批 → 合并完成。"""

from __future__ import annotations

import asyncio
import json
import uuid

import httpx

from .conftest import CONNECTOR, auth, login


async def test_health_and_public(client):
    r = await client.get("/healthz")
    assert r.json()["status"] == "ok"
    assert (await client.get("/auth/providers")).json() == {"feishu": False, "local": True, "dev": True}
    jwks = (await client.get("/.well-known/jwks.json")).json()
    assert jwks["keys"][0]["kty"] == "RSA"
    card = (await client.get("/.well-known/agent-card.json")).json()
    assert {s["id"] for s in card["skills"]} >= {"subscribe_assignments", "report_progress", "create_task"}
    assert (await client.get("/api/tasks")).status_code == 401


async def test_local_admin_login(client):
    r = await client.post("/auth/local", json={"username": "admin", "password": "wrong"})
    assert r.status_code == 401
    r = await client.post("/auth/local", json={"username": "admin", "password": "test-admin-pass"})
    assert r.status_code == 200
    assert "admin" in r.json()["member"]["roles"]


async def _read_sse(resp: httpx.Response, queue: asyncio.Queue):
    buf = ""
    async for chunk in resp.aiter_text():
        buf += chunk
        while "\n\n" in buf:
            block, buf = buf.split("\n\n", 1)
            for line in block.splitlines():
                if line.startswith("data: "):
                    await queue.put(json.loads(line[6:]))


async def _next_assignment(queue: asyncio.Queue, timeout: float = 10) -> dict:
    while True:
        item = await asyncio.wait_for(queue.get(), timeout=timeout)
        res = item.get("result") or {}
        if res.get("kind") == "status-update":
            data = res["status"]["message"]["parts"][0]["data"]
            if data.get("type") == "assignment":
                return data


async def test_full_flow(client, server):
    alice_tok, alice = await login(client, "爱丽丝")
    bob_tok, bob = await login(client, "鲍勃", admin=True)  # 评审者 + 管理员

    # 1. 建单（任务榜）
    r = await client.post("/api/tasks", headers=auth(bob_tok), json={"title": "登录页支持深色模式", "description": "按设计稿改", "repos": ["mobile/app"], "priority": "high"})
    assert r.status_code == 200, r.text
    task = r.json()
    tid = task["id"]
    assert task["state"] == "submitted" and task["key"] == f"ACP-{tid}"
    assert "claim" in task["allowed_actions"] or "accept" in task["allowed_actions"] or task["suggested_assignee"]

    # 2. 注册 Agent 并订阅派工
    r = await client.post("/api/agents/register", headers=auth(alice_tok), json={"name": "alice-mac", "kind": "echo", "version": "0.1.0", "skills": ["frontend"], "repos": ["mobile/app"], "max_concurrency": 1})
    assert r.status_code == 200, r.text
    agent = r.json()
    assert agent["status"] == "online"

    queue: asyncio.Queue = asyncio.Queue()
    body = {"jsonrpc": "2.0", "id": 1, "method": "SendStreamingMessage", "params": {"message": {"role": "user", "messageId": "m1", "parts": [{"kind": "text", "text": "subscribe"}], "metadata": {"skill": "subscribe_assignments", "agent_id": agent["id"]}}}}
    sub_client = httpx.AsyncClient(base_url=server, timeout=None)
    stream_ctx = sub_client.stream("POST", "/a2a", json=body, headers=auth(alice_tok))
    resp = await stream_ctx.__aenter__()
    assert resp.status_code == 200
    reader = asyncio.create_task(_read_sse(resp, queue))
    first = await asyncio.wait_for(queue.get(), timeout=5)
    assert first["result"]["kind"] == "task"

    # 3. 爱丽丝认领 → 派工推到她的 Agent
    r = await client.post(f"/api/tasks/{tid}/claim", headers=auth(alice_tok))
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "working"
    assignment = await _next_assignment(queue)
    assert assignment["task"]["id"] == tid and assignment["reason"] == "new"

    # 4. Agent 确认、回报进度、登记 MR
    async def report(meta, text=""):
        req = {"jsonrpc": "2.0", "id": 2, "method": "SendMessage", "params": {"message": {"role": "agent", "messageId": uuid.uuid4().hex, "parts": [{"kind": "text", "text": text}], "metadata": {"skill": "report_progress", "task_id": tid, "agent_id": agent["id"], **meta}}}}
        rr = await client.post("/a2a", json=req, headers=auth(alice_tok))
        assert rr.status_code == 200
        assert "result" in rr.json(), rr.text
        return rr.json()["result"]

    await report({"kind": "ack", "state": "working"}, "开始执行")
    await report({"kind": "progress"}, "正在修改 login.vue")
    res = await report({"kind": "artifact", "artifacts": [{"name": "MR", "repo": "mobile/app", "branch": f"acp/{tid}-dark-mode", "url": "https://gitlab.example.com/mobile/app/-/merge_requests/7"}]}, "已提交 MR")
    assert res["artifacts"][0]["parts"][0]["data"]["url"].endswith("/7")

    # 5. GitLab：流水线通过 → 待审批
    r = await client.post("/api/hooks/gitlab", headers={"X-Gitlab-Token": "test-gitlab-secret", "X-Gitlab-Event-UUID": "uuid-1"}, json={
        "object_kind": "pipeline", "project": {"path_with_namespace": "mobile/app", "web_url": "https://gitlab.example.com/mobile/app"},
        "object_attributes": {"id": 99, "status": "success", "ref": f"acp/{tid}-dark-mode", "sha": "abc"},
        "merge_request": {"iid": 7, "url": "https://gitlab.example.com/mobile/app/-/merge_requests/7", "source_branch": f"acp/{tid}-dark-mode"},
    })
    assert r.status_code == 200, r.text
    # 幂等：同一个事件再来一次不重复处理
    r2 = await client.post("/api/hooks/gitlab", headers={"X-Gitlab-Token": "test-gitlab-secret", "X-Gitlab-Event-UUID": "uuid-1"}, json={"object_kind": "pipeline"})
    assert r2.json().get("duplicate") is True
    d = (await client.get(f"/api/tasks/{tid}", headers=auth(bob_tok))).json()
    assert d["state"] == "auth-required"
    pending = [a for a in d["approvals"] if a["status"] == "pending"]
    assert pending and "approve" in d["allowed_actions"]

    # 负责人自己不能审批
    r = await client.post(f"/api/approvals/{pending[0]['id']}/decide", headers=auth(alice_tok), json={"decision": "approve"})
    assert r.status_code == 403

    # 6. 评审者同意 → MR 合并 → 完成
    r = await client.post(f"/api/approvals/{pending[0]['id']}/decide", headers=auth(bob_tok), json={"decision": "approve", "comment": "LGTM"})
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "auth-required"
    r = await client.post("/api/events/gitlab", headers=CONNECTOR, json={
        "event_uuid": "uuid-2", "kind": "merge_request", "project": "mobile/app", "branch": f"acp/{tid}-dark-mode",
        "mr_iid": 7, "mr_url": "https://gitlab.example.com/mobile/app/-/merge_requests/7", "mr_state": "merged", "mr_action": "merge",
    })
    assert r.status_code == 200, r.text
    d = (await client.get(f"/api/tasks/{tid}", headers=auth(bob_tok))).json()
    assert d["state"] == "completed", d["timeline"][-3:]
    types = [i["type"] for i in d["timeline"]]
    assert "agent.acked" in types and "ci.success" in types and "approval.approved" in types and "mr.merged" in types

    reader.cancel()
    await stream_ctx.__aexit__(None, None, None)
    await sub_client.aclose()


async def test_input_required_and_answer(client):
    tok, me = await login(client, "卡尔")
    r = await client.post("/api/tasks", headers=auth(tok), json={"title": "导出报表", "repos": ["web/console"]})
    tid = r.json()["id"]
    await client.post(f"/api/tasks/{tid}/claim", headers=auth(tok))
    req = {"jsonrpc": "2.0", "id": 3, "method": "message/send", "params": {"message": {"role": "agent", "parts": [{"kind": "text", "text": "要导出哪些字段？"}], "metadata": {"skill": "request_input", "task_id": tid}}}}
    r = await client.post("/a2a", json=req, headers=auth(tok))
    assert r.json()["result"]["status"]["state"] == "input-required"
    r = await client.post(f"/api/tasks/{tid}/input", headers=auth(tok), json={"content": "订单号、金额、时间"})
    assert r.status_code == 200 and r.json()["state"] == "working"


async def test_feishu_intake_and_card_claim(client):
    ev = {
        "event_id": "fs-1", "event_type": "im.message.receive_v1", "kind": "message", "chat_id": "oc_test", "chat_type": "group",
        "message_id": "om_1", "sender_open_id": "ou_sender", "text": "@_user_1 @_user_2 帮忙修复首页白屏 bug",
        "mentions": [{"open_id": "ou_bot", "name": "ACP", "is_bot": True}, {"open_id": "ou_dev", "name": "戴夫", "is_bot": False}],
    }
    r = await client.post("/api/events/feishu", headers=CONNECTOR, json=ev)
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "confirm": True}
    assert (await client.post("/api/events/feishu", headers=CONNECTOR, json=ev)).json()["duplicate"] is True
    confirm = {"event_id": "fs-confirm", "kind": "card_action", "chat_id": "oc_test", "sender_open_id": "ou_sender",
               "action": {"value": {"action": "create_from_message", "payload": {"message_id": "om_1", "chat_id": "oc_test"}}}}
    tid = (await client.post("/api/events/feishu", headers=CONNECTOR, json=confirm)).json()["task_id"]
    again = (await client.post("/api/events/feishu", headers=CONNECTOR, json={**confirm, "event_id": "fs-confirm-again"})).json()
    assert again["task_id"] == tid
    admin_tok, _ = await login(client, "管理员甲", admin=True)
    d = (await client.get(f"/api/tasks/{tid}", headers=auth(admin_tok))).json()
    assert d["source"] == "feishu" and d["suggested_assignee"]["name"] == "戴夫"
    assert d["title"].startswith("帮忙修复首页白屏")
    # 被推荐人在卡片上点“接受”
    act = {"event_id": "fs-2", "kind": "card_action", "chat_id": "oc_test", "message_id": "om_card", "sender_open_id": "ou_dev",
           "action": {"value": {"acp": 1, "action": "accept", "task_id": tid}, "operator_open_id": "ou_dev"}}
    r = await client.post("/api/events/feishu", headers=CONNECTOR, json=act)
    assert r.json()["toast"]["type"] == "success", r.text
    d = (await client.get(f"/api/tasks/{tid}", headers=auth(admin_tok))).json()
    assert d["state"] == "working" and d["assignee"]["name"] == "戴夫"
    # 没 @ 机器人但开启了 all 模式：疑似需求 → 只发确认卡，不建单
    ev3 = {"event_id": "fs-3", "kind": "message", "chat_id": "oc_test", "chat_type": "group", "message_id": "om_3", "sender_open_id": "ou_x",
           "text": "支付页需要支持鸿蒙", "mentions": []}
    r = await client.post("/api/events/feishu", headers=CONNECTOR, json=ev3)
    assert r.json().get("confirm") is True
    # 问答不建单
    ev4 = {"event_id": "fs-4", "kind": "message", "chat_id": "oc_test", "chat_type": "group", "message_id": "om_4", "sender_open_id": "ou_x",
           "text": f"@_user_1 ACP-{tid} 进度？", "mentions": [{"open_id": "ou_bot", "name": "ACP", "is_bot": True}]}
    r = await client.post("/api/events/feishu", headers=CONNECTOR, json=ev4)
    assert r.json().get("qa") is True


async def test_feishu_questions_and_explicit_intake(client):
    from sqlalchemy import select

    from acp.db import session_scope
    from acp.models import Outbox

    token, _ = await login(client, "受理检查")
    async def count():
        return (await client.get("/api/tasks", headers=auth(token))).json()["total"]

    before = await count()
    base = {"kind": "message", "chat_type": "group", "chat_id": "oc_faq", "sender_open_id": "ou_faq",
            "mentions": [{"is_bot": True, "open_id": "ou_bot"}]}
    async def send(key, text, **extra):
        ev = {**base, "event_id": f"faq-{key}", "message_id": f"om_faq_{key}", "text": text, **extra}
        response = await client.post("/api/events/feishu", headers=CONNECTOR, json=ev)
        assert response.status_code == 200, response.text
        return response.json()

    for i, text in enumerate(["ACP测试是什么", "acp是干嘛用的", "你能做什么", "建单 是什么意思", "建单 能不能取消", "帮助", "你好"]):
        assert (await send(i, text)).get("help") is True
    async with session_scope() as db:
        reply = (await db.scalars(select(Outbox).where(Outbox.payload["reply_to_message_id"].astext == "om_faq_0"))).one()
        assert reply.kind == "feishu.text" and "跟踪代码评审" in reply.payload["text"]
    assert (await send("qa", "现在支持哪些开发机", chat_type="p2p")).get("qa") is True
    assert (await send("quiet", "ACP 支持哪些平台", mentions=[])).get("ignored") is True
    assert (await send("empty", "建单：")).get("help") is True
    assert (await send("request", "帮我修复页面")).get("confirm") is True
    act = {"kind": "card_action", "chat_id": "oc_faq", "sender_open_id": "ou_faq",
           "action": {"value": {"action": "ignore", "payload": {"message_id": "om_faq_request", "chat_id": "oc_faq"}}}}
    await client.post("/api/events/feishu", headers=CONNECTOR, json={**act, "event_id": "faq-ignore"})
    act["action"]["value"]["action"] = "create_from_message"
    assert (await client.post("/api/events/feishu", headers=CONNECTOR, json={**act, "event_id": "faq-stale"})).json()["ignored"]
    assert await count() == before
    explicit, retry = await asyncio.gather(send("new", "建单：修复状态显示"), send("new", "建单：修复状态显示"))
    assert explicit["task_id"] == retry["task_id"] and await count() == before + 1


async def test_permissions(client):
    a_tok, _ = await login(client, "成员甲")
    b_tok, _ = await login(client, "成员乙")
    tid = (await client.post("/api/tasks", headers=auth(a_tok), json={"title": "权限测试"})).json()["id"]
    assert (await client.patch(f"/api/tasks/{tid}", headers=auth(b_tok), json={"title": "改"})).status_code == 403
    assert (await client.post(f"/api/tasks/{tid}/cancel", headers=auth(b_tok))).status_code == 403
    assert (await client.post("/api/events/feishu", headers=auth(a_tok), json={})).status_code == 403
    assert (await client.put("/api/settings", headers=auth(a_tok), json={})).status_code == 403
    assert (await client.post(f"/api/tasks/{tid}/cancel", headers=auth(a_tok))).json()["state"] == "canceled"
    assert (await client.post(f"/api/tasks/{tid}/claim", headers=auth(b_tok))).status_code == 409


async def test_help_subtask_limits(client):
    tok, me = await login(client, "求助者")
    helper_tok, helper = await login(client, "帮手")
    root = (await client.post("/api/tasks", headers=auth(tok), json={"title": "根任务", "repos": ["server/api"]})).json()
    await client.post(f"/api/tasks/{root['id']}/claim", headers=auth(tok))
    agent = (await client.post("/api/agents/register", headers=auth(tok), json={"name": "box", "kind": "echo"})).json()
    tk = (await client.post(f"/api/tasks/{root['id']}/agent-token", headers=auth(tok), json={"agent_id": agent["id"]})).json()
    agent_tok = tk["token"]
    # Agent 令牌不能直接建普通任务、不能认领
    assert (await client.post("/api/tasks", headers=auth(agent_tok), json={"title": "x"})).status_code == 403

    def ask(parent_id, title, token, target=None):
        meta = {"skill": "create_task", "parent_id": parent_id, "title": title, "description": title}
        if target:
            meta["target_member_id"] = target
        return client.post("/a2a", headers=auth(token), json={"jsonrpc": "2.0", "id": 9, "method": "SendMessage", "params": {"message": {"role": "agent", "parts": [], "metadata": meta}}})

    r = await ask(root["id"], "帮我加个接口", agent_tok, helper["id"])
    child = r.json()["result"]
    assert child["status"]["state"] == "submitted"
    d = (await client.get(f"/api/tasks/{child['id']}", headers=auth(tok))).json()
    assert d["type"] == "help" and d["suggested_assignee"]["id"] == helper["id"] and d["parent_id"] == root["id"]
    # 不能向自己求助
    r = await ask(root["id"], "问自己", agent_tok, me["id"])
    assert r.json()["result"]["status"]["state"] == "rejected"
    # 每个根任务最多 5 个子任务
    states = []
    for i in range(6):
        states.append((await ask(root["id"], f"求助{i}", agent_tok)).json()["result"]["status"]["state"])
    assert "rejected" in states


async def test_mcp_tools(client):
    tok, me = await login(client, "MCP 用户")
    tid = (await client.post("/api/tasks", headers=auth(tok), json={"title": "MCP 测试任务"})).json()["id"]
    h = {**auth(tok), "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}}
    r = await client.post("/mcp", headers=h, json=init)
    assert r.status_code == 200, r.text
    r = await client.post("/mcp", headers=h, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    names = {t["name"] for t in r.json()["result"]["tools"]}
    assert {"list_tasks", "get_task", "claim_task", "update_task", "post_message", "ask_agent", "request_approval", "list_agents"} <= names
    r = await client.post("/mcp", headers=h, json={"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "claim_task", "arguments": {"task_id": tid}}})
    content = r.json()["result"]
    payload = content.get("structuredContent") or json.loads(content["content"][0]["text"])
    assert payload["ok"] is True and payload["task"]["state"] == "working"
    r = await client.post("/mcp", headers={**h, "Authorization": "Bearer bad"}, json={"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "list_tasks", "arguments": {}}})
    result = r.json()["result"]
    payload = result.get("structuredContent") or json.loads(result["content"][0]["text"])
    assert payload["error"] == "unauthorized" and result["isError"] is True


async def test_device_flow(client):
    r = await client.post("/auth/device/code", json={"client": "acp-link", "hostname": "test-pc"})
    dc = r.json()
    assert dc["verification_uri_complete"].endswith(dc["user_code"])
    r = await client.post("/auth/device/token", json={"device_code": dc["device_code"]})
    assert r.status_code == 400 and r.json()["error"] == "authorization_pending"
    tok, _ = await login(client, "设备用户")
    r = await client.post("/api/device/approve", headers=auth(tok), json={"user_code": dc["user_code"]})
    assert r.json()["ok"] is True
    r = await client.post("/auth/device/token", json={"device_code": dc["device_code"]})
    assert r.status_code == 200 and r.json()["access_token"]
    r = await client.post("/auth/device/token", json={"device_code": dc["device_code"]})
    assert r.status_code == 400


async def test_overview_sources_settings(client):
    tok, _ = await login(client, "看板用户", admin=True)
    ov = (await client.get("/api/overview", headers=auth(tok))).json()
    assert set(ov) >= {"counts", "kpis", "trend", "by_source", "by_assignee", "by_repo", "recent", "attention"}
    assert len(ov["trend"]) == 14
    src = (await client.get("/api/sources", headers=auth(tok))).json()["items"]
    assert {s["source"] for s in src} == {"feishu", "gitlab", "board", "agent", "system"}
    ev = (await client.get("/api/sources/events?source=feishu", headers=auth(tok))).json()
    assert ev["total"] >= 1
    st = (await client.put("/api/settings", headers=auth(tok), json={"autonomy": {"intake": "L1"}, "intake_modes": ["at_mention"]})).json()
    assert st["autonomy"]["intake"] == "L1" and st["intake_modes"] == ["at_mention"]
    members = (await client.get("/api/members", headers=auth(tok))).json()
    assert members["total"] >= 3
    lst = (await client.get("/api/tasks?state=working,completed&sort=-created_at", headers=auth(tok))).json()
    assert all(t["state"] in ("working", "completed") for t in lst["items"])


async def test_overview_excludes_examples_on_the_board(client):
    from acp.db import session_scope
    from acp.kernel.tasks import create_task
    from acp.security import Principal

    async with session_scope() as db:
        example = await create_task(db, Principal(type="system", name="回归"), title="榜单示例",
                                    repos=["demo/board-filter"], is_demo=True, announce=False, run_intake=False)
        example_id = example.id
        await db.commit()
    token, _ = await login(client, "榜单检查")
    async def get(query):
        return (await client.get(query, headers=auth(token))).json()
    real = await get("/api/overview?demo=false")
    examples = await get("/api/overview?demo=true")
    combined = await get("/api/overview")
    assert real["counts"]["total"] == (await get("/api/tasks?demo=false"))["total"]
    assert real["counts"]["total"] + examples["counts"]["total"] == combined["counts"]["total"]
    assert any(r["repo"] == "demo/board-filter" for r in examples["by_repo"])
    assert all(r["repo"] != "demo/board-filter" for r in real["by_repo"])
    assert all(item["task_id"] != example_id for item in real["recent"])


async def test_sse_task_stream(client, server):
    tok, _ = await login(client, "流用户")
    tid = (await client.post("/api/tasks", headers=auth(tok), json={"title": "SSE 测试"})).json()["id"]
    got = []
    async with httpx.AsyncClient(base_url=server, timeout=None) as c:
        async with c.stream("GET", f"/api/tasks/{tid}/stream?access_token={tok}") as resp:
            assert resp.status_code == 200

            async def poke():
                await asyncio.sleep(0.3)
                await client.post(f"/api/tasks/{tid}/messages", headers=auth(tok), json={"content": "你好"})

            asyncio.create_task(poke())
            async for line in resp.aiter_lines():
                if line.startswith("event: "):
                    got.append(line[7:])
                if got.count("timeline") >= 1:
                    break
    assert got[0] == "task" and "timeline" in got


async def test_personal_access_token(client):
    tok, _ = await login(client, "PAT 用户")
    r = await client.post("/api/me/tokens", headers=auth(tok), json={"name": "我的 Claude Code", "days": 30})
    assert r.status_code == 200, r.text
    pat = r.json()
    assert pat["mcp_url"].endswith("/mcp")
    assert (await client.get("/api/me", headers=auth(pat["token"]))).status_code == 200
    items = (await client.get("/api/me/tokens", headers=auth(tok))).json()["items"]
    assert items[0]["name"] == "我的 Claude Code"
    assert (await client.delete(f"/api/me/tokens/{pat['id']}", headers=auth(tok))).json()["ok"] is True
    assert (await client.get("/api/me", headers=auth(pat["token"]))).status_code == 401


async def test_agent_capacity_freed_after_artifact(client, server):
    """Agent 交了 MR 后任务仍在进行中（等 CI），但不再占并发名额：排队的下一个任务立即派出。"""
    tok, _ = await login(client, "carol")
    r = await client.post("/api/agents/register", headers=auth(tok), json={"name": "carol-pc", "kind": "echo", "max_concurrency": 1})
    agent = r.json()
    queue: asyncio.Queue = asyncio.Queue()
    body = {"jsonrpc": "2.0", "id": 1, "method": "SendStreamingMessage", "params": {"message": {"role": "user", "messageId": "m-cap", "parts": [{"kind": "text", "text": "subscribe"}], "metadata": {"skill": "subscribe_assignments", "agent_id": agent["id"]}}}}
    sub_client = httpx.AsyncClient(base_url=server, timeout=None)
    stream_ctx = sub_client.stream("POST", "/a2a", json=body, headers=auth(tok))
    resp = await stream_ctx.__aenter__()
    reader = asyncio.create_task(_read_sse(resp, queue))
    await asyncio.wait_for(queue.get(), timeout=5)
    try:
        ids = []
        for title in ("容量测试 A", "容量测试 B"):
            t = (await client.post("/api/tasks", headers=auth(tok), json={"title": title, "repos": ["x/y"]})).json()
            ids.append(t["id"])
            assert (await client.post(f"/api/tasks/{t['id']}/claim", headers=auth(tok))).json()["state"] == "working"
        a, b = ids
        first = await _next_assignment(queue)
        assert first["task"]["id"] == a
        blocked = False
        try:
            await _next_assignment(queue, timeout=1.5)
        except TimeoutError:
            blocked = True
        assert blocked, "名额只有 1 个时不应同时派出第二个任务"

        req = {"jsonrpc": "2.0", "id": 2, "method": "SendMessage", "params": {"message": {"role": "agent", "messageId": uuid.uuid4().hex, "parts": [{"kind": "text", "text": "已提交"}], "metadata": {"skill": "report_progress", "task_id": a, "agent_id": agent["id"], "kind": "artifact", "artifacts": [{"repo": "x/y", "branch": f"acp/{a}-cap", "url": "https://gitlab.example.com/x/y/-/merge_requests/3"}]}}}}
        assert "result" in (await client.post("/a2a", json=req, headers=auth(tok))).json()
        second = await _next_assignment(queue)
        assert second["task"]["id"] == b
        d = (await client.get(f"/api/tasks/{a}", headers=auth(tok))).json()
        assert d["state"] == "working" and "agent.finished" in [i["type"] for i in d["timeline"]]
        agents = (await client.get("/api/agents", headers=auth(tok))).json()
        mine = next(x for x in (agents.get("items", agents) if isinstance(agents, dict) else agents) if x["id"] == agent["id"])
        assert mine["current_task_ids"] == [b]
    finally:
        reader.cancel()
        await stream_ctx.__aexit__(None, None, None)
        await sub_client.aclose()


async def test_edit_diff_and_stale_suggestion(client):
    """编辑只记录真正变了的字段；建单整理建议写成人能读的话；任务结束后旧建议不能再采纳。"""
    admin, _ = await login(client, "设置管理员", admin=True)
    await client.put("/api/settings", headers=auth(admin), json={"autonomy": {"intake": "L0"}})  # 别的用例可能调高过
    tok, _ = await login(client, "dora")
    r = await client.post("/api/tasks", headers=auth(tok), json={"title": "购物车补接口测试", "repos": ["shop/cart"], "priority": "normal"})
    task = r.json()
    tid = task["id"]
    body = {"title": task["title"], "description": task["description"], "repos": task["repos"], "priority": task["priority"], "labels": ["点测"]}
    r = await client.patch(f"/api/tasks/{tid}", headers=auth(tok), json=body)
    assert r.status_code == 200, r.text
    timeline = (await client.get(f"/api/tasks/{tid}", headers=auth(tok))).json()["timeline"]
    edits = [i["text"] for i in timeline if i.get("type") == "task.edited"]
    assert edits and edits[-1].endswith("修改了标签"), edits

    sugg = None
    for _ in range(50):  # 建单整理在后台跑
        detail = (await client.get(f"/api/tasks/{tid}", headers=auth(tok))).json()
        sugg = next((s for s in detail["suggestions"] if s["scenario"] == "intake"), None)
        if sugg:
            break
        await asyncio.sleep(0.1)
    assert sugg is not None
    assert sugg["summary"] == "整理建议：技能 backend、testing", sugg["summary"]

    await client.post(f"/api/tasks/{tid}/cancel", headers=auth(tok), json={})
    r = await client.post(f"/api/suggestions/{sugg['id']}/accept", headers=auth(tok))
    assert r.status_code == 409 and "已失效" in r.json()["message"], r.text
    r = await client.post(f"/api/suggestions/{sugg['id']}/reject", headers=auth(tok))
    assert r.status_code == 200 and r.json()["status"] == "rejected"
