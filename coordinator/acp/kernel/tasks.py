"""任务操作。所有状态变化都从这里走，并且每一步写事件。"""

from __future__ import annotations

import re
import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import Agent, Approval, Member, MergeRequest, Suggestion, Task, utcnow
from ..security import SYSTEM, Principal
from . import notify
from . import permissions as P
from . import states as S
from .agents import deliver_assignment, pick_agent
from .core import (
    add_message,
    get_member,
    get_setting,
    get_task,
    publish_after_commit,
    record_event,
    serialize_approvals,
    serialize_mr,
    serialize_suggestions,
    serialize_task,
    serialize_tasks,
    task_timeline,
)
from .errors import ApiError, forbidden, invalid_state, not_found, validation
from .hooks import trigger_after_commit

PRIORITIES = {"low", "normal", "high", "urgent"}
SCENARIOS = ["intake", "dispatch", "help_routing", "input_answer", "ci_triage", "qa", "patrol"]
DEFAULT_LEVELS = {
    "intake": "L0",
    "dispatch": "L0",
    "help_routing": "L0",
    "input_answer": "L0",
    "ci_triage": "L0",
    "qa": "L1",
    "patrol": "L1",
}


async def autonomy(db: AsyncSession) -> dict[str, str]:
    stored = await get_setting(db, "autonomy", {}) or {}
    default = get_settings().agent_level_default
    levels = {k: stored.get(k, DEFAULT_LEVELS.get(k, default)) for k in SCENARIOS}
    return levels


def _clean_list(values: Any, limit: int = 20, size: int = 200) -> list[str]:
    if not values:
        return []
    if isinstance(values, str):
        values = re.split(r"[,，\s]+", values)
    out = []
    for v in values:
        v = str(v).strip()
        if v and v not in out:
            out.append(v[:size])
    return out[:limit]


# ---------------------------------------------------------------- 状态

async def set_state(db: AsyncSession, actor: Principal, task: Task, new: str, reason: str | None = None) -> None:
    old = task.state
    if old == new:
        return
    if not S.can_transition(old, new):
        raise invalid_state(f"任务当前是「{S.LABELS[old]}」，不能变为「{S.LABELS[new]}」")
    task.state = new
    task.state_changed_at = utcnow()
    if new in S.TERMINAL:
        task.closed_at = task.state_changed_at
    text = f"状态：{S.LABELS[old]} → {S.LABELS[new]}" + (f"（{reason}）" if reason else "")
    await record_event(db, task, "state.changed", text, actor, data={"from": old, "to": new, "reason": reason})
    summary = await serialize_task(db, task)
    publish_after_commit(db, f"task:{task.id}", {"event": "task", "data": summary})
    publish_after_commit(db, "tasks", {"event": "task", "data": summary})
    if task.assignee_agent_id:
        publish_after_commit(db, f"agent:{task.assignee_agent_id}", {"type": "task_state", "task": summary})
    if task.parent_id and new in S.TERMINAL:
        await _notify_parent_of_child(db, task)
    if old == S.WORKING and new != S.WORKING and task.assignee_id:
        await _deliver_next_waiting(db, task.assignee_id, exclude=task.id)


async def _deliver_next_waiting(db: AsyncSession, member_id: uuid.UUID, exclude: int) -> None:
    """负责人的 Agent 空出来后，把排队中的下一个任务派出去。"""
    waiting = (
        await db.execute(
            select(Task)
            .where(Task.assignee_id == member_id, Task.state == S.WORKING, Task.assignee_agent_id.is_(None), Task.id != exclude)
            .order_by(Task.id)
            .limit(1)
        )
    ).scalar_one_or_none()
    if waiting is not None:
        await deliver_assignment(db, waiting, waiting.run_reason or "new")


async def _notify_parent_of_child(db: AsyncSession, child: Task) -> None:
    parent = await db.get(Task, child.parent_id)
    if parent is None:
        return
    conclusion = ""
    from ..models import Message

    last = (
        await db.execute(
            select(Message).where(Message.task_id == child.id, Message.kind == "conclusion").order_by(Message.id.desc()).limit(1)
        )
    ).scalar_one_or_none()
    if last:
        conclusion = f"：{last.content[:500]}"
    await add_message(
        db,
        parent,
        f"求助子任务 {child.key}「{child.title}」{S.LABELS[child.state]}{conclusion}",
        SYSTEM,
        kind="progress",
        data={"child_id": child.id, "child_state": child.state},
    )


# ---------------------------------------------------------------- 建单

async def create_task(
    db: AsyncSession,
    actor: Principal,
    *,
    title: str,
    description: str = "",
    repos: Any = None,
    priority: str = "normal",
    skills: Any = None,
    labels: Any = None,
    parent_id: int | None = None,
    suggested_assignee_id: uuid.UUID | None = None,
    source: str = "board",
    source_ref: dict[str, Any] | None = None,
    task_type: str | None = None,
    feishu_chat_id: str | None = None,
    requester_agent_id: uuid.UUID | None = None,
    is_demo: bool = False,
    run_intake: bool = True,
    announce: bool = True,
) -> Task:
    title = (title or "").strip()
    if not title:
        raise validation("标题不能为空")
    if priority not in PRIORITIES:
        priority = "normal"
    parent = None
    if parent_id is not None:
        parent = await get_task(db, parent_id)
    creator_id = actor.member_id if actor.type in ("member", "agent") else None
    task = Task(
        title=title[:300],
        description=(description or "").strip(),
        type=task_type or ("subtask" if parent else "requirement"),
        state=S.SUBMITTED,
        priority=priority,
        source=source,
        source_ref=source_ref or {},
        repos=_clean_list(repos),
        skills=_clean_list(skills, size=80),
        labels=_clean_list(labels, size=80),
        creator_id=creator_id,
        suggested_assignee_id=suggested_assignee_id,
        parent_id=parent.id if parent else None,
        depth=(parent.depth + 1) if parent else 0,
        feishu_chat_id=feishu_chat_id or (parent.feishu_chat_id if parent else None),
        requester_agent_id=requester_agent_id,
        is_demo=is_demo,
    )
    if parent and not task.repos:
        task.repos = list(parent.repos or [])
    db.add(task)
    await db.flush()
    task.root_id = (parent.root_id or parent.id) if parent else task.id
    src = S.SOURCE_LABELS.get(source, source)
    await record_event(
        db,
        task,
        "task.created",
        f"{actor.name or '系统'} 创建了{S.TYPE_LABELS.get(task.type, '任务')}（来源：{src}）",
        actor,
        data={"source": source},
    )
    if parent:
        await record_event(db, parent, "task.child_created", f"创建子任务 {task.key}「{task.title}」", actor, data={"child_id": task.id})

    levels = await autonomy(db)
    if suggested_assignee_id is not None:
        member = await get_member(db, suggested_assignee_id)
        if member:
            await _offer(db, actor, task, member, "发布者指定")
    elif levels.get("dispatch", "L0") != "off" and task.type != "help":
        from .dispatch import suggest

        cand = await suggest(db, task)
        if cand is not None:
            await _offer(db, SYSTEM, task, cand.member, cand.reason)
    if announce and not is_demo:
        await notify.notify_task_card(db, task)
    if run_intake and task.type == "requirement" and levels.get("intake", "L0") != "off":
        trigger_after_commit(db, "agent.intake", task_id=task.id)
    publish_after_commit(db, "tasks", {"event": "created", "data": {"id": task.id}})
    return task


async def _offer(db: AsyncSession, actor: Principal, task: Task, member: Member, reason: str) -> None:
    task.suggested_assignee_id = member.id
    await record_event(
        db,
        task,
        "task.dispatched",
        f"推荐由 {member.name} 处理（{reason}）",
        actor,
        data={"member_id": str(member.id), "reason": reason},
    )
    if not task.is_demo:
        notify.notify_member_card(db, member, notify.dispatch_card(task, member, reason), task.id)


# ---------------------------------------------------------------- 认领与派工

async def claim(db: AsyncSession, actor: Principal, task: Task, *, via: str = "claim") -> Task:
    if not P.can_claim(actor, task):
        if task.state != S.SUBMITTED:
            raise invalid_state(f"任务当前是「{S.LABELS[task.state]}」，不能认领")
        raise forbidden("认领必须由成员本人操作")
    member = await get_member(db, actor.member_id)
    if member is None:
        raise forbidden("成员不存在")
    task.assignee_id = member.id
    task.suggested_assignee_id = None
    await record_event(
        db, task, "task.claimed", f"{member.name} {'接受了派工' if via == 'accept' else '认领了任务'}", actor
    )
    await set_state(db, actor, task, S.WORKING)
    task.run_reason = "new"
    agent = await deliver_assignment(db, task, "new")
    if agent is None:
        await record_event(db, task, "agent.waiting", f"{member.name} 暂无在线 Agent，Agent 上线后自动开始", SYSTEM)
    if not task.is_demo:
        await notify.notify_task_card(db, task)
    return task


async def assign(db: AsyncSession, actor: Principal, task: Task, member_id: uuid.UUID) -> Task:
    if not P.can_assign(actor, task):
        raise forbidden("只有发布者或管理员可以指派，且任务须处于待认领")
    member = await get_member(db, member_id)
    if member is None or not member.is_active:
        raise not_found("成员")
    await _offer(db, actor, task, member, f"{actor.name} 指派")
    return task


async def accept(db: AsyncSession, actor: Principal, task: Task) -> Task:
    if not P.can_accept(actor, task):
        raise forbidden("只有被推荐的成员可以接受，且任务须处于待认领")
    return await claim(db, actor, task, via="accept")


async def decline(db: AsyncSession, actor: Principal, task: Task, reason: str | None = None) -> Task:
    if not P.can_accept(actor, task):
        raise forbidden("只有被推荐的成员可以拒绝")
    declined = actor.member_id
    task.suggested_assignee_id = None
    await record_event(db, task, "task.declined", f"{actor.name} 没有接这个任务" + (f"：{reason}" if reason else ""), actor)
    levels = await autonomy(db)
    if levels.get("dispatch") != "off":
        from .dispatch import suggest

        cand = await suggest(db, task, exclude={declined} if declined else None)
        if cand is not None:
            await _offer(db, SYSTEM, task, cand.member, cand.reason)
    if not task.is_demo:
        await notify.notify_task_card(db, task)
    return task


async def release(db: AsyncSession, actor: Principal, task: Task, reason: str) -> None:
    """回收到待认领（心跳超时等）。"""
    agent_id = task.assignee_agent_id
    await set_state(db, actor, task, S.SUBMITTED, reason)
    if agent_id:
        publish_after_commit(db, f"agent:{agent_id}", {"type": "revoked", "task_id": task.id, "reason": reason})
    old = task.assignee_id
    task.assignee_id = None
    task.assignee_agent_id = None
    task.agent_acked = False
    task.agent_run_done = False
    task.suggested_assignee_id = old
    if not task.is_demo:
        await notify.notify_task_card(db, task, note=reason)


async def cancel(db: AsyncSession, actor: Principal, task: Task, reason: str | None = None) -> Task:
    if not P.can_cancel(actor, task):
        raise forbidden("只有发布者或管理员可以取消未结束的任务")
    agent_id = task.assignee_agent_id
    await set_state(db, actor, task, S.CANCELED, reason)
    if agent_id:
        publish_after_commit(db, f"agent:{agent_id}", {"type": "revoked", "task_id": task.id, "reason": "任务已取消"})
    await _close_pending_approvals(db, task, "任务已取消")
    if not task.is_demo:
        await notify.notify_task_card(db, task)
    return task


async def _close_pending_approvals(db: AsyncSession, task: Task, comment: str) -> None:
    pending = (await db.execute(select(Approval).where(Approval.task_id == task.id, Approval.status == "pending"))).scalars()
    for a in pending:
        a.status = "canceled"
        a.comment = comment
        a.decided_at = utcnow()


async def complete(db: AsyncSession, actor: Principal, task: Task, note: str | None = None) -> Task:
    mrs = await _mrs(db, task.id)
    open_mrs = len([m for m in mrs if m.state in ("opened", "none") and (m.iid or m.url)])
    if not P.can_complete(actor, task, open_mrs):
        raise forbidden("只有发布者或管理员可以确认完成，且不能有未合并的 MR")
    if note:
        await add_message(db, task, note, actor, kind="conclusion")
    await set_state(db, actor, task, S.COMPLETED, "发布者确认验收")
    if not task.is_demo:
        await notify.notify_task_card(db, task)
    return task


async def edit(db: AsyncSession, actor: Principal, task: Task, body: dict[str, Any]) -> Task:
    if not P.can_edit(actor, task):
        raise forbidden("只有发布者、负责人或管理员可以编辑")
    changed = []

    def _set(attr: str, label: str, value: Any) -> None:
        if getattr(task, attr) != value:  # 只记真正变了的字段
            setattr(task, attr, value)
            changed.append(label)

    if "title" in body and body["title"]:
        _set("title", "标题", str(body["title"]).strip()[:300])
    if "description" in body and body["description"] is not None:
        _set("description", "描述", str(body["description"]))
    if "repos" in body and body["repos"] is not None:
        _set("repos", "仓库", _clean_list(body["repos"]))
    if "skills" in body and body["skills"] is not None:
        _set("skills", "技能", _clean_list(body["skills"], size=80))
    if "labels" in body and body["labels"] is not None:
        _set("labels", "标签", _clean_list(body["labels"], size=80))
    if body.get("priority") in PRIORITIES:
        _set("priority", "优先级", body["priority"])
    if changed:
        await record_event(db, task, "task.edited", f"{actor.name} 修改了{'、'.join(changed)}", actor)
        publish_after_commit(db, f"task:{task.id}", {"event": "task", "data": await serialize_task(db, task)})
    return task


# ---------------------------------------------------------------- 消息与补充信息

async def post_message(db: AsyncSession, actor: Principal, task: Task, content: str, kind: str = "message"):
    content = (content or "").strip()
    if not content:
        raise validation("消息不能为空")
    if not P.can_message(actor, task):
        raise forbidden("只有发布者、负责人、被推荐人或管理员可以在任务里发消息")
    msg = await add_message(db, task, content[:20000], actor, kind=kind)
    if actor.type != "agent" and task.assignee_agent_id and task.state == S.WORKING:
        publish_after_commit(
            db, f"agent:{task.assignee_agent_id}", {"type": "message", "task_id": task.id, "from": actor.name, "text": content}
        )
    return msg


async def answer_input(db: AsyncSession, actor: Principal, task: Task, content: str) -> Task:
    if not P.can_answer_input(actor, task):
        raise forbidden("只有发布者、负责人或管理员可以回答，且任务须处于待补充")
    await add_message(db, task, content, actor, kind="answer")
    await set_state(db, actor, task, S.WORKING, "已补充信息")
    if task.assignee_id:
        await deliver_assignment(db, task, "input_answered")
    if not task.is_demo:
        await notify.notify_task_card(db, task)
    return task


async def request_input(db: AsyncSession, actor: Principal, task: Task, question: str) -> Task:
    if not P.can_update_as_owner(actor, task):
        raise forbidden("只有负责人或其 Agent 可以请求补充信息")
    await add_message(db, task, question, actor, kind="question")
    await set_state(db, actor, task, S.INPUT_REQUIRED, "Agent 请求补充信息")
    if not task.is_demo:
        creator = await get_member(db, task.creator_id)
        assignee = await get_member(db, task.assignee_id)
        card = notify.input_card(task, question)
        sent = False
        for m in {x.id: x for x in (assignee, creator) if x}.values():
            sent = notify.notify_member_card(db, m, card, task.id) or sent
        if not sent:
            await notify.notify_task_card(db, task, note=f"Agent 需要补充信息：{question[:120]}")
    levels = await autonomy(db)
    if levels.get("input_answer") != "off":
        trigger_after_commit(db, "agent.input_answer", task_id=task.id)
    return task


# ---------------------------------------------------------------- 审批

async def request_approval(db: AsyncSession, actor: Principal, task: Task, gate: str = "merge", note: str | None = None) -> Approval:
    if gate not in ("merge", "high_risk"):
        raise validation("gate 只能是 merge 或 high_risk")
    if not (P.can_request_approval(actor, task) or actor.type == "system"):
        raise forbidden("只有负责人或其 Agent 可以请求审批")
    pending = (
        await db.execute(select(Approval).where(Approval.task_id == task.id, Approval.status == "pending", Approval.gate == gate))
    ).scalar_one_or_none()
    if pending is not None:
        return pending
    a = Approval(task_id=task.id, gate=gate, status="pending", note=note, requested_by_id=actor.member_id, created_at=utcnow())
    db.add(a)
    await db.flush()
    gate_label = {"merge": "合并前审批", "high_risk": "高风险操作审批"}[gate]
    await record_event(db, task, "approval.requested", f"请求{gate_label}" + (f"：{note}" if note else ""), actor, data={"approval_id": a.id, "gate": gate})
    if task.state in (S.WORKING, S.INPUT_REQUIRED):
        await set_state(db, actor, task, S.AUTH_REQUIRED, gate_label)
    if not task.is_demo:
        mrs = await _mrs(db, task.id)
        card = notify.approval_card(task, a, mrs)
        reviewers = (
            await db.execute(
                select(Member).where(Member.is_active.is_(True), Member.roles.overlap(["reviewer"]), Member.is_demo.is_(False))
            )
        ).scalars().all()
        reviewers = [r for r in reviewers if r.id != task.assignee_id]
        if not reviewers:
            reviewers = (
                await db.execute(select(Member).where(Member.is_active.is_(True), Member.roles.overlap(["admin"]), Member.is_demo.is_(False)))
            ).scalars().all()
        sent = False
        for r in reviewers:
            sent = notify.notify_member_card(db, r, card, task.id) or sent
        if not sent:
            chat = task.feishu_chat_id or await notify.default_chat_id(db)
            if chat:
                notify.enqueue(db, "feishu.card", {"receive_id_type": "chat_id", "receive_id": chat, "card": card}, task.id)
    return a


async def decide_approval(db: AsyncSession, actor: Principal, approval_id: int, decision: str, comment: str | None = None) -> Task:
    a = await db.get(Approval, approval_id, with_for_update=True)
    if a is None:
        raise not_found("审批")
    task = await get_task(db, a.task_id, lock=True)
    if decision not in ("approve", "reject"):
        raise validation("decision 只能是 approve 或 reject")
    if not P.can_decide(actor, task, a):
        if a.status != "pending":
            raise invalid_state("这个审批已经处理过了")
        raise forbidden("只有评审者或管理员可以审批，且不能审批自己负责的任务")
    a.status = "approved" if decision == "approve" else "rejected"
    a.decided_by_id = actor.member_id
    a.decided_at = utcnow()
    a.comment = comment
    if decision == "approve":
        await record_event(db, task, "approval.approved", f"{actor.name} 同意" + (f"：{comment}" if comment else ""), actor, data={"approval_id": a.id})
        mrs = await _mrs(db, task.id)
        for m in mrs:
            if m.iid and m.state == "opened" and not task.is_demo:
                notify.enqueue(
                    db,
                    "gitlab.comment",
                    {"project": m.repo, "mr_iid": m.iid, "body": f"✅ ACP 审批通过（{actor.name}）。{comment or ''}\n\n任务：{notify.task_url(task.id)}"},
                    task.id,
                )
        code_mrs = [m for m in mrs if m.iid or m.url]
        if task.state == S.AUTH_REQUIRED:
            if a.gate == "high_risk" or not code_mrs:
                await set_state(db, actor, task, S.WORKING, "审批通过")
                if task.assignee_id:
                    await deliver_assignment(db, task, "approved_continue")
            elif all(m.state == "merged" for m in code_mrs):
                await set_state(db, actor, task, S.COMPLETED, "审批通过，MR 已全部合并")
    else:
        await record_event(db, task, "approval.rejected", f"{actor.name} 驳回" + (f"：{comment}" if comment else ""), actor, data={"approval_id": a.id})
        if comment:
            await add_message(db, task, f"评审意见：{comment}", actor, kind="review")
        if task.state == S.AUTH_REQUIRED:
            await set_state(db, actor, task, S.WORKING, "审批驳回，继续修改")
            await deliver_assignment(db, task, "approval_rejected")
    if not task.is_demo:
        await notify.notify_task_card(db, task)
    return task


# ---------------------------------------------------------------- Agent 回报

async def agent_report(
    db: AsyncSession,
    actor: Principal,
    task: Task,
    *,
    state: str | None = None,
    kind: str = "progress",
    text: str = "",
    artifacts: list[dict[str, Any]] | None = None,
) -> Task:
    if not P.can_update_as_owner(actor, task):
        raise forbidden("只有负责人或其 Agent 可以回报进度")
    if task.state in S.TERMINAL:
        raise invalid_state("任务已结束")
    if kind == "ack":
        task.agent_acked = True
        if actor.agent_id and task.assignee_agent_id != actor.agent_id:
            task.assignee_agent_id = actor.agent_id
        agent = await db.get(Agent, task.assignee_agent_id) if task.assignee_agent_id else None
        await record_event(db, task, "agent.acked", f"Agent「{agent.name if agent else actor.name}」开始执行", actor)
    if text:
        await add_message(db, task, text[:20000], actor, kind=kind if kind != "ack" else "progress")
    reported = 0
    for art in artifacts or []:
        reported += await _record_artifact(db, actor, task, art)
    if state == S.INPUT_REQUIRED and task.state != S.INPUT_REQUIRED:
        await set_state(db, actor, task, S.INPUT_REQUIRED, "Agent 需要补充信息")
        if not task.is_demo:
            await notify.notify_task_card(db, task, note=(text or "")[:200])
        trigger_after_commit(db, "agent.input_answer", task_id=task.id)
    elif state == S.FAILED:
        await set_state(db, actor, task, S.FAILED, "Agent 报告失败")
        if not task.is_demo:
            await notify.notify_task_card(db, task, note=(text or "")[:200])
    elif state == S.COMPLETED:
        mrs = await _mrs(db, task.id)
        if task.type == "help" and not [m for m in mrs if m.iid or m.url]:
            await set_state(db, actor, task, S.COMPLETED, "求助已答复")
        else:
            await _finish_agent_run(db, actor, task)
    elif state == S.WORKING and task.state == S.INPUT_REQUIRED:
        task.agent_run_done = False
        await set_state(db, actor, task, S.WORKING, "Agent 继续执行")
    if reported and task.state == S.WORKING and state in (None, S.WORKING):
        await _finish_agent_run(db, actor, task)
    return task


async def _finish_agent_run(db: AsyncSession, actor: Principal, task: Task) -> None:
    """Agent 交了分支 / MR：本轮执行结束，任务留在进行中等 CI 与审批，Agent 空出名额接下一个任务。"""
    if task.agent_run_done:
        return
    task.agent_run_done = True
    await record_event(db, task, "agent.finished", "Agent 执行结束，等待 MR 与 CI", actor)
    if task.assignee_id:
        await _deliver_next_waiting(db, task.assignee_id, exclude=task.id)


async def _record_artifact(db: AsyncSession, actor: Principal, task: Task, art: dict[str, Any]) -> int:
    repo = str(art.get("repo") or "").strip()
    branch = str(art.get("branch") or "").strip()
    url = (art.get("url") or None) and str(art["url"])
    if not repo and not branch and not url:
        return 0
    iid = None
    if url:
        m = re.search(r"/merge_requests/(\d+)", url)
        if m:
            iid = int(m.group(1))
    mr = (
        await db.execute(select(MergeRequest).where(MergeRequest.task_id == task.id, MergeRequest.repo == repo, MergeRequest.branch == branch))
    ).scalar_one_or_none()
    if mr is None:
        mr = MergeRequest(task_id=task.id, repo=repo, branch=branch, state="none", updated_at=utcnow())
        db.add(mr)
    if url:
        mr.url = url
        mr.iid = iid or mr.iid
        if mr.state == "none":
            mr.state = "opened"
    mr.updated_at = utcnow()
    await db.flush()
    text = f"提交了 {repo or '仓库'} 的分支 {branch}" + (f"，MR：{url}" if url else "")
    await record_event(db, task, "mr.reported", text, actor, data={"repo": repo, "branch": branch, "url": url})
    return 1


async def _mrs(db: AsyncSession, task_id: int) -> list[MergeRequest]:
    return list((await db.execute(select(MergeRequest).where(MergeRequest.task_id == task_id).order_by(MergeRequest.id))).scalars())


# ---------------------------------------------------------------- 求助子任务（Agent 互调）

async def create_help(
    db: AsyncSession,
    actor: Principal,
    parent: Task,
    *,
    title: str,
    description: str,
    target_skill: str | None = None,
    target_member_id: uuid.UUID | None = None,
) -> Task:
    if not P.can_ask_agent(actor, parent):
        raise forbidden("只有任务负责人（或其持有 agent_caller 的 Agent）可以发起求助")
    s = get_settings()
    root_id = parent.root_id or parent.id
    reason = None
    if parent.depth + 1 > s.max_help_depth:
        reason = f"求助嵌套超过 {s.max_help_depth} 层"
    children = (await db.execute(select(func.count()).select_from(Task).where(Task.root_id == root_id, Task.id != root_id))).scalar_one()
    if reason is None and children >= s.max_children_per_root:
        reason = f"一个根任务最多 {s.max_children_per_root} 个子任务"
    requester_agent = actor.agent_id or parent.assignee_agent_id
    help_task = await create_task(
        db,
        actor,
        title=title,
        description=description,
        skills=[target_skill] if target_skill else None,
        parent_id=parent.id,
        source="agent" if actor.type == "agent" else "board",
        task_type="help",
        requester_agent_id=requester_agent,
        run_intake=False,
        announce=False,
    )
    if reason is None and target_member_id is not None and requester_agent:
        # 环检测：对方的 Agent 是否正在向我方求助（同一根任务内）
        target_agents = (await db.execute(select(Agent.id).where(Agent.member_id == target_member_id))).scalars().all()
        reverse = (
            await db.execute(
                select(func.count())
                .select_from(Task)
                .where(
                    Task.root_id == root_id,
                    Task.type == "help",
                    Task.requester_agent_id.in_(target_agents or [uuid.uuid4()]),
                    Task.assignee_agent_id == requester_agent,
                    Task.state.in_(list(S.OPEN)),
                )
            )
        ).scalar_one()
        if reverse:
            reason = "检测到 Agent 之间互相求助形成环"
    if target_member_id is not None and target_member_id == parent.assignee_id:
        reason = reason or "不能向自己求助"
    if reason:
        await set_state(db, SYSTEM, help_task, S.REJECTED, reason)
        await add_message(db, parent, f"求助被拒绝：{reason}", SYSTEM, kind="progress")
        return help_task
    await record_event(db, parent, "help.created", f"发起求助 {help_task.key}「{help_task.title}」", actor, data={"child_id": help_task.id})

    target: Member | None = None
    why = ""
    if target_member_id is not None:
        target = await get_member(db, target_member_id)
        why = "求助方指定"
    else:
        from .dispatch import suggest

        exclude = {parent.assignee_id} if parent.assignee_id else set()
        cand = await suggest(db, help_task, exclude=exclude, skill=target_skill)
        if cand:
            target, why = cand.member, cand.reason
    levels = await autonomy(db)
    if levels.get("help_routing") != "off":
        trigger_after_commit(db, "agent.help_routing", task_id=help_task.id)
    if target is None:
        await record_event(db, help_task, "help.unrouted", "没有找到合适的接手人，等待有人认领", SYSTEM)
        if not help_task.is_demo:
            await notify.notify_task_card(db, help_task, note="Agent 发起的求助，等待认领")
        return help_task
    auto = await pick_agent(db, target.id)
    if auto is not None and auto.auto_accept_help:
        help_task.suggested_assignee_id = target.id
        member_actor = Principal(type="system", member_id=target.id, name=target.name, roles=list(target.roles or []))
        await record_event(db, help_task, "help.auto_accepted", f"{target.name} 的 Agent 设置了自动接受本团队求助", SYSTEM)
        await claim(db, member_actor, help_task, via="accept")
    else:
        await _offer(db, actor, help_task, target, why)
    return help_task


# ---------------------------------------------------------------- 详情

def allowed_actions(actor: Principal, task: Task, approvals: list[Approval], open_mrs: int) -> list[str]:
    acts = []
    if P.can_claim(actor, task) and actor.member_id != task.suggested_assignee_id:
        acts.append("claim")
    if P.can_accept(actor, task):
        acts += ["accept", "decline"]
    if P.can_assign(actor, task):
        acts.append("assign")
    if P.can_cancel(actor, task):
        acts.append("cancel")
    if P.can_message(actor, task):
        acts.append("message")
    if P.can_answer_input(actor, task):
        acts.append("input")
    if P.can_request_approval(actor, task):
        acts.append("request_approval")
    if any(P.can_decide(actor, task, a) for a in approvals):
        acts += ["approve", "reject"]
    if P.can_complete(actor, task, open_mrs):
        acts.append("complete")
    if P.can_edit(actor, task):
        acts.append("edit")
    return acts


async def task_detail(db: AsyncSession, actor: Principal, task: Task) -> dict[str, Any]:
    summary = await serialize_task(db, task)
    mrs = await _mrs(db, task.id)
    approvals = list((await db.execute(select(Approval).where(Approval.task_id == task.id).order_by(Approval.id))).scalars())
    children = list((await db.execute(select(Task).where(Task.parent_id == task.id).order_by(Task.id))).scalars())
    sugg = list((await db.execute(select(Suggestion).where(Suggestion.task_id == task.id).order_by(Suggestion.id.desc()).limit(50))).scalars())
    open_mrs = len([m for m in mrs if m.state in ("opened", "none") and (m.iid or m.url)])
    return {
        **summary,
        "description": task.description,
        "source_ref": task.source_ref or {},
        "merge_requests": [serialize_mr(m) for m in mrs],
        "approvals": await serialize_approvals(db, approvals),
        "children": await serialize_tasks(db, children),
        "timeline": await task_timeline(db, task.id),
        "suggestions": await serialize_suggestions(db, sugg),
        "allowed_actions": allowed_actions(actor, task, approvals, open_mrs),
    }


def assert_actor_ok(actor: Principal) -> None:
    if actor.type == "service":
        raise ApiError("forbidden", "服务令牌不能直接操作任务", 403)
