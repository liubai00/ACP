"""协调 Agent 的六个触发场景。每次触发是一次独立调用，结果写成建议，按自主等级落地。"""

from __future__ import annotations

import json
import logging
import re
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select

from ..db import session_scope
from ..kernel import hooks, notify
from ..kernel import states as S
from ..kernel.core import commit, get_member
from ..kernel.dispatch import rank_candidates
from ..kernel.tasks import autonomy
from ..models import Agent, Member, Message, Suggestion, Task, utcnow
from . import llm
from .suggestions import propose

log = logging.getLogger("acp.agent")

REPO_RE = re.compile(r"\b([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)?)\b")
SKILL_WORDS = {
    "前端": "frontend", "后端": "backend", "接口": "backend", "鸿蒙": "harmonyos", "HarmonyOS": "harmonyos",
    "iOS": "ios", "Android": "android", "安卓": "android", "测试": "testing", "数据库": "database",
    "运维": "devops", "部署": "devops", "小程序": "miniprogram", "设计": "design",
}

_FIELD_LABELS = {"title": "标题", "description": "描述", "repos": "仓库", "skills": "技能", "priority": "优先级"}


def _describe_fields(fields: dict[str, Any]) -> str:
    """把建议改动的字段写成人能读的一句话，例如“技能 backend、testing；优先级 高”。"""
    out = []
    for k, v in fields.items():
        if isinstance(v, (list, tuple)):
            text = "、".join(str(x) for x in v)
        elif k == "priority":
            text = S.PRIORITY_LABELS.get(v, str(v))
        else:
            text = str(v)
            if len(text) > 40:
                text = text[:40] + "…"
        out.append(f"{_FIELD_LABELS.get(k, k)} {text}")
    return "；".join(out)


def _heuristic_intake(task: Task) -> dict[str, Any]:
    text = f"{task.title}\n{task.description}"
    fields: dict[str, Any] = {}
    repos = [r for r in REPO_RE.findall(text) if not r.startswith(("http", "www")) and "." not in r.split("/")[0][:1]]
    if repos and not task.repos:
        fields["repos"] = repos[:5]
    skills = sorted({v for k, v in SKILL_WORDS.items() if k.lower() in text.lower()})
    if skills and not task.skills:
        fields["skills"] = skills
    if task.priority == "normal":
        if any(w in text for w in ("紧急", "线上故障", "马上", "立刻")):
            fields["priority"] = "urgent"
        elif any(w in text for w in ("尽快", "今天", "优先")):
            fields["priority"] = "high"
    return fields


async def run_intake(task_id: int) -> None:
    async with session_scope() as db:
        task = await db.get(Task, task_id)
        if task is None or task.state != S.SUBMITTED:
            return
        level = (await autonomy(db)).get("intake", "L0")
        if level == "off":
            return
        members = (await db.execute(select(Member).where(Member.is_active.is_(True), Member.is_demo.is_(False)))).scalars().all()
        agents = (await db.execute(select(Agent))).scalars().all()
        roster = [
            {"id": str(m.id), "name": m.name, "skills": sorted({s for a in agents if a.member_id == m.id for s in a.skills or []}),
             "repos": sorted({r for a in agents if a.member_id == m.id for r in a.repos or []})}
            for m in members
        ][:40]
        engine = "rules"
        fields = _heuristic_intake(task)
        member_id = None
        reason = ""
        if llm.enabled():
            data = await llm.chat_json(
                llm.SYSTEM_PREAMBLE + "你负责把一句话需求整理成结构化任务。",
                json.dumps(
                    {
                        "需求原文": task.description or task.title,
                        "当前标题": task.title,
                        "团队成员与其 Agent 的技能、熟悉仓库": roster,
                        "输出格式": {
                            "title": "≤30 字标题",
                            "description": "补全后的描述，保留原意，列出验收要点",
                            "repos": ["group/project"],
                            "skills": ["frontend|backend|..."],
                            "priority": "low|normal|high|urgent",
                            "member_id": "推荐负责人 id，没有把握就 null",
                            "reason": "推荐理由",
                        },
                    },
                    ensure_ascii=False,
                ),
            )
            if data:
                engine = "llm"
                for k in ("title", "description", "repos", "skills", "priority"):
                    v = data.get(k)
                    if v and v != getattr(task, k):
                        fields[k] = v
                member_id = data.get("member_id")
                reason = data.get("reason") or ""
        actions: list[dict[str, Any]] = []
        parts = []
        if fields:
            actions.append({"op": "update_fields", "task_id": task.id, "fields": fields})
            parts.append(_describe_fields(fields))
        if member_id and not task.suggested_assignee_id:
            m = next((x for x in members if str(x.id) == member_id), None)
            if m:
                actions.append({"op": "offer", "task_id": task.id, "member_id": member_id, "reason": reason or "协调 Agent 推荐"})
                parts.append(f"推荐 {m.name}：{reason}")
        if not actions:
            return
        creator = await get_member(db, task.creator_id)
        await propose(db, task=task, scenario="intake", level=level, summary="整理建议：" + "；".join(parts), actions=actions, engine=engine, notify_member=creator)
        await commit(db)


async def run_input_answer(task_id: int) -> None:
    """Agent 卡在待补充：先从任务历史和相关 MR 找答案，找不到再问人。只在有模型时运行。"""
    if not llm.enabled():
        return
    async with session_scope() as db:
        task = await db.get(Task, task_id)
        if task is None or task.state != S.INPUT_REQUIRED:
            return
        level = (await autonomy(db)).get("input_answer", "L0")
        if level == "off":
            return
        msgs = (await db.execute(select(Message).where(Message.task_id == task.id).order_by(Message.id))).scalars().all()
        question = next((m.content for m in reversed(msgs) if m.kind in ("question", "conclusion")), "")
        history = [{"who": m.sender_name, "kind": m.kind, "text": m.content[:800]} for m in msgs[-40:]]
        related = (
            await db.execute(select(Task).where(Task.id != task.id, Task.repos.overlap(task.repos or ["-"])).order_by(Task.id.desc()).limit(5))
        ).scalars().all()
        data = await llm.chat_json(
            llm.SYSTEM_PREAMBLE + "Agent 在执行任务时提出了问题。只有当任务描述、历史消息或相关任务里有明确依据时才给出答案；否则 answer 为 null。",
            json.dumps(
                {
                    "任务": {"title": task.title, "description": task.description, "repos": task.repos},
                    "Agent 的问题": question,
                    "历史": history,
                    "相关任务": [{"key": t.key, "title": t.title, "description": t.description[:500]} for t in related],
                    "输出格式": {"answer": "答案或 null", "evidence": "依据来自哪里"},
                },
                ensure_ascii=False,
            ),
        )
        if not data or not data.get("answer"):
            return
        creator = await get_member(db, task.creator_id)
        await propose(
            db, task=task, scenario="input_answer", level=level,
            summary=f"建议回答：{data['answer']}（依据：{data.get('evidence') or '历史记录'}）",
            actions=[{"op": "answer_input", "task_id": task.id, "text": data["answer"]}],
            engine="llm", notify_member=creator,
        )
        await commit(db)


async def run_ci_triage(task_id: int, failed_jobs: list[dict[str, Any]] | None = None) -> None:
    async with session_scope() as db:
        task = await db.get(Task, task_id)
        if task is None:
            return
        level = (await autonomy(db)).get("ci_triage", "L0")
        if level == "off":
            return
        jobs = failed_jobs or []
        reasons = " ".join(str(j.get("failure_reason") or "") for j in jobs)
        engine = "rules"
        category = "agent_fixable"
        why = "代码或测试失败，交给 Agent 按日志修复"
        if any(k in reasons for k in ("runner_system_failure", "stuck_or_timeout_failure", "api_failure", "scheduler_failure", "data_integrity_failure")):
            category, why = "flaky", "看起来是 Runner/基础设施问题，建议在 GitLab 上重试流水线"
        elif task.ci_retries >= 2:
            category, why = "needs_human", "已连续失败多次，建议负责人介入"
        if llm.enabled() and jobs:
            data = await llm.chat_json(
                llm.SYSTEM_PREAMBLE + "你负责把 CI 失败归类。",
                json.dumps({"任务": task.title, "失败作业": jobs, "已重试次数": task.ci_retries,
                            "输出格式": {"category": "agent_fixable|needs_human|flaky", "reason": "一句话理由"}}, ensure_ascii=False),
            )
            if data and data.get("category") in ("agent_fixable", "needs_human", "flaky"):
                category, why, engine = data["category"], data.get("reason") or why, "llm"
        label = {"agent_fixable": "Agent 可自修", "needs_human": "需人介入", "flaky": "疑似环境问题"}[category]
        actions = []
        if category != "agent_fixable":
            actions.append({"op": "message", "task_id": task.id, "text": f"CI 失败归类：{label}。{why}"})
        assignee = await get_member(db, task.assignee_id)
        await propose(db, task=task, scenario="ci_triage", level=level, summary=f"CI 失败归类：{label}。{why}", actions=actions, engine=engine, notify_member=assignee if category != "agent_fixable" else None)
        await commit(db)


async def run_help_routing(task_id: int) -> None:
    """求助子任务：规则已经给出一个推荐；有模型时再给一个带理由的二次建议（不同于规则结果才提出）。"""
    if not llm.enabled():
        return
    async with session_scope() as db:
        task = await db.get(Task, task_id)
        if task is None or task.state != S.SUBMITTED:
            return
        level = (await autonomy(db)).get("help_routing", "L0")
        if level == "off":
            return
        cands = await rank_candidates(db, task)
        if not cands:
            return
        data = await llm.chat_json(
            llm.SYSTEM_PREAMBLE + "一个 Agent 发起了求助。从候选人里选最合适的接手人。",
            json.dumps({"求助": {"title": task.title, "description": task.description, "skills": task.skills},
                        "候选人": [{"member_id": str(c.member.id), "name": c.member.name, "规则理由": c.reason, "分数": round(c.score, 1)} for c in cands[:8]],
                        "输出格式": {"member_id": "id", "reason": "理由"}}, ensure_ascii=False),
        )
        if not data or not data.get("member_id") or data["member_id"] == str(task.suggested_assignee_id):
            return
        m = next((c.member for c in cands if str(c.member.id) == data["member_id"]), None)
        if m is None:
            return
        parent = await db.get(Task, task.parent_id) if task.parent_id else None
        notify_to = await get_member(db, parent.assignee_id) if parent else None
        await propose(
            db, task=task, scenario="help_routing", level=level, summary=f"建议改派给 {m.name}：{data.get('reason') or ''}",
            actions=[{"op": "offer", "task_id": task.id, "member_id": str(m.id), "reason": data.get("reason") or "协调 Agent 推荐"}],
            engine="llm", notify_member=notify_to,
        )
        await commit(db)


async def run_qa(question: str, chat_id: str | None, message_id: str | None, asker_id: str | None, enabled: bool = True) -> None:
    """飞书里 @机器人 提问：只读回答。"""
    async with session_scope() as db:
        asker = None
        if asker_id:
            import uuid as _uuid

            asker = await db.get(Member, _uuid.UUID(asker_id))
        answer = await answer_question(db, question, asker, enabled=enabled)
        if chat_id:
            notify.notify_text(db, "chat_id", chat_id, answer[:3000], reply_to=message_id)
            await commit(db)


async def answer_question(db, question: str, asker: Member | None, *, enabled: bool) -> str:
    if enabled and llm.enabled():
        context = await _qa_context(db, question, asker)
        try:
            answer = await llm.chat(
                llm.SYSTEM_PREAMBLE + "根据给定数据回答用户的问题，数据里没有的就说不知道。",
                json.dumps({"问题": question, "数据": context}, ensure_ascii=False), max_tokens=600,
            )
            if answer.strip():
                return answer.strip()
        except Exception as exc:  # noqa: BLE001
            log.info("问答改用规则：%s", exc)
    return await _rule_answer(db, question, asker)


async def _qa_context(db, question: str, asker: Member | None) -> dict[str, Any]:
    counts = dict((await db.execute(select(Task.state, func.count()).where(Task.is_demo.is_(False)).group_by(Task.state))).all())
    ctx: dict[str, Any] = {"按状态计数": {S.LABELS[k]: v for k, v in counts.items()}}
    keys = [int(x) for x in re.findall(r"ACP-(\d+)", question, re.I)][:5]
    if keys:
        ts = (await db.execute(select(Task).where(Task.id.in_(keys)))).scalars().all()
        ctx["提到的任务"] = []
        for t in ts:
            owner = await get_member(db, t.assignee_id)
            ctx["提到的任务"].append({"key": t.key, "title": t.title, "state": S.LABELS[t.state],
                                   "负责人": owner.name if owner else "待认领", "updated_at": t.updated_at.isoformat()})
    if asker:
        mine = (await db.execute(select(Task).where(Task.assignee_id == asker.id, Task.state.in_(list(S.OPEN))).limit(10))).scalars().all()
        ctx["提问人负责的未结束任务"] = [{"key": t.key, "title": t.title, "state": S.LABELS[t.state]} for t in mine]
    return ctx


async def _rule_answer(db, question: str, asker: Member | None) -> str:
    keys = [int(x) for x in re.findall(r"ACP-(\d+)", question, re.I)][:5]
    if keys:
        ts = (await db.execute(select(Task).where(Task.id.in_(keys)))).scalars().all()
        if ts:
            lines = []
            for t in ts:
                who = await get_member(db, t.assignee_id)
                lines.append(f"{t.key}「{t.title}」：{S.LABELS[t.state]}，负责人 {who.name if who else '待认领'}，{notify.task_url(t.id)}")
            return "\n".join(lines)
    if asker and any(w in question for w in ("我的", "我负责")):
        mine = (await db.execute(select(Task).where(Task.assignee_id == asker.id, Task.state.in_(list(S.OPEN))).order_by(Task.id.desc()).limit(10))).scalars().all()
        if not mine:
            return "你名下没有未结束的任务。"
        return "你负责的未结束任务：\n" + "\n".join(f"· {t.key}「{t.title}」{S.LABELS[t.state]}" for t in mine)
    if not any(word in question for word in ("任务", "进度", "状态", "多少", "概况", "情况")):
        return "我可以查 ACP 任务进度。发「我的任务」可查看你负责的工作，发「帮助」可查看建单和查询用法。"
    counts = dict((await db.execute(select(Task.state, func.count()).where(Task.is_demo.is_(False)).group_by(Task.state))).all())
    open_n = sum(v for k, v in counts.items() if k in S.OPEN)
    return (
        f"当前未结束任务 {open_n} 个：待认领 {counts.get(S.SUBMITTED, 0)}，进行中 {counts.get(S.WORKING, 0)}，"
        f"待补充 {counts.get(S.INPUT_REQUIRED, 0)}，待审批 {counts.get(S.AUTH_REQUIRED, 0)}。"
        "问具体任务请带上编号，例如“ACP-12 进度？”。"
    )


async def run_patrol() -> int:
    """定时巡检：卡太久的任务、离线的 Agent，主动提醒（L1 只通知）。"""
    async with session_scope() as db:
        level = (await autonomy(db)).get("patrol", "L1")
        if level == "off":
            return 0
        now = utcnow()
        stuck = (
            await db.execute(
                select(Task).where(
                    Task.is_demo.is_(False),
                    (
                        (Task.state == S.INPUT_REQUIRED) & (Task.state_changed_at < now - timedelta(hours=8))
                    )
                    | ((Task.state == S.AUTH_REQUIRED) & (Task.state_changed_at < now - timedelta(hours=8)))
                    | ((Task.state == S.WORKING) & (Task.last_activity_at < now - timedelta(hours=4)))
                    | ((Task.state == S.SUBMITTED) & (Task.created_at < now - timedelta(hours=24))),
                )
            )
        ).scalars().all()
        recent = (
            await db.execute(
                select(Suggestion.task_id).where(Suggestion.scenario == "patrol", Suggestion.created_at > now - timedelta(hours=12))
            )
        ).scalars().all()
        recent_ids = set(recent)
        n = 0
        for t in stuck:
            if t.id in recent_ids:
                continue
            why = {
                S.INPUT_REQUIRED: "等补充信息超过 8 小时",
                S.AUTH_REQUIRED: "等审批超过 8 小时",
                S.WORKING: "超过 4 小时没有进展",
                S.SUBMITTED: "超过 24 小时没人认领",
            }[t.state]
            target = await get_member(db, t.assignee_id or t.creator_id)
            text = f"巡检提醒：{t.key}「{t.title}」{why}。{notify.task_url(t.id)}"
            await propose(db, task=t, scenario="patrol", level=level, summary=text,
                          actions=[{"op": "notify_text", "task_id": t.id, "text": text}], engine="rules", notify_member=None)
            if target is None:
                continue
            n += 1
        await commit(db)
        return n


def register() -> None:
    hooks.register("agent.intake", lambda task_id: run_intake(task_id))
    hooks.register("agent.input_answer", lambda task_id: run_input_answer(task_id))
    hooks.register("agent.ci_triage", lambda task_id, failed_jobs=None: run_ci_triage(task_id, failed_jobs))
    hooks.register("agent.help_routing", lambda task_id: run_help_routing(task_id))
    hooks.register("agent.qa", lambda **kw: run_qa(**kw))
