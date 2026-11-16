"""飞书事件桥：用长连接接收飞书事件，原样转发给 n8n（或直连协调服务器）。

不含业务逻辑。服务器不需要被飞书反向访问，只要能出站访问 open.feishu.cn。

环境变量：
  FEISHU_APP_ID / FEISHU_APP_SECRET   飞书自建应用凭证
  FEISHU_DOMAIN                        默认 https://open.feishu.cn（Lark 国际版填 https://open.larksuite.com）
  BRIDGE_FORWARD_URL                   转发地址，默认 http://n8n:5678/webhook/feishu-events
                                       n8n 不可用时可改为 http://coordinator:8000/api/hooks/feishu-bridge
  BRIDGE_FORWARD_TOKEN                 转发时放在 X-Bridge-Token 头里的共享密钥
  BRIDGE_EXTRA_EVENTS                  额外订阅的事件类型，逗号分隔（例如消息快捷操作的事件类型）
  BRIDGE_CARD_TIMEOUT                  卡片按钮等待处理结果的秒数，默认 2.5（飞书要求 3 秒内响应）
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx
import lark_oapi as lark
from lark_oapi.event.callback.model.p2_card_action_trigger import (
    P2CardActionTrigger,
    P2CardActionTriggerResponse,
)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s bridge: %(message)s")
log = logging.getLogger("bridge")

APP_ID = os.environ.get("FEISHU_APP_ID", "")
APP_SECRET = os.environ.get("FEISHU_APP_SECRET", "")
DOMAIN = os.environ.get("FEISHU_DOMAIN", "https://open.feishu.cn")
FORWARD_URL = os.environ.get("BRIDGE_FORWARD_URL", "http://n8n:5678/webhook/feishu-events")
FORWARD_TOKEN = os.environ.get("BRIDGE_FORWARD_TOKEN", "")
EXTRA_EVENTS = [e.strip() for e in os.environ.get("BRIDGE_EXTRA_EVENTS", "").split(",") if e.strip()]
CARD_TIMEOUT = float(os.environ.get("BRIDGE_CARD_TIMEOUT", "2.5"))

_pool = ThreadPoolExecutor(max_workers=8)
_http = httpx.Client(timeout=15)
_bot_open_id: str | None = None


def _fetch_bot_open_id() -> None:
    global _bot_open_id
    try:
        r = _http.post(f"{DOMAIN}/open-apis/auth/v3/tenant_access_token/internal", json={"app_id": APP_ID, "app_secret": APP_SECRET})
        token = r.json().get("tenant_access_token")
        r = _http.get(f"{DOMAIN}/open-apis/bot/v3/info", headers={"Authorization": f"Bearer {token}"})
        _bot_open_id = (r.json().get("bot") or {}).get("open_id")
        log.info("机器人 open_id: %s", _bot_open_id)
    except Exception as exc:  # noqa: BLE001
        log.warning("获取机器人信息失败（不影响转发）：%s", exc)


def _raw(data: Any) -> dict[str, Any]:
    raw = json.loads(lark.JSON.marshal(data))
    if _bot_open_id:
        raw["_acp_bot_open_id"] = _bot_open_id
    return raw


def _post(raw: dict[str, Any], timeout: float) -> dict[str, Any] | None:
    for attempt in range(3):
        try:
            r = _http.post(FORWARD_URL, json=raw, headers={"X-Bridge-Token": FORWARD_TOKEN}, timeout=timeout)
            if r.status_code < 300:
                try:
                    return r.json()
                except ValueError:
                    return {}
            log.warning("转发返回 HTTP %s：%s", r.status_code, r.text[:200])
            if r.status_code < 500:
                return None
        except httpx.HTTPError as exc:
            log.warning("转发失败（第 %s 次）：%s", attempt + 1, exc)
            if timeout < 5:
                return None
        time.sleep(1 + attempt * 2)
    return None


def _forward_async(raw: dict[str, Any]) -> None:
    etype = (raw.get("header") or {}).get("event_type")
    log.info("收到事件 %s %s", etype, (raw.get("header") or {}).get("event_id"))
    _pool.submit(_post, raw, 15)


def on_message(data: lark.im.v1.P2ImMessageReceiveV1) -> None:
    _forward_async(_raw(data))


def on_custom(data: lark.CustomizedEvent) -> None:
    _forward_async(_raw(data))


def on_card_action(data: P2CardActionTrigger) -> P2CardActionTriggerResponse:
    raw = _raw(data)
    log.info("收到卡片回调 %s", (raw.get("header") or {}).get("event_id"))
    result = _post(raw, CARD_TIMEOUT)
    body: dict[str, Any] = {}
    if result is None:
        body["toast"] = {"type": "info", "content": "已收到，处理中"}
        # 超时也要确保事件最终送达：异步再投一次（协调服务器按 event_id 去重）
        _pool.submit(_post, raw, 15)
    else:
        toast = result.get("toast") or (result.get("json") or {}).get("toast") if isinstance(result, dict) else None
        body["toast"] = toast or {"type": "success", "content": "已处理"}
        card = result.get("card") if isinstance(result, dict) else None
        if card:
            body["card"] = {"type": "raw", "data": card}
    return P2CardActionTriggerResponse(body)


def main() -> None:
    if not (APP_ID and APP_SECRET):
        log.error("未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，事件桥空转等待配置（不会退出，避免容器反复重启）")
        while True:
            time.sleep(3600)
    threading.Thread(target=_fetch_bot_open_id, daemon=True).start()
    builder = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(on_message)
        .register_p2_card_action_trigger(on_card_action)
    )
    for etype in EXTRA_EVENTS:
        builder = builder.register_p2_customized_event(etype, on_custom)
        log.info("额外订阅事件 %s", etype)
    handler = builder.build()
    log.info("连接飞书长连接，转发到 %s", FORWARD_URL)
    client = lark.ws.Client(APP_ID, APP_SECRET, event_handler=handler, domain=DOMAIN, log_level=lark.LogLevel.INFO, auto_reconnect=True)
    client.start()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
