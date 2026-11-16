"""示例数据：全部标记 is_demo，acp-admin purge-demo 一键删除。用于部署后预览任务榜。"""

from __future__ import annotations

import random
from datetime import timedelta

from sqlalchemy import select

from .db import session_scope
from .models import (
    Agent,
    Approval,
    Event,
    InboundEvent,
    Member,
    MergeRequest,
    Message,
    Suggestion,
    Task,
    utcnow,
)

PEOPLE = [
    ("示例·林晓", ["member", "developer", "reviewer"], "客户端组"),
    ("示例·周航", ["member", "developer"], "服务端组"),
    ("示例·陈墨", ["member", "developer"], "客户端组"),
    ("示例·许宁", ["member", "developer", "reviewer"], "服务端组"),
    ("示例·王岚", ["member"], "产品组"),
]

AGENTS = [
    (0, "林晓的 MacBook", "claude-code", ["harmonyos", "frontend"], ["mobile/lh-zz", "web/console"]),
    (1, "周航的 ThinkPad", "codex", ["backend", "database"], ["server/powerx-server"]),
    (2, "陈墨的 Mac mini", "claude-code", ["ios", "android"], ["mobile/lh-zz"]),
    (3, "许宁的工作站", "claude-code", ["backend", "devops"], ["server/powerx-server", "infra/deploy"]),
]

TASKS = [
    ("鸿蒙版登录页适配深色模式", "completed", ["mobile/lh-zz"], "high", 0, "feishu"),
    ("订单列表接口支持按状态筛选", "completed", ["server/powerx-server"], "normal", 1, "feishu"),
    ("鸿蒙适配：客户端与后端同时改支付回调", "auth-required", ["mobile/lh-zz", "server/powerx-server"], "urgent", 0, "feishu"),
    ("控制台导出 CSV 中文乱码", "working", ["web/console"], "normal", 0, "board"),
    ("用户中心头像上传失败", "input-required", ["mobile/lh-zz"], "high", 2, "feishu"),
    ("网关限流阈值改成可配置", "working", ["server/powerx-server"], "normal", 3, "agent"),
    ("首页埋点补齐", "submitted", ["web/console"], "low", None, "feishu"),
    ("iOS 推送证书即将过期", "submitted", ["mobile/lh-zz"], "urgent", None, "board"),
    ("数据库慢查询优化：订单统计", "failed", ["server/powerx-server"], "normal", 1, "feishu"),
    ("灰度发布脚本支持回滚", "completed", ["infra/deploy"], "normal", 3, "board"),
    ("客服消息未读数不同步", "working", ["mobile/lh-zz", "server/powerx-server"], "high", 2, "feishu"),
    ("隐私协议弹窗文案更新", "canceled", ["mobile/lh-zz"], "low", None, "feishu"),
]


async def seed() -> int:
    rnd = random.Random(42)
    now = utcnow()
    async with session_scope() as db:
        exists = (await db.execute(select(Task.id).where(Task.is_demo.is_(True)).limit(1))).scalar_one_or_none()
        if exists:
            return 0
        members = []
        for name, roles, team in PEOPLE:
            m = Member(name=name, roles=roles, team=team, is_demo=True, created_at=now - timedelta(days=20), last_login_at=now - timedelta(hours=rnd.randint(1, 30)))
            db.add(m)
            members.append(m)
        await db.flush()
        agents = []
        for idx, name, kind, skills, repos in AGENTS:
            a = Agent(member_id=members[idx].id, name=name, kind=kind, version="0.1.0", host=name, skills=skills, repos=repos,
                      status="online" if idx != 2 else "offline", last_heartbeat_at=now - timedelta(seconds=10 if idx != 2 else 7200),
                      max_concurrency=1, is_demo=True, created_at=now - timedelta(days=15))
            db.add(a)
            agents.append(a)
        await db.flush()
        count = 0
        for i, (title, state, repos, prio, who, source) in enumerate(TASKS):
            created = now - timedelta(days=13 - i, hours=rnd.randint(0, 8))
            creator = members[4] if source == "feishu" else members[(i + 1) % 4]
            t = Task(title=title, description=f"{title}。\n\n验收：功能可用、有单测、不影响现有流程。", state=state, priority=prio, source=source,
                     repos=repos, skills=[], labels=["示例"], creator_id=creator.id, assignee_id=members[who].id if who is not None else None,
                     assignee_agent_id=next((a.id for a in agents if who is not None and a.member_id == members[who].id), None),
                     is_demo=True, created_at=created, updated_at=created, state_changed_at=created, last_activity_at=created,
                     agent_acked=state in ("working", "input-required", "auth-required"))
            if state == "submitted":
                t.suggested_assignee_id = members[(i + 2) % 4].id
            db.add(t)
            await db.flush()
            t.root_id = t.id
            count += 1
            at = created

            def ev(etype, text, actor="system", name="系统", minutes=5, data=None, _t=t):
                nonlocal at
                at = at + timedelta(minutes=minutes)
                db.add(Event(task_id=_t.id, type=etype, actor_type=actor, actor_name=name, text=text, data=data, created_at=at))

            def msg(text, kind="progress", sender="agent", name="Agent", minutes=7, _t=t):
                nonlocal at
                at = at + timedelta(minutes=minutes)
                db.add(Message(task_id=_t.id, sender_type=sender, sender_name=name, kind=kind, content=text, created_at=at))

            src = {"feishu": "飞书", "board": "任务榜", "agent": "Agent"}[source]
            ev("task.created", f"{creator.name} 创建了需求（来源：{src}）", "member", creator.name, 0)
            if source == "feishu":
                db.add(InboundEvent(source="feishu", kind="message.task", external_id=f"demo-{t.id}", summary=title, task_id=t.id, created_at=created))
            if state == "submitted":
                ev("task.dispatched", f"推荐由 {members[(i + 2) % 4].name} 处理（熟悉仓库 {repos[0]}，Agent 在线）")
                continue
            if state == "canceled":
                ev("state.changed", "状态：待认领 → 已取消（需求合并到其他任务）", "member", creator.name, 60, {"from": "submitted", "to": "canceled"})
                t.closed_at = at
                t.state_changed_at = at
                continue
            owner = members[who]
            agent = next(a for a in agents if a.member_id == owner.id)
            ev("task.claimed", f"{owner.name} 认领了任务", "member", owner.name, 20)
            ev("state.changed", "状态：待认领 → 进行中", "member", owner.name, 0, {"from": "submitted", "to": "working"})
            ev("agent.assigned", f"派给 Agent「{agent.name}」执行", minutes=1)
            ev("agent.acked", f"Agent「{agent.name}」开始执行", "agent", agent.name, 1)
            msg(f"已在 {', '.join(repos)} 准备任务分支 acp/{t.id}-demo，开始阅读相关代码。", name=agent.name)
            msg("定位到相关模块，正在修改并补充单元测试。", name=agent.name, minutes=12)
            if state == "input-required":
                msg("头像上传接口返回 413，需要确认：上传大小上限是否从 2MB 调到 5MB？", kind="question", name=agent.name, minutes=10)
                ev("state.changed", "状态：进行中 → 待补充（Agent 请求补充信息）", "agent", agent.name, 0, {"from": "working", "to": "input-required"})
                db.add(Suggestion(task_id=t.id, scenario="input_answer", level="L0", status="proposed", engine="llm",
                                  summary="建议回答：调到 5MB（依据：ACP-2 的需求描述里写明了“图片上限 5MB”）",
                                  payload={"actions": [{"op": "answer_input", "task_id": t.id, "text": "调到 5MB"}]}, created_at=at))
                t.state_changed_at = at
                continue
            for r_i, repo in enumerate(repos):
                iid = 100 + i * 3 + r_i
                ev("git.pushed", f"推送了 {repo} 的分支 acp/{t.id}-demo", "connector", "GitLab", 30)
                mr_state = "merged" if state == "completed" else "opened"
                pipe = {"completed": "success", "auth-required": "success", "failed": "failed", "working": "running"}.get(state, "running")
                db.add(MergeRequest(task_id=t.id, repo=repo, branch=f"acp/{t.id}-demo", iid=iid, url=f"https://gitlab.example.com/{repo}/-/merge_requests/{iid}",
                                    state=mr_state, pipeline_status=pipe, updated_at=at))
                ev("mr.opened", f"创建/更新了 MR !{iid}（{repo}）", "connector", "GitLab", 2, {"iid": iid, "repo": repo})
                if state != "working":
                    ev(f"ci.{pipe}", f"CI {'通过' if pipe == 'success' else '失败'}（{repo}）", "connector", "GitLab", 15)
            if state == "working":
                t.state_changed_at = created + timedelta(minutes=30)
                continue
            if state == "failed":
                msg("CI 失败（第 3 次）：test/unit（script_failure）", kind="ci", sender="system", name="系统", minutes=2)
                db.add(Suggestion(task_id=t.id, scenario="ci_triage", level="L0", status="proposed", engine="rules",
                                  summary="CI 失败归类：需人介入。已连续失败多次，建议负责人介入", payload={"actions": []}, created_at=at))
                ev("state.changed", "状态：进行中 → 失败（CI 连续失败 3 次）", minutes=1, data={"from": "working", "to": "failed"})
                t.closed_at = at
                t.state_changed_at = at
                continue
            appr = Approval(task_id=t.id, gate="merge", status="pending" if state == "auth-required" else "approved", note="CI 全部通过，等待评审",
                            created_at=at + timedelta(minutes=1))
            db.add(appr)
            ev("approval.requested", "请求合并前审批：CI 全部通过，等待评审", minutes=1)
            ev("state.changed", "状态：进行中 → 待审批（合并前审批）", minutes=0, data={"from": "working", "to": "auth-required"})
            if state == "auth-required":
                t.state_changed_at = at
                continue
            reviewer = members[3] if who != 3 else members[0]
            appr.decided_by_id = reviewer.id
            appr.decided_at = at + timedelta(minutes=40)
            ev("approval.approved", f"{reviewer.name} 同意", "member", reviewer.name, 40)
            ev("mr.merged", "合并了 MR", "connector", "GitLab", 10)
            ev("state.changed", "状态：待审批 → 已完成（相关 MR 已全部合并）", minutes=1, data={"from": "auth-required", "to": "completed"})
            t.closed_at = at
            t.state_changed_at = at
        # 一个求助子任务
        parent = (await db.execute(select(Task).where(Task.is_demo.is_(True), Task.title.like("客服消息%")))).scalar_one()
        child = Task(title="后端补一个未读数查询接口", description="客户端需要 GET /im/unread 返回各会话未读数。", type="help", state="working",
                     priority="high", source="agent", repos=["server/powerx-server"], creator_id=parent.assignee_id, assignee_id=members[1].id,
                     assignee_agent_id=agents[1].id, parent_id=parent.id, root_id=parent.id, depth=1, is_demo=True, agent_acked=True,
                     created_at=now - timedelta(hours=3), updated_at=now - timedelta(hours=2), state_changed_at=now - timedelta(hours=2),
                     last_activity_at=now - timedelta(hours=2), labels=["示例"])
        db.add(child)
        await db.flush()
        db.add(Event(task_id=child.id, type="task.created", actor_type="agent", actor_name=agents[2].name, text="陈墨的 Agent 发起求助（来源：Agent）", created_at=child.created_at))
        db.add(Event(task_id=parent.id, type="help.created", actor_type="agent", actor_name=agents[2].name, text=f"发起求助 {child.key}「{child.title}」", created_at=child.created_at))
        db.add(Event(task_id=child.id, type="help.auto_accepted", actor_type="system", actor_name="系统", text="示例·周航 的 Agent 设置了自动接受本团队求助", created_at=child.created_at + timedelta(minutes=1)))
        return count + 1
