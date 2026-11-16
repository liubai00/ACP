"""进程内发布订阅。单副本部署够用；多副本时替换为 Postgres LISTEN/NOTIFY 实现，接口不变。"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any


class Broker:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue[Any]]] = defaultdict(set)

    def publish(self, channel: str, message: Any) -> int:
        queues = list(self._subs.get(channel, ()))
        for q in queues:
            try:
                q.put_nowait(message)
            except asyncio.QueueFull:
                pass
        return len(queues)

    def subscribers(self, channel: str) -> int:
        return len(self._subs.get(channel, ()))

    @asynccontextmanager
    async def subscribe(self, channel: str, maxsize: int = 1000) -> AsyncIterator[asyncio.Queue[Any]]:
        q: asyncio.Queue[Any] = asyncio.Queue(maxsize=maxsize)
        self._subs[channel].add(q)
        try:
            yield q
        finally:
            self._subs[channel].discard(q)
            if not self._subs[channel]:
                self._subs.pop(channel, None)


broker = Broker()
outbox_wakeup = asyncio.Event()
