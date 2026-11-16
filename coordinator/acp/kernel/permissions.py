"""权限矩阵（按数据判断的部分）。按工具名的部分由网关 CEL 执行，这里是第二道、也是最终的一道。"""

from __future__ import annotations

from ..models import Approval, Task
from ..security import Principal
from . import states as S
from .errors import forbidden


def is_creator(p: Principal, t: Task) -> bool:
    return p.member_id is not None and p.member_id == t.creator_id


def is_assignee(p: Principal, t: Task) -> bool:
    return p.member_id is not None and p.member_id == t.assignee_id


def is_human(p: Principal) -> bool:
    return p.type in ("member", "system")


def agent_scoped_to(p: Principal, t: Task) -> bool:
    """Agent 任务令牌只对自己的任务（及其发起的求助子任务）有效。"""
    if p.type != "agent":
        return False
    return p.task_id == t.id or (t.parent_id is not None and p.task_id == t.parent_id)


def can_view(p: Principal, t: Task) -> bool:
    return True  # 同团队可见；多团队隔离留作后续


def require_human(p: Principal, what: str) -> None:
    if not is_human(p):
        raise forbidden(f"{what}必须由成员本人操作，Agent 不能代办")


def can_claim(p: Principal, t: Task) -> bool:
    return is_human(p) and p.member_id is not None and t.state == S.SUBMITTED


def can_accept(p: Principal, t: Task) -> bool:
    return is_human(p) and t.state == S.SUBMITTED and p.member_id is not None and p.member_id == t.suggested_assignee_id


def can_assign(p: Principal, t: Task) -> bool:
    return is_human(p) and t.state == S.SUBMITTED and (p.is_admin or is_creator(p, t))


def can_cancel(p: Principal, t: Task) -> bool:
    return is_human(p) and t.state in S.OPEN and (p.is_admin or is_creator(p, t))


def can_edit(p: Principal, t: Task) -> bool:
    if t.state in S.TERMINAL:
        return False
    return p.is_admin or (is_human(p) and (is_creator(p, t) or is_assignee(p, t)))


def can_message(p: Principal, t: Task) -> bool:
    if agent_scoped_to(p, t):
        return True
    return is_human(p) and (p.is_admin or is_creator(p, t) or is_assignee(p, t) or p.member_id == t.suggested_assignee_id)


def can_answer_input(p: Principal, t: Task) -> bool:
    return t.state == S.INPUT_REQUIRED and is_human(p) and (p.is_admin or is_creator(p, t) or is_assignee(p, t))


def can_update_as_owner(p: Principal, t: Task) -> bool:
    """负责人（或其 Agent）更新任务、回报进度。"""
    if agent_scoped_to(p, t) and p.task_id == t.id:
        return True
    return is_human(p) and (p.is_admin or is_assignee(p, t))


def can_request_approval(p: Principal, t: Task) -> bool:
    return t.state in (S.WORKING, S.INPUT_REQUIRED) and can_update_as_owner(p, t)


def can_decide(p: Principal, t: Task, a: Approval) -> bool:
    if a.status != "pending" or not is_human(p):
        return False
    if p.is_admin:
        return True
    return p.has("reviewer") and not is_assignee(p, t)


def can_complete(p: Principal, t: Task, open_mrs: int) -> bool:
    return (
        is_human(p)
        and t.state in (S.WORKING, S.INPUT_REQUIRED, S.AUTH_REQUIRED)
        and open_mrs == 0
        and (p.is_admin or is_creator(p, t))
    )


def can_ask_agent(p: Principal, t: Task) -> bool:
    if p.type == "agent":
        return p.task_id == t.id and p.has("agent_caller")
    return is_human(p) and (p.is_admin or is_assignee(p, t))
