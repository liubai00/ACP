"""运行配置。全部来自环境变量，前缀 ACP_（少数与外部组件共用的变量不带前缀）。"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ACP_", env_file=None, extra="ignore")

    # 基础
    database_url: str = "postgresql+psycopg://acp:acp@localhost:5432/acp"
    public_url: str = "http://localhost:8000"          # 浏览器访问平台的地址，也用作 JWT issuer
    log_level: str = "info"
    env: str = "production"                            # production | development | test

    # JWT
    jwt_private_key_file: str = "/run/secrets/jwt_private"
    jwt_autogen: bool = False                          # 私钥文件不存在时自动生成（仅开发）
    member_token_days: int = 7
    agent_token_hours: int = 2
    jwt_audience: str = "acp"

    # 登录
    admin_username: str = "admin"
    admin_password: str = ""                           # 为空则关闭本地管理员登录
    dev_login: bool = False                            # 开发用假身份登录，生产必须关闭

    # 共享密钥（n8n、feishu-bridge、GitLab Webhook）
    connector_token: str = ""                          # n8n 调协调服务器用的服务令牌
    notify_token: str = ""                             # 协调服务器调 n8n 通知 Webhook 用
    bridge_token: str = Field("", validation_alias=AliasChoices("ACP_BRIDGE_TOKEN", "BRIDGE_FORWARD_TOKEN"))
    gitlab_webhook_token: str = Field("", validation_alias=AliasChoices("ACP_GITLAB_WEBHOOK_TOKEN", "GITLAB_WEBHOOK_TOKEN"))

    # 飞书
    feishu_app_id: str = ""
    feishu_app_secret: str = ""
    feishu_base_url: str = "https://open.feishu.cn"
    feishu_accounts_url: str = "https://accounts.feishu.cn"
    feishu_chat_ids: str = ""                          # 逗号分隔；空表示所有群都受理
    feishu_intake_mode: str = "at_mention,shortcut"    # at_mention / shortcut / all

    # 通知出口：log | n8n | direct
    notify_mode: str = "log"
    n8n_notify_url: str = "http://n8n:5678/webhook/acp-notify"
    n8n_internal_url: str = "http://n8n:5678"
    n8n_public_url: str = ""
    n8n_api_key: str = ""

    # GitLab（direct 模式写 MR 评论时用）
    gitlab_url: str = ""
    gitlab_bot_token: str = ""

    # 协调 Agent（大模型）
    llm_enabled: bool = False
    llm_base_url: str = ""                             # 经网关：http://agentgateway:3001/v1
    llm_api_key: str = ""                              # 经网关时留空，由网关注入
    llm_model: str = ""
    llm_api_style: str = "openai"                      # openai | anthropic
    llm_reasoning_effort: Literal["", "none", "minimal", "low", "medium", "high", "xhigh"] = ""
    agent_level_default: str = "L0"

    # 运行参数
    heartbeat_timeout_minutes: int = 30
    agent_offline_seconds: int = 120
    max_help_depth: int = 2
    max_children_per_root: int = 5
    ci_max_retries: int = 2
    rate_limit_per_minute: int = 600
    seed_demo: bool = False

    @property
    def chat_ids(self) -> list[str]:
        return [c.strip() for c in self.feishu_chat_ids.split(",") if c.strip()]

    @property
    def intake_modes(self) -> list[str]:
        return [c.strip() for c in self.feishu_intake_mode.split(",") if c.strip()]

    @property
    def feishu_enabled(self) -> bool:
        return bool(self.feishu_app_id and self.feishu_app_secret)

    @property
    def issuer(self) -> str:
        return self.public_url.rstrip("/")


@lru_cache
def get_settings() -> Settings:
    return Settings()
