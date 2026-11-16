"""任务状态机。状态直接采用 A2A 1.0 的八个状态。"""

from __future__ import annotations

SUBMITTED = "submitted"
WORKING = "working"
INPUT_REQUIRED = "input-required"
AUTH_REQUIRED = "auth-required"
COMPLETED = "completed"
FAILED = "failed"
CANCELED = "canceled"
REJECTED = "rejected"

ALL_STATES = [SUBMITTED, WORKING, INPUT_REQUIRED, AUTH_REQUIRED, COMPLETED, FAILED, CANCELED, REJECTED]
TERMINAL = {COMPLETED, FAILED, CANCELED, REJECTED}
OPEN = {SUBMITTED, WORKING, INPUT_REQUIRED, AUTH_REQUIRED}

LABELS = {
    SUBMITTED: "待认领",
    WORKING: "进行中",
    INPUT_REQUIRED: "待补充",
    AUTH_REQUIRED: "待审批",
    COMPLETED: "已完成",
    FAILED: "失败",
    CANCELED: "已取消",
    REJECTED: "已拒绝",
}

TRANSITIONS: dict[str, set[str]] = {
    SUBMITTED: {WORKING, CANCELED, REJECTED},
    WORKING: {INPUT_REQUIRED, AUTH_REQUIRED, COMPLETED, FAILED, CANCELED, SUBMITTED},
    INPUT_REQUIRED: {WORKING, CANCELED, FAILED, SUBMITTED},
    AUTH_REQUIRED: {WORKING, COMPLETED, CANCELED, FAILED},
    COMPLETED: set(),
    FAILED: set(),
    CANCELED: set(),
    REJECTED: set(),
}

PRIORITY_LABELS = {"low": "低", "normal": "普通", "high": "高", "urgent": "紧急"}
SOURCE_LABELS = {"feishu": "飞书", "board": "任务榜", "agent": "Agent", "api": "接口", "gitlab": "GitLab"}
TYPE_LABELS = {"requirement": "需求", "subtask": "子任务", "help": "求助"}


def can_transition(src: str, dst: str) -> bool:
    return dst in TRANSITIONS.get(src, set())
