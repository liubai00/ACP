"""GitLab 事件：按分支名 acp/<任务号>-<摘要> 匹配任务，推进 MR、CI、合并状态。"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import InboundEvent, MergeRequest, Task, utcnow
from ..security import SYSTEM, Principal
from . import notify
from . import states as S
from .core import add_message, record_event
from .hooks import trigger_after_commit
from .tasks import autonomy, deliver_assignment, request_approval, set_state

BRANCH_RE = re.compile(r"^(?:refs/heads/)?acp/(\d+)(?:[-_/].*)?$")


def task_id_from_branch(branch: str | None) -> int | None:
    if not branch:
        return None
    m = BRANCH_RE.match(branch.strip())
    return int(m.group(1)) if m else None


def normalize_raw(raw: dict[str, Any]) -> dict[str, Any]:
    """把 GitLab 原始 Webhook 归一化（n8n 不可用时的直连通路用）。"""
    kind = raw.get("object_kind") or raw.get("event_name") or ""
    project = (raw.get("project") or {}).get("path_with_namespace") or ""
    project_url = (raw.get("project") or {}).get("web_url")
    user = (raw.get("user") or {}).get("username") or raw.get("user_username")
    out: dict[str, Any] = {"kind": kind, "project": project, "project_url": project_url, "user": user}
    if kind == "push":
        out.update(branch=(raw.get("ref") or "").removeprefix("refs/heads/"), sha=raw.get("after"))
    elif kind == "merge_request":
        attrs = raw.get("object_attributes") or {}
        out.update(
            branch=attrs.get("source_branch"),
            sha=(attrs.get("last_commit") or {}).get("id"),
            mr_iid=attrs.get("iid"),
            mr_url=attrs.get("url"),
            mr_state=attrs.get("state"),
            mr_action=attrs.get("action"),
        )
    elif kind == "pipeline":
        attrs = raw.get("object_attributes") or {}
        mr = raw.get("merge_request") or {}
        failed_jobs = [
            {"name": b.get("name"), "stage": b.get("stage"), "failure_reason": b.get("failure_reason")}
            for b in (raw.get("builds") or [])
            if b.get("status") == "failed"
        ]
        out.update(
            branch=mr.get("source_branch") or attrs.get("ref"),
            sha=attrs.get("sha"),
            mr_iid=mr.get("iid"),
            mr_url=mr.get("url"),
            pipeline_status=attrs.get("status"),
            pipeline_url=f"{project_url}/-/pipelines/{attrs.get('id')}" if project_url and attrs.get("id") else None,
            failed_jobs=failed_jobs,
        )
    return out


async def handle_event(db: AsyncSession, ev: dict[str, Any], *, event_uuid: str | None) -> dict[str, Any]:
    kind = ev.get("kind") or ""
    branch = ev.get("branch")
    project = ev.get("project") or ""
    summary = f"{kind} {project} {branch or ''}".strip()
    if event_uuid:
        dup = (
            await db.execute(select(InboundEvent).where(InboundEvent.source == "gitlab", InboundEvent.external_id == event_uuid))
        ).scalar_one_or_none()
        if dup is not None:
            return {"ok": True, "duplicate": True, "task_id": dup.task_id}
    inbound = InboundEvent(source="gitlab", kind=kind or "unknown", external_id=event_uuid, summary=summary, payload={k: v for k, v in ev.items() if k != "raw"}, created_at=utcnow())
    db.add(inbound)
    task_id = task_id_from_branch(branch)
    if task_id is None:
        inbound.status = "ignored"
        inbound.error = "分支名不是 acp/<任务号>-… 格式"
        return {"ok": True, "ignored": True}
    task = await db.get(Task, task_id, with_for_update=True)
    if task is None:
        inbound.status = "ignored"
        inbound.error = f"任务 {task_id} 不存在"
        return {"ok": True, "ignored": True}
    inbound.task_id = task.id
    actor = Principal(type="service", name=f"GitLab{('·' + ev['user']) if ev.get('user') else ''}", roles=["connector"])

    mr = (
        await db.execute(select(MergeRequest).where(MergeRequest.task_id == task.id, MergeRequest.repo == project, MergeRequest.branch == branch))
    ).scalar_one_or_none()
    if mr is None:
        mr = MergeRequest(task_id=task.id, repo=project, branch=branch, state="none", updated_at=utcnow())
        db.add(mr)
        await db.flush()

    if kind == "push":
        mr.sha = ev.get("sha") or mr.sha
        mr.updated_at = utcnow()
        await record_event(db, task, "git.pushed", f"推送了 {project} 的分支 {branch}", actor, data={"repo": project, "branch": branch, "sha": ev.get("sha")})
    elif kind == "merge_request":
        await _on_mr(db, task, mr, ev, actor)
    elif kind == "pipeline":
        await _on_pipeline(db, task, mr, ev, actor)
    else:
        inbound.status = "ignored"
        inbound.error = f"未处理的事件类型 {kind}"
    return {"ok": True, "task_id": task.id}


async def _on_mr(db: AsyncSession, task: Task, mr: MergeRequest, ev: dict[str, Any], actor: Principal) -> None:
    state = ev.get("mr_state") or "opened"
    action = ev.get("mr_action") or ""
    mr.iid = ev.get("mr_iid") or mr.iid
    mr.url = ev.get("mr_url") or mr.url
    mr.sha = ev.get("sha") or mr.sha
    prev = mr.state
    mr.state = {"opened": "opened", "reopened": "opened", "merged": "merged", "closed": "closed", "locked": "opened"}.get(state, "opened")
    mr.updated_at = utcnow()
    if prev != mr.state or action in ("open", "reopen"):
        label = {"opened": "创建/更新了", "merged": "合并了", "closed": "关闭了"}[mr.state]
        await record_event(db, task, f"mr.{mr.state}", f"{label} MR !{mr.iid}（{mr.repo}）", actor, data={"url": mr.url, "iid": mr.iid, "repo": mr.repo})
    elif action == "update":
        await record_event(db, task, "mr.updated", f"MR !{mr.iid} 有新提交", actor, data={"url": mr.url})
    if mr.state == "merged":
        await _maybe_complete(db, task)
    elif mr.state == "closed" and task.state in S.OPEN:
        await add_message(db, task, f"MR !{mr.iid}（{mr.repo}）被关闭，请负责人确认是否继续", SYSTEM, kind="progress")


async def _maybe_complete(db: AsyncSession, task: Task) -> None:
    mrs = list((await db.execute(select(MergeRequest).where(MergeRequest.task_id == task.id))).scalars())
    code = [m for m in mrs if m.iid or m.url]
    if code and all(m.state in ("merged", "closed") for m in code) and any(m.state == "merged" for m in code):
        if task.state in (S.WORKING, S.AUTH_REQUIRED, S.INPUT_REQUIRED):
            await set_state(db, SYSTEM, task, S.COMPLETED, "相关 MR 已全部合并")
            if not task.is_demo:
                await notify.notify_task_card(db, task, note="🎉 相关 MR 已全部合并")


async def _on_pipeline(db: AsyncSession, task: Task, mr: MergeRequest, ev: dict[str, Any], actor: Principal) -> None:
    status = ev.get("pipeline_status") or "running"
    mapped = {
        "created": "pending",
        "waiting_for_resource": "pending",
        "preparing": "pending",
        "pending": "pending",
        "running": "running",
        "success": "success",
        "failed": "failed",
        "canceled": "canceled",
        "skipped": "canceled",
        "manual": "pending",
        "scheduled": "pending",
    }.get(status, "running")
    if ev.get("mr_iid"):
        mr.iid = ev["mr_iid"]
    if ev.get("mr_url"):
        mr.url = ev["mr_url"]
        if mr.state == "none":
            mr.state = "opened"
    prev = mr.pipeline_status
    mr.pipeline_status = mapped
    mr.updated_at = utcnow()
    if prev == mapped and mapped in ("pending", "running"):
        return
    label = {"pending": "排队中", "running": "运行中", "success": "通过", "failed": "失败", "canceled": "已取消"}[mapped]
    await record_event(
        db, task, f"ci.{mapped}", f"CI {label}（{mr.repo}）", actor,
        data={"repo": mr.repo, "url": ev.get("pipeline_url"), "failed_jobs": ev.get("failed_jobs")},
    )
    if mapped == "success":
        mrs = list((await db.execute(select(MergeRequest).where(MergeRequest.task_id == task.id))).scalars())
        code = [m for m in mrs if m.iid or m.url]
        if code and all(m.pipeline_status == "success" for m in code) and task.state in (S.WORKING, S.INPUT_REQUIRED):
            task.ci_retries = 0
            await request_approval(db, SYSTEM, task, "merge", "CI 全部通过，等待评审")
    elif mapped == "failed" and task.state in (S.WORKING, S.AUTH_REQUIRED):
        task.ci_retries += 1
        s = get_settings()
        jobs = ev.get("failed_jobs") or []
        detail = "；".join(f"{j.get('stage')}/{j.get('name')}（{j.get('failure_reason') or '失败'}）" for j in jobs) or "详见流水线"
        await add_message(db, task, f"CI 失败（第 {task.ci_retries} 次）：{detail}", SYSTEM, kind="ci", data={"url": ev.get("pipeline_url")})
        levels = await autonomy(db)
        if levels.get("ci_triage") != "off":
            trigger_after_commit(db, "agent.ci_triage", task_id=task.id, failed_jobs=jobs)
        if task.ci_retries > s.ci_max_retries:
            await set_state(db, SYSTEM, task, S.FAILED, f"CI 连续失败 {task.ci_retries} 次")
            if not task.is_demo:
                await notify.notify_task_card(db, task, note=f"CI 连续失败：{detail[:150]}")
        else:
            if task.state == S.AUTH_REQUIRED:
                await set_state(db, SYSTEM, task, S.WORKING, "CI 失败，回到修改")
            if task.assignee_id:
                await deliver_assignment(db, task, "ci_failed")
