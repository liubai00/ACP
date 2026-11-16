"""应用入口：uvicorn acp.main:app"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import __version__
from .agent.scenarios import register as register_scenarios
from .api import a2a, auth, misc, tasks
from .api.mcp_server import mcp
from .config import get_settings
from .db import dispose
from .kernel.errors import ApiError
from .kernel.feishu_inbox import inbox_worker
from .kernel.jobs import scheduler
from .kernel.notify import outbox_worker
from .security import jwks

log = logging.getLogger("acp")


def _setup_logging() -> None:
    level = getattr(logging, get_settings().log_level.upper(), logging.INFO)
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def create_app(*, background: bool = True) -> FastAPI:
    _setup_logging()
    mcp_app = mcp.streamable_http_app()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        jwks()  # 启动时就加载私钥，缺失立即报错
        register_scenarios()
        stop = asyncio.Event()
        workers: list[asyncio.Task] = []
        if background:
            workers = [asyncio.create_task(worker(stop)) for worker in (outbox_worker, inbox_worker, scheduler)]
        async with mcp.session_manager.run():
            log.info("ACP coordinator %s 启动，对外地址 %s", __version__, get_settings().issuer)
            try:
                yield
            finally:
                stop.set()
                for w in workers:
                    w.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
                await dispose()

    app = FastAPI(title="ACP Coordinator", version=__version__, lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return JSONResponse({"error": exc.code, "message": exc.message}, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        return JSONResponse({"error": "validation_error", "message": "参数不正确", "detail": exc.errors()[:5]}, status_code=422)

    app.include_router(auth.router)
    app.include_router(tasks.router)
    app.include_router(misc.router)
    app.include_router(a2a.router)
    for route in mcp_app.routes:  # /mcp
        app.router.routes.append(route)
    return app


app = create_app()
