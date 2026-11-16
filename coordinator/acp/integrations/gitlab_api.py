"""GitLab 接口（ACP_NOTIFY_MODE=direct 时写 MR 评论用）。"""

from __future__ import annotations

from urllib.parse import quote

import httpx

from ..config import get_settings


class GitLabError(Exception):
    pass


async def mr_comment(project: str, mr_iid: int, body: str) -> dict:
    s = get_settings()
    if not (s.gitlab_url and s.gitlab_bot_token):
        raise GitLabError("ACP_GITLAB_URL / ACP_GITLAB_BOT_TOKEN 未配置")
    url = f"{s.gitlab_url.rstrip('/')}/api/v4/projects/{quote(project, safe='')}/merge_requests/{mr_iid}/notes"
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(url, headers={"PRIVATE-TOKEN": s.gitlab_bot_token}, json={"body": body})
        if r.status_code >= 300:
            raise GitLabError(f"GitLab HTTP {r.status_code}: {r.text[:200]}")
        return r.json()
