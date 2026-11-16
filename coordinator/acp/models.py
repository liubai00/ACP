"""数据模型。任务库是全平台唯一事实来源。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


TS = DateTime(timezone=True)


class Member(Base):
    __tablename__ = "members"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(100))
    feishu_open_id: Mapped[str | None] = mapped_column(String(100), unique=True)
    feishu_union_id: Mapped[str | None] = mapped_column(String(100))
    local_username: Mapped[str | None] = mapped_column(String(100), unique=True)
    avatar_url: Mapped[str | None] = mapped_column(Text)
    email: Mapped[str | None] = mapped_column(String(200))
    gitlab_username: Mapped[str | None] = mapped_column(String(100))
    roles: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=lambda: ["member"])
    team: Mapped[str | None] = mapped_column(String(100))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(TS)


class Agent(Base):
    __tablename__ = "agents"
    __table_args__ = (UniqueConstraint("member_id", "name", name="uq_agent_member_name"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    member_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("members.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(40), default="other")
    version: Mapped[str | None] = mapped_column(String(40))
    host: Mapped[str | None] = mapped_column(String(200))
    skills: Mapped[list[str]] = mapped_column(ARRAY(String(80)), default=list)
    repos: Mapped[list[str]] = mapped_column(ARRAY(String(200)), default=list)
    max_concurrency: Mapped[int] = mapped_column(Integer, default=1)
    auto_accept_help: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="offline")
    card: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(TS)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        Index("ix_tasks_state", "state"),
        Index("ix_tasks_assignee", "assignee_id"),
        Index("ix_tasks_root", "root_id"),
        Index("ix_tasks_updated", "updated_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(start=1), primary_key=True)
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    type: Mapped[str] = mapped_column(String(20), default="requirement")
    state: Mapped[str] = mapped_column(String(20), default="submitted")
    priority: Mapped[str] = mapped_column(String(10), default="normal")
    source: Mapped[str] = mapped_column(String(20), default="board")
    source_ref: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    repos: Mapped[list[str]] = mapped_column(ARRAY(String(200)), default=list)
    skills: Mapped[list[str]] = mapped_column(ARRAY(String(80)), default=list)
    labels: Mapped[list[str]] = mapped_column(ARRAY(String(80)), default=list)
    creator_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))
    assignee_agent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("agents.id", ondelete="SET NULL"))
    suggested_assignee_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))
    requester_agent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("agents.id", ondelete="SET NULL"))
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"))
    root_id: Mapped[int | None] = mapped_column(BigInteger)
    depth: Mapped[int] = mapped_column(Integer, default=0)
    ci_retries: Mapped[int] = mapped_column(Integer, default=0)
    agent_acked: Mapped[bool] = mapped_column(Boolean, default=False)
    # 本轮执行已结束（已推分支 / 开 MR，等 CI 与审批）：不再占用 Agent 的并发名额，也不参与无心跳回收
    agent_run_done: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    run_reason: Mapped[str | None] = mapped_column(String(40))
    feishu_chat_id: Mapped[str | None] = mapped_column(String(100))
    feishu_card_message_id: Mapped[str | None] = mapped_column(String(100))
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    state_changed_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    last_activity_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    closed_at: Mapped[datetime | None] = mapped_column(TS)

    @property
    def key(self) -> str:
        return f"ACP-{self.id}"


class MergeRequest(Base):
    __tablename__ = "merge_requests"
    __table_args__ = (UniqueConstraint("task_id", "repo", "branch", name="uq_mr_task_repo_branch"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(start=1), primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    repo: Mapped[str] = mapped_column(String(200))
    branch: Mapped[str] = mapped_column(String(200))
    iid: Mapped[int | None] = mapped_column(Integer)
    url: Mapped[str | None] = mapped_column(Text)
    state: Mapped[str] = mapped_column(String(20), default="none")
    pipeline_status: Mapped[str] = mapped_column(String(20), default="none")
    sha: Mapped[str | None] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class Event(Base):
    """只追加不修改。任务时间线、审计都从这里读。"""

    __tablename__ = "events"
    __table_args__ = (Index("ix_events_task", "task_id", "id"), Index("ix_events_created", "created_at"))

    id: Mapped[int] = mapped_column(BigInteger, Identity(start=1), primary_key=True)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String(60))
    actor_type: Mapped[str] = mapped_column(String(20), default="system")
    actor_id: Mapped[str | None] = mapped_column(String(64))
    actor_name: Mapped[str] = mapped_column(String(100), default="系统")
    text: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (Index("ix_messages_task", "task_id", "id"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(start=1), primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"))
    sender_type: Mapped[str] = mapped_column(String(20))  # member / agent / system
    sender_id: Mapped[str | None] = mapped_column(String(64))
    sender_name: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(20), default="message")  # message / progress / tool / conclusion / question / answer
    content: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class Approval(Base):
    __tablename__ = "approvals"

    id: Mapped[int] = mapped_column(BigInteger, Identity(start=1), primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    gate: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    note: Mapped[str | None] = mapped_column(Text)
    requested_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))
    decided_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))
    comment: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(TS)


class Suggestion(Base):
    """协调 Agent 或规则引擎给出的建议。建议与执行分开记录。"""

    __tablename__ = "suggestions"

    id: Mapped[int] = mapped_column(BigInteger, Identity(start=1), primary_key=True)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    scenario: Mapped[str] = mapped_column(String(30))
    level: Mapped[str] = mapped_column(String(5))
    status: Mapped[str] = mapped_column(String(20), default="proposed")
    summary: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    undo: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    engine: Mapped[str] = mapped_column(String(20), default="rules")  # rules / llm
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    decided_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))
    decided_at: Mapped[datetime | None] = mapped_column(TS)


class InboundEvent(Base):
    """外部来源事件（飞书、GitLab、任务榜、Agent），兼做幂等去重表。"""

    __tablename__ = "inbound_events"
    __table_args__ = (
        UniqueConstraint("source", "external_id", name="uq_inbound_source_external"),
        Index("ix_inbound_created", "created_at"),
        Index("ix_inbound_source", "source", "created_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(start=1), primary_key=True)
    source: Mapped[str] = mapped_column(String(20))
    kind: Mapped[str] = mapped_column(String(60))
    external_id: Mapped[str | None] = mapped_column(String(200))
    summary: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="processed")
    error: Mapped[str | None] = mapped_column(Text)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"))
    payload: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class Outbox(Base):
    __tablename__ = "outbox"
    __table_args__ = (Index("ix_outbox_pending", "status", "next_attempt_at"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(start=1), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    task_id: Mapped[int | None] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending / sent / failed / skipped
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    last_error: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    sent_at: Mapped[datetime | None] = mapped_column(TS)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class DeviceCode(Base):
    __tablename__ = "device_codes"

    device_code: Mapped[str] = mapped_column(String(100), primary_key=True)
    user_code: Mapped[str] = mapped_column(String(20), unique=True)
    client: Mapped[str] = mapped_column(String(60), default="acp-link")
    hostname: Mapped[str | None] = mapped_column(String(200))
    member_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("members.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending / approved / consumed
    expires_at: Mapped[datetime] = mapped_column(TS)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class ApiToken(Base):
    """长期令牌登记（服务令牌、个人访问令牌），用于吊销。"""

    __tablename__ = "api_tokens"

    jti: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    member_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("members.id", ondelete="CASCADE"))
    roles: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    expires_at: Mapped[datetime | None] = mapped_column(TS)
    revoked_at: Mapped[datetime | None] = mapped_column(TS)
