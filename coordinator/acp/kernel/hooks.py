"""提交后触发的后台动作（例如唤醒协调 Agent）。不阻塞请求；失败只记日志。"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from .core import after_commit

log = logging.getLogger("acp.hooks")

_background: set[asyncio.Task[Any]] = set()
_handlers: dict[str, Callable[..., Awaitable[None]]] = {}


def register(name: str, fn: Callable[..., Awaitable[None]]) -> None:
    _handlers[name] = fn


def spawn(coro: Awaitable[Any]) -> None:
    task = asyncio.ensure_future(coro)
    _background.add(task)

    def _done(t: asyncio.Task[Any]) -> None:
        _background.discard(t)
        if not t.cancelled() and t.exception() is not None:
            log.error("后台任务失败：%r", t.exception())

    task.add_done_callback(_done)


def trigger_after_commit(db: AsyncSession, name: str, **kwargs: Any) -> None:
    def _fire() -> None:
        fn = _handlers.get(name)
        if fn is not None:
            spawn(fn(**kwargs))

    after_commit(db, _fire)


async def drain(timeout: float = 5.0) -> None:
    """测试用：等待所有后台任务结束。"""
    if _background:
        await asyncio.wait(list(_background), timeout=timeout)
