"""task.agent_run_done: finished agent runs no longer hold agent capacity

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-09 08:30:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('tasks', sa.Column('agent_run_done', sa.Boolean(), nullable=False, server_default=sa.false()))
    # 已交过分支 / MR 的进行中任务视为本轮已结束
    op.execute(
        "UPDATE tasks SET agent_run_done = true WHERE state = 'working' "
        "AND EXISTS (SELECT 1 FROM merge_requests m WHERE m.task_id = tasks.id)"
    )


def downgrade() -> None:
    op.drop_column('tasks', 'agent_run_done')
