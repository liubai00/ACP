# feishu-bridge：飞书事件桥

用飞书长连接（lark-oapi `ws.Client`）接收事件，原样转发给 n8n 的 `feishu-events` Webhook；n8n 不可用时把 `BRIDGE_FORWARD_URL` 改成 `http://coordinator:8000/api/hooks/feishu-bridge` 直连协调服务器。不含业务逻辑，服务器不需要被飞书反向访问。

- 订阅：`im.message.receive_v1`（消息）、`card.action.trigger`（卡片按钮，3 秒内必须响应，桥最多等 2.5 秒拿处理结果，超时先回“处理中”再异步补投）、`BRIDGE_EXTRA_EVENTS` 里列出的其他事件（如消息快捷操作）。
- 启动时取机器人自己的 open_id，附在转发内容的 `_acp_bot_open_id` 字段，协调服务器据此区分 @机器人 和 @其他人。
- 未配置 App ID / Secret 时空转等待，不退出，避免容器反复重启。

环境变量见 `bridge.py` 顶部注释。
