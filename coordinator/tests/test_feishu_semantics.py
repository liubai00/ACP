import asyncio
import json

from sqlalchemy import func, select

from acp.agent import llm
from acp.db import session_scope
from acp.models import InboundEvent, Outbox, Task

from .conftest import CONNECTOR


async def test_semantic_inbox_through_feishu_webhook(client, monkeypatch):
    """经过真实入站、后台处理和数据库，模型替身只提供决策。"""
    calls = []
    instructions = {
        "周五给销售的报价单里也放上部门列，好吗？": {"intent": "create", "text": "报价单增加部门列"},
        "建单：这两个字出现在教程里有什么用？": {"intent": "reply", "text": "可以直接向 ACP 交办具体工作。"},
        "先别立项，刚刚只是举例": {"intent": "reply", "text": "明白，这只是一个例子。"},
        "安排一下吧": {"intent": "clarify", "text": "需要团队交付什么？"},
        "就是上次提的那件事": {"intent": "clarify", "text": "具体是哪件事？"},
        "销售版的报价单，按季度过滤": {"intent": "create", "text": "销售报价单按季度筛选", "continuation": True},
        "周五要交季报，加上成本列": {"intent": "create", "text": "季报增加成本列"},
        "查一下我的任务": {"intent": "lookup"},
        "我这里有件事": {"intent": "unrecognized", "text": "意外结果"},
    }

    async def model(system, user, **_):
        data = json.loads(user)
        if "当前消息" not in data:  # 建单后的整理建议是另一场景
            return None
        calls.append(data)
        return instructions[data["当前消息"]]

    async def answer(system, user, **_):
        assert "按状态计数" in json.loads(user)["数据"]
        return "这是查询任务库得到的回复"

    monkeypatch.setattr(llm, "enabled", lambda: True)
    monkeypatch.setattr(llm, "chat_json", model)
    monkeypatch.setattr(llm, "chat", answer)
    base = {"kind": "message", "chat_type": "group", "chat_id": "oc_semantics", "sender_open_id": "ou_semantics",
            "mentions": [{"is_bot": True}]}

    async def send(key, message, **extra):
        ev = {**base, "event_id": "sem-" + key, "message_id": "om_sem_" + key, "text": message, **extra}
        r = await client.post("/api/events/feishu", headers=CONNECTOR, json=ev)
        r.raise_for_status()
        return r.json()

    async def outcome(key):
        for _ in range(100):
            async with session_scope() as db:
                row = await db.scalar(select(InboundEvent).where(InboundEvent.external_id == "sem-" + key))
                if row and row.status != "pending":
                    return row
            await asyncio.sleep(0.03)
        raise AssertionError(f"事件 {key} 未处理")

    async def task_count():
        async with session_scope() as db:
            return await db.scalar(select(func.count()).select_from(Task))

    before = await task_count()
    message = "周五给销售的报价单里也放上部门列，好吗？"
    first, second = await asyncio.gather(send("create", message), send("create", message))
    assert any(v.get("queued") for v in (first, second)) and any(v.get("duplicate") for v in (first, second))
    created = await outcome("create")
    assert created.task_id and created.payload["intent"] == "create"
    assert (await send("redelivery", message, message_id="om_sem_create"))["duplicate"]
    async with session_scope() as db:
        task = await db.get(Task, created.task_id)
        assert task.title == "报价单增加部门列" and task.description == message and task.source == "feishu"
        assert await db.scalar(select(Outbox.id).where(Outbox.task_id == task.id, Outbox.kind == "feishu.card"))

    for key, sample in (("consult", "建单：这两个字出现在教程里有什么用？"), ("negate", "先别立项，刚刚只是举例")):
        assert (await send(key, sample))["queued"]
        assert (await outcome(key)).kind == "message.reply"
    assert (await send("missing", "安排一下吧"))["queued"]
    assert (await outcome("missing")).kind == "message.clarify"
    assert (await send("other", "就是上次提的那件事", sender_open_id="ou_another"))["queued"]
    assert (await outcome("other")).kind == "message.clarify" and calls[-1]["上一轮"] is None
    assert (await send("follow", "销售版的报价单，按季度过滤"))["queued"]
    follow = await outcome("follow")
    assert follow.task_id and calls[-1]["上一轮"]["追问"] == "需要团队交付什么？"
    async with session_scope() as db:
        task = await db.get(Task, follow.task_id)
        assert "安排一下吧" in task.description and "销售版的报价单，按季度过滤" in task.description
    assert (await send("ambient", "周五要交季报，加上成本列", mentions=[]))["queued"]
    assert (await outcome("ambient")).kind == "message.suspected"
    assert (await send("query", "查一下我的任务", chat_type="p2p", mentions=[]))["queued"]
    assert (await outcome("query")).kind == "message.qa"
    assert (await send("invalid", "我这里有件事"))["queued"]
    assert (await outcome("invalid")).kind == "message.intent_failed"
    assert (await send("bot", "安排一下吧", sender_type="app"))["ignored"]
    assert len(calls) == 9 and await task_count() == before + 2
