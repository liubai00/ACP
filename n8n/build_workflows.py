"""生成 n8n 工作流 JSON（n8n 1.x）。修改工作流逻辑请改这里再运行：python build_workflows.py

工作流只用环境变量（$env），不依赖 n8n 凭证，导入即可用：
  ACP_API_URL, ACP_CONNECTOR_TOKEN, ACP_NOTIFY_TOKEN, BRIDGE_FORWARD_TOKEN, GITLAB_WEBHOOK_TOKEN,
  FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_BASE_URL, GITLAB_URL, GITLAB_BOT_TOKEN
需要 n8n 设置 N8N_BLOCK_ENV_ACCESS_IN_NODE=false。
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

OUT = Path(__file__).parent / "workflows"
NS = uuid.UUID("6b1f0c1e-acp0-4000-8000-000000000000".replace("acp0", "a0c0"))


def nid(wf: str, name: str) -> str:
    return str(uuid.uuid5(NS, f"{wf}/{name}"))


def webhook(wf: str, path: str, name: str = "接收") -> dict:
    return {
        "parameters": {"httpMethod": "POST", "path": path, "responseMode": "responseNode", "options": {"rawBody": False}},
        "id": nid(wf, name),
        "name": name,
        "type": "n8n-nodes-base.webhook",
        "typeVersion": 2,
        "position": [0, 0],
        "webhookId": nid(wf, "webhook-id"),
    }


def code(wf: str, name: str, js: str, x: int, y: int = 0) -> dict:
    return {
        "parameters": {"mode": "runOnceForAllItems", "jsCode": js.strip()},
        "id": nid(wf, name),
        "name": name,
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [x, y],
    }


def http(wf: str, name: str, *, method: str, url: str, headers: list[tuple[str, str]], body_expr: str | None, x: int, y: int = 0,
         full_response: bool = False) -> dict:
    params: dict = {
        "method": method,
        "url": url,
        "sendHeaders": True,
        "headerParameters": {"parameters": [{"name": k, "value": v} for k, v in headers]},
        "options": {"timeout": 15000},
    }
    if body_expr is not None:
        params.update({"sendBody": True, "specifyBody": "json", "jsonBody": body_expr})
    if full_response:
        params["options"]["response"] = {"response": {"neverError": True}}
    return {"parameters": params, "id": nid(wf, name), "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [x, y]}


def respond(wf: str, name: str, x: int, y: int = 0) -> dict:
    return {
        "parameters": {"respondWith": "json", "responseBody": "={{ JSON.stringify($json) }}", "options": {}},
        "id": nid(wf, name),
        "name": name,
        "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1.1,
        "position": [x, y],
    }


def if_node(wf: str, name: str, left: str, right: str, x: int, y: int = 0) -> dict:
    return {
        "parameters": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose"},
                "conditions": [
                    {"id": nid(wf, name + "-c"), "leftValue": left, "rightValue": right, "operator": {"type": "string", "operation": "equals"}}
                ],
                "combinator": "and",
            },
            "options": {},
        },
        "id": nid(wf, name),
        "name": name,
        "type": "n8n-nodes-base.if",
        "typeVersion": 2,
        "position": [x, y],
    }


def link(*pairs: tuple[str, str] | tuple[str, str, int]) -> dict:
    conns: dict = {}
    for p in pairs:
        src, dst = p[0], p[1]
        out_index = p[2] if len(p) > 2 else 0
        main = conns.setdefault(src, {"main": []})["main"]
        while len(main) <= out_index:
            main.append([])
        main[out_index].append({"node": dst, "type": "main", "index": 0})
    return conns


def workflow(wf_id: str, name: str, nodes: list[dict], connections: dict) -> dict:
    return {
        "id": wf_id,
        "name": name,
        "nodes": nodes,
        "connections": connections,
        "active": False,
        "versionId": str(uuid.uuid5(NS, wf_id + json.dumps([nodes, connections], sort_keys=True, ensure_ascii=False))),
        "settings": {"executionOrder": "v1", "saveDataSuccessExecution": "all", "saveDataErrorExecution": "all", "saveManualExecutions": True},
        "pinData": {},
        "tags": [],
    }


AUTH_ACP = ("Authorization", "=Bearer {{ $env.ACP_CONNECTOR_TOKEN }}")

FEISHU_NORMALIZE = r"""
// 校验 feishu-bridge 的共享密钥，并把飞书原始事件归一化为协调服务器的格式（contracts/API.md 第 3 节）
const out = [];
for (const it of $input.all()) {
  const req = it.json;
  const headers = req.headers || {};
  if ((headers['x-bridge-token'] || '') !== ($env.BRIDGE_FORWARD_TOKEN || '')) {
    throw new Error('X-Bridge-Token 不正确');
  }
  const raw = req.body || {};
  const header = raw.header || {};
  const ev = raw.event || {};
  const t = header.event_type || raw.type || '';
  const base = { event_id: header.event_id || raw.uuid || null, event_type: t, raw };
  if (t === 'im.message.receive_v1') {
    const msg = ev.message || {};
    let text = '';
    try {
      const c = JSON.parse(msg.content || '{}');
      text = c.text || '';
      if (!text && Array.isArray(c.content)) {
        text = c.content.map(line => line.filter(s => s.tag === 'text' || s.tag === 'a').map(s => s.text).join('')).join('\n');
      }
    } catch (e) { text = ''; }
    const botId = raw._acp_bot_open_id;
    const mentions = (msg.mentions || []).map(m => {
      const o = { open_id: (m.id || {}).open_id, name: m.name, key: m.key };
      if (botId) o.is_bot = o.open_id === botId;
      return o;
    });
    out.push({ json: { ...base, kind: 'message', chat_id: msg.chat_id, chat_type: msg.chat_type, message_id: msg.message_id,
      sender_open_id: ((ev.sender || {}).sender_id || {}).open_id, text, mentions } });
  } else if (t === 'card.action.trigger') {
    const action = ev.action || {};
    const ctx = ev.context || {};
    const op = ev.operator || {};
    out.push({ json: { ...base, kind: 'card_action', chat_id: ctx.open_chat_id, message_id: ctx.open_message_id, sender_open_id: op.open_id,
      action: { value: action.value || {}, operator_open_id: op.open_id, open_message_id: ctx.open_message_id,
                form_value: action.form_value || null, input_value: action.input_value || null } } });
  } else if (t.includes('shortcut')) {
    const op = ev.operator || {};
    out.push({ json: { ...base, kind: 'shortcut', chat_id: ev.chat_id || (ev.context || {}).open_chat_id,
      message_id: ev.message_id || (ev.context || {}).open_message_id,
      sender_open_id: (op.operator_id || {}).open_id || op.open_id } });
  } else {
    out.push({ json: { ...base, kind: 'other' } });
  }
}
return out;
"""

GITLAB_NORMALIZE = r"""
// 校验 GitLab Webhook 的 Secret Token，并归一化 push / merge_request / pipeline 事件
const out = [];
for (const it of $input.all()) {
  const req = it.json;
  const headers = req.headers || {};
  if ((headers['x-gitlab-token'] || '') !== ($env.GITLAB_WEBHOOK_TOKEN || '')) {
    throw new Error('X-Gitlab-Token 不正确');
  }
  const raw = req.body || {};
  const kind = raw.object_kind || raw.event_name || '';
  const project = (raw.project || {}).path_with_namespace || '';
  const projectUrl = (raw.project || {}).web_url || null;
  const e = { event_uuid: headers['x-gitlab-event-uuid'] || null, kind, project, project_url: projectUrl,
              user: (raw.user || {}).username || raw.user_username || null };
  if (kind === 'push') {
    e.branch = (raw.ref || '').replace('refs/heads/', '');
    e.sha = raw.after;
  } else if (kind === 'merge_request') {
    const a = raw.object_attributes || {};
    Object.assign(e, { branch: a.source_branch, sha: (a.last_commit || {}).id, mr_iid: a.iid, mr_url: a.url, mr_state: a.state, mr_action: a.action });
  } else if (kind === 'pipeline') {
    const a = raw.object_attributes || {};
    const mr = raw.merge_request || {};
    Object.assign(e, { branch: mr.source_branch || a.ref, sha: a.sha, mr_iid: mr.iid || null, mr_url: mr.url || null,
      pipeline_status: a.status, pipeline_url: projectUrl && a.id ? `${projectUrl}/-/pipelines/${a.id}` : null,
      failed_jobs: (raw.builds || []).filter(b => b.status === 'failed').map(b => ({ name: b.name, stage: b.stage, failure_reason: b.failure_reason })) });
  }
  out.push({ json: e });
}
return out;
"""

NOTIFY_CHECK = r"""
// 校验协调服务器的通知令牌
const out = [];
for (const it of $input.all()) {
  const req = it.json;
  if (((req.headers || {})['x-acp-token'] || '') !== ($env.ACP_NOTIFY_TOKEN || '')) {
    throw new Error('X-ACP-Token 不正确');
  }
  out.push({ json: req.body || {} });
}
return out;
"""

FEISHU_BUILD = r"""
// 根据通知类型组装飞书接口请求：发卡片 / 发文本 / 回复 / 更新卡片
const n = $('校验通知令牌').first().json;
const token = $input.first().json.tenant_access_token;
if (!token) throw new Error('获取 tenant_access_token 失败：' + JSON.stringify($input.first().json));
const base = ($env.FEISHU_BASE_URL || 'https://open.feishu.cn') + '/open-apis/im/v1/messages';
let method = 'POST', url, body;
if (n.kind === 'feishu.card' && n.update_message_id) {
  method = 'PATCH'; url = `${base}/${n.update_message_id}`; body = { content: JSON.stringify(n.card) };
} else {
  const msgType = n.kind === 'feishu.card' ? 'interactive' : 'text';
  const content = JSON.stringify(n.kind === 'feishu.card' ? n.card : { text: n.text });
  if (n.reply_to_message_id) {
    url = `${base}/${n.reply_to_message_id}/reply`; body = { msg_type: msgType, content };
  } else {
    url = `${base}?receive_id_type=${n.receive_id_type}`; body = { receive_id: n.receive_id, msg_type: msgType, content };
  }
}
return [{ json: { method, url, body, token } }];
"""

FEISHU_CHECK = r"""
// 飞书接口返回 code != 0 时让工作流失败，协调服务器会重试
const r = $input.first().json;
if (r.code !== 0) throw new Error(`飞书接口错误 ${r.code}: ${r.msg}`);
return [{ json: { ok: true, data: r.data || {} } }];
"""


def feishu_events() -> dict:
    w = "feishu"
    nodes = [
        webhook(w, "feishu-events"),
        code(w, "校验并归一化", FEISHU_NORMALIZE, 260),
        http(w, "提交协调服务器", method="POST", url="={{ $env.ACP_API_URL }}/api/events/feishu", headers=[AUTH_ACP], body_expr="={{ JSON.stringify($json) }}", x=520),
        respond(w, "返回结果", 780),
    ]
    return workflow("acpFeishuEvents1", "ACP · 飞书事件", nodes, link(("接收", "校验并归一化"), ("校验并归一化", "提交协调服务器"), ("提交协调服务器", "返回结果")))


def gitlab_events() -> dict:
    w = "gitlab"
    nodes = [
        webhook(w, "gitlab"),
        code(w, "校验并归一化", GITLAB_NORMALIZE, 260),
        http(w, "提交协调服务器", method="POST", url="={{ $env.ACP_API_URL }}/api/events/gitlab", headers=[AUTH_ACP], body_expr="={{ JSON.stringify($json) }}", x=520),
        respond(w, "返回结果", 780),
    ]
    return workflow("acpGitlabEvents1", "ACP · GitLab 回执", nodes, link(("接收", "校验并归一化"), ("校验并归一化", "提交协调服务器"), ("提交协调服务器", "返回结果")))


def notify() -> dict:
    w = "notify"
    nodes = [
        webhook(w, "acp-notify"),
        code(w, "校验通知令牌", NOTIFY_CHECK, 240),
        if_node(w, "是 GitLab 评论？", "={{ $json.kind }}", "gitlab.comment", 480),
        http(
            w, "写 MR 评论", method="POST",
            url="={{ $env.GITLAB_URL }}/api/v4/projects/{{ encodeURIComponent($json.project) }}/merge_requests/{{ $json.mr_iid }}/notes",
            headers=[("PRIVATE-TOKEN", "={{ $env.GITLAB_BOT_TOKEN }}")], body_expr="={{ JSON.stringify({ body: $json.body }) }}", x=740, y=-160,
        ),
        respond(w, "返回 GitLab 结果", 1000, -160),
        http(
            w, "取飞书令牌", method="POST", url="={{ ($env.FEISHU_BASE_URL || 'https://open.feishu.cn') }}/open-apis/auth/v3/tenant_access_token/internal",
            headers=[], body_expr="={{ JSON.stringify({ app_id: $env.FEISHU_APP_ID, app_secret: $env.FEISHU_APP_SECRET }) }}", x=740, y=120,
        ),
        code(w, "组装飞书请求", FEISHU_BUILD, 1000, 120),
        http(w, "调飞书接口", method="={{ $json.method }}", url="={{ $json.url }}", headers=[("Authorization", "=Bearer {{ $json.token }}")],
             body_expr="={{ JSON.stringify($json.body) }}", x=1260, y=120, full_response=True),
        code(w, "检查飞书返回", FEISHU_CHECK, 1520, 120),
        respond(w, "返回飞书结果", 1780, 120),
    ]
    conns = link(
        ("接收", "校验通知令牌"),
        ("校验通知令牌", "是 GitLab 评论？"),
        ("是 GitLab 评论？", "写 MR 评论", 0),
        ("是 GitLab 评论？", "取飞书令牌", 1),
        ("写 MR 评论", "返回 GitLab 结果"),
        ("取飞书令牌", "组装飞书请求"),
        ("组装飞书请求", "调飞书接口"),
        ("调飞书接口", "检查飞书返回"),
        ("检查飞书返回", "返回飞书结果"),
    )
    return workflow("acpNotifyOutbox1", "ACP · 通知出口", nodes, conns)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for wf in (feishu_events(), gitlab_events(), notify()):
        path = OUT / f"{wf['id']}.json"
        path.write_text(json.dumps(wf, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        print("written", path.name, wf["name"])


if __name__ == "__main__":
    main()
