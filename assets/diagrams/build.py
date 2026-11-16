#!/usr/bin/env python3
"""生成 README 用的示意图（SVG，明暗两套 × 中英两种）。

用法：python3 assets/diagrams/build.py
产物：assets/flow-{zh,en}-{light,dark}.svg、assets/architecture-{zh,en}-{light,dark}.svg

只依赖标准库。改文案或配色后重新运行即可，不要手改生成的 SVG。
"""
from __future__ import annotations

import html
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent
W = 840

SANS = ("-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB',"
        "'Microsoft YaHei','Noto Sans CJK SC','WenQuanYi Zen Hei',sans-serif")
MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace"

# 配色：四种角色各一套（底色、描边、强调、文字），明暗各一份
THEMES = {
    "light": {
        "bg": "#F8FAFC", "border": "#E2E8F0", "surface": "#FFFFFF", "surface_border": "#E2E8F0",
        "text": "#0F172A", "muted": "#64748B", "faint": "#94A3B8", "arrow": "#94A3B8",
        "fail": "#DC2626", "shadow": "0.07",
        "human": {"fill": "#FFFBEB", "stroke": "#FCD34D", "accent": "#D97706", "text": "#B45309"},
        "acp": {"fill": "#EFF6FF", "stroke": "#BFDBFE", "accent": "#2563EB", "text": "#1D4ED8"},
        "agent": {"fill": "#ECFDF5", "stroke": "#A7F3D0", "accent": "#059669", "text": "#047857"},
        "git": {"fill": "#F5F3FF", "stroke": "#DDD6FE", "accent": "#7C3AED", "text": "#6D28D9"},
        "plain": {"fill": "#FFFFFF", "stroke": "#CBD5E1", "accent": "#64748B", "text": "#475569"},
    },
    "dark": {
        "bg": "#0F141B", "border": "#232B36", "surface": "#161C25", "surface_border": "#2A3442",
        "text": "#E6EDF3", "muted": "#93A1B3", "faint": "#6B7889", "arrow": "#5E6B7D",
        "fail": "#F87171", "shadow": "0.35",
        "human": {"fill": "#2A2110", "stroke": "#8A6116", "accent": "#F5A524", "text": "#FBBF24"},
        "acp": {"fill": "#101E38", "stroke": "#274B8C", "accent": "#5B9BFF", "text": "#8DB8FF"},
        "agent": {"fill": "#0E2A20", "stroke": "#1B6B50", "accent": "#34D399", "text": "#6EE7B7"},
        "git": {"fill": "#1E1838", "stroke": "#473A8A", "accent": "#A78BFA", "text": "#C4B5FD"},
        "plain": {"fill": "#161C25", "stroke": "#3A4656", "accent": "#93A1B3", "text": "#B6C2D0"},
    },
}


def est(s: str, size: float, mono: bool = False, bold: bool = False) -> float:
    """粗略估算文字宽度：中日韩与全角符号按 1em，其余按经验系数。"""
    w = 0.0
    for ch in s:
        o = ord(ch)
        if o >= 0x2E80 or ch in "，。：；（）、！？—…·":
            w += 1.0 if ch != "·" else 0.5
        elif mono:
            w += 0.6
        elif ch == " ":
            w += 0.28
        elif ch in "ilI.,:;'|!/()[]":
            w += 0.3
        elif ch in "mwMW@":
            w += 0.88
        elif ch.isupper():
            w += 0.68
        else:
            w += 0.55
    return w * size * (1.04 if bold else 1.0)


class Svg:
    def __init__(self, height: int, theme: dict):
        self.h = height
        self.t = theme
        self.defs: list[str] = []
        self.body: list[str] = []
        self._markers: set[str] = set()

    # ---- 基础图元 ----
    def add(self, s: str) -> None:
        self.body.append(s)

    def rect(self, x, y, w, h, r=10, fill="none", stroke="none", sw=1.0, extra="") -> None:
        self.add(f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{r:g}" fill="{fill}" '
                 f'stroke="{stroke}" stroke-width="{sw:g}"{(" " + extra) if extra else ""}/>')

    def text(self, x, y, s, size=12, weight=400, fill=None, anchor="start", mono=False, ls=None, extra="") -> None:
        fill = fill or self.t["text"]
        fam = f' font-family="{MONO}"' if mono else ""
        lsp = f' letter-spacing="{ls:g}"' if ls else ""
        self.add(f'<text x="{x:g}" y="{y:g}" font-size="{size:g}" font-weight="{weight}" fill="{fill}" '
                 f'text-anchor="{anchor}"{fam}{lsp}{(" " + extra) if extra else ""}>{html.escape(s)}</text>')

    def marker(self, color: str) -> str:
        mid = "m" + color.lstrip("#")
        if mid not in self._markers:
            self._markers.add(mid)
            self.defs.append(
                f'<marker id="{mid}" viewBox="0 0 10 10" refX="8.2" refY="5" markerWidth="7" markerHeight="7" '
                f'orient="auto-start-reverse"><path d="M1.2 1.6 8.6 5 1.2 8.4" fill="none" stroke="{color}" '
                f'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></marker>')
        return mid

    def line(self, pts, color=None, sw=1.5, dashed=False, start=False, end=True, r=8) -> None:
        """折线，拐角做圆角；pts 为 [(x, y), ...]。"""
        color = color or self.t["arrow"]
        d = f"M{pts[0][0]:g} {pts[0][1]:g}"
        for i in range(1, len(pts)):
            x, y = pts[i]
            if i < len(pts) - 1:
                px, py = pts[i - 1]
                nx, ny = pts[i + 1]
                # 进入拐角前停在 r 处，再用二次曲线转弯
                def toward(ax, ay, bx, by, dist):
                    dx, dy = bx - ax, by - ay
                    ln = (dx * dx + dy * dy) ** 0.5 or 1
                    k = min(dist, ln / 2) / ln
                    return ax + dx * k, ay + dy * k
                ex, ey = toward(x, y, px, py, r)
                sx, sy = toward(x, y, nx, ny, r)
                d += f" L{ex:g} {ey:g} Q{x:g} {y:g} {sx:g} {sy:g}"
            else:
                d += f" L{x:g} {y:g}"
        mid = self.marker(color)
        attrs = f'fill="none" stroke="{color}" stroke-width="{sw:g}" stroke-linecap="round" stroke-linejoin="round"'
        if dashed:
            attrs += ' stroke-dasharray="5 4.5"'
        if end:
            attrs += f' marker-end="url(#{mid})"'
        if start:
            attrs += f' marker-start="url(#{mid})"'
        self.add(f'<path d="{d}" {attrs}/>')

    def pill(self, x, y, s, size=10, fg="#fff", bg="#000", stroke="none", mono=False, weight=600,
             anchor="start", padx=7, h=None) -> float:
        """圆角标签；x 为左缘（anchor=start）、右缘（end）或中心（middle），y 为垂直中心。返回宽度。"""
        h = h or size + 8
        w = est(s, size, mono=mono, bold=weight >= 600) + padx * 2
        if anchor == "end":
            x0 = x - w
        elif anchor == "middle":
            x0 = x - w / 2
        else:
            x0 = x
        self.rect(x0, y - h / 2, w, h, r=h / 2, fill=bg, stroke=stroke)
        self.text(x0 + w / 2, y + size * 0.36, s, size=size, weight=weight, fill=fg, anchor="middle", mono=mono)
        return w

    def render(self, title: str) -> str:
        t = self.t
        shadow = (f'<filter id="sh" x="-10%" y="-10%" width="120%" height="140%">'
                  f'<feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="{t["shadow"]}"/></filter>')
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {self.h}" width="{W}" height="{self.h}" '
            f'role="img" aria-label="{html.escape(title)}" font-family="{SANS}">\n'
            f'<title>{html.escape(title)}</title>\n<defs>{shadow}{"".join(self.defs)}</defs>\n'
            f'<rect x="0.5" y="0.5" width="{W - 1}" height="{self.h - 1}" rx="16" fill="{t["bg"]}" stroke="{t["border"]}"/>\n'
            + "\n".join(self.body) + "\n</svg>\n")


# ---------------------------------------------------------------- 图一：一条需求的一生

FLOW = {
    "zh": {
        "aria": "一条需求从飞书群里的一句话到合并的 MR：十个步骤，两处人工确认，两条回环",
        "title": "一条需求的一生",
        "subtitle": "从群里的一句话，到合并进主干的 MR。人只在两处点确认，其余由平台和各自的 Agent 接力。",
        "actors": {"human": "飞书 · 人", "acp": "派活 协调", "agent": "开发者电脑", "git": "GitLab"},
        "gate": "人工确认",
        "steps": [
            ("human", "群里说一句话", ["@机器人 或私聊它", "用自己的话交代工作"], None, False),
            ("acp", "理解意图，建单", ["交办建单，咨询直答", "说不清楚就追问"], "submitted", False),
            ("human", "成员认领", ["本人点了确认", "才会在他的电脑上开工"], None, True),
            ("acp", "派工下发", ["沿出站长连接推送", "开发机无需公网地址"], "working", False),
            ("agent", "个人 Agent 执行", ["Claude Code / Codex", "隔离工作区，过程可见"], None, False),
            ("git", "推分支，开 MR", ["用开发者自己的身份", "流水线随即开跑"], None, False),
            ("acp", "CI 通过，停下", ["任务停在审批卡点", "等评审者表态"], "auth-required", False),
            ("human", "评审者审批", ["飞书卡片上点同意", "卡片附 MR 与 CI 结果"], None, True),
            ("git", "合并 MR", ["由人或 GitLab 规则", "平台从不自动合并"], None, False),
            ("acp", "关单，回群汇报", ["耗时、MR、参与者", "全程留痕，可回放"], "completed", False),
        ],
        "loop_ci": "CI 失败：日志回传给 Agent 自修，最多 2 次",
        "loop_reject": "审批拒绝：附意见退回，Agent 接着改",
        "legend": [("human", "人（在飞书里点确认）"), ("acp", "派活 协调服务器"),
                   ("agent", "开发者电脑上的个人 Agent"), ("git", "GitLab")],
        "legend_loop": "虚线为回环",
        "title_size": 14, "sub_size": 10.6,
    },
    "en": {
        "aria": "A request's journey from one chat message to a merged MR: ten steps, two human gates, two loops",
        "title": "The life of a request",
        "subtitle": "From one chat message to a merged MR. Humans click twice; the platform and each developer's own agent do the rest.",
        "actors": {"human": "CHAT · HUMAN", "acp": "COORDINATOR", "agent": "DEV MACHINE", "git": "GITLAB"},
        "gate": "HUMAN GATE",
        "steps": [
            ("human", "Say it in chat", ["@ the bot or DM it,", "in plain language"], None, False),
            ("acp", "Parse & file", ["Work becomes a task;", "questions get answers"], "submitted", False),
            ("human", "Claim it", ["Nothing runs on a dev", "machine until they click"], None, True),
            ("acp", "Dispatch", ["Sent over an outbound", "stream; no public IP"], "working", False),
            ("agent", "Agent executes", ["Claude Code / Codex in", "an isolated worktree"], None, False),
            ("git", "Branch · MR · CI", ["Pushed with the dev's", "own git identity"], None, False),
            ("acp", "CI green: hold", ["Task parks at the", "approval gate"], "auth-required", False),
            ("human", "Review & approve", ["One click on a chat card", "showing MR + CI result"], None, True),
            ("git", "Merge", ["By a human or GitLab", "rules, not the platform"], None, False),
            ("acp", "Close & report", ["Summary posted back;", "full timeline kept"], "completed", False),
        ],
        "loop_ci": "CI fails: logs go back to the agent to self-fix (max 2 tries)",
        "loop_reject": "Rejected: review comments go back to the agent",
        "legend": [("human", "Human (confirms in chat)"), ("acp", "Paihuo coordinator"),
                   ("agent", "Personal agent on the dev machine"), ("git", "GitLab")],
        "legend_loop": "dashed = loop",
        "title_size": 13.5, "sub_size": 10.2,
    },
}


def build_flow(lang: str, theme_name: str) -> str:
    t = THEMES[theme_name]
    L = FLOW[lang]
    H = 438
    s = Svg(H, t)

    s.text(28, 40, L["title"], size=17, weight=700)
    s.text(28, 61, L["subtitle"], size=12, fill=t["muted"])

    cw, ch, gap = 142, 104, 20.5
    x0, y1, y2 = 24, 92, 270
    xs = [x0 + i * (cw + gap) for i in range(5)]

    def card(i: int, x: float, y: float) -> None:
        role, title, subs, state, gate = L["steps"][i]
        c = t[role]
        sw = 1.6 if gate else 1.0
        stroke = c["accent"] if gate else c["stroke"]
        s.rect(x, y, cw, ch, r=12, fill=c["fill"], stroke=stroke, sw=sw, extra='filter="url(#sh)"')
        # 步骤号
        s.add(f'<circle cx="{x + 20:g}" cy="{y + 22:g}" r="10.5" fill="{c["accent"]}"/>')
        s.text(x + 20, y + 26, str(i + 1), size=11, weight=700, fill=t["bg"] if theme_name == "dark" else "#FFFFFF",
               anchor="middle")
        s.text(x + 37, y + 26, L["actors"][role], size=10.5 if lang == "zh" else 9.3, weight=700, fill=c["text"],
               ls=0.4 if lang == "zh" else 0.7)
        s.text(x + 14, y + 55, title, size=L["title_size"], weight=700)
        for k, line in enumerate(subs):
            s.text(x + 14, y + 74 + k * 15, line, size=L["sub_size"], fill=t["muted"])
        if gate:
            s.pill(x + cw - 10, y, L["gate"], size=9.5, fg=t["bg"] if theme_name == "dark" else "#FFFFFF",
                   bg=c["accent"], anchor="end", weight=700)
        elif state:
            s.pill(x + cw - 10, y, state, size=9.5, fg=c["text"], bg=t["bg"], stroke=c["stroke"], mono=True,
                   anchor="end", weight=600)

    # 第一行从左到右，第二行从右到左（第 6 步在第 5 步正下方）
    for i in range(5):
        card(i, xs[i], y1)
    for i in range(5):
        card(5 + i, xs[4 - i], y2)

    ym1, ym2 = y1 + ch / 2, y2 + ch / 2
    for i in range(4):
        s.line([(xs[i] + cw + 3, ym1), (xs[i + 1] - 3.5, ym1)])
        s.line([(xs[4 - i] - 3, ym2), (xs[3 - i] + cw + 3.5, ym2)])

    # 5 → 6 主线，以及两条回环
    x5 = xs[4]
    top, bot = y1 + ch, y2
    s.line([(x5 + cw - 22, top + 4), (x5 + cw - 22, bot - 4.5)])
    fail = t["fail"]
    s.line([(x5 + cw / 2, bot - 4), (x5 + cw / 2, top + 4.5)], color=fail, dashed=True)
    rej = t["human"]["accent"]
    x8 = xs[2] + cw / 2
    yr = top + 26
    x8 = xs[2] + 46
    s.line([(x8, bot - 4), (x8, yr), (x5 + 22, yr), (x5 + 22, top + 4.5)], color=rej, dashed=True)
    s.text((x8 + x5 + 22) / 2, yr - 7, L["loop_reject"], size=11, fill=t["human"]["text"], anchor="middle", weight=600)
    s.text(x5 + cw / 2 - 10, bot - 14, L["loop_ci"], size=11, fill=fail, anchor="end", weight=600)

    # 图例
    ly = H - 26
    lx = 28
    for role, label in L["legend"]:
        c = t[role]
        s.rect(lx, ly - 6, 12, 12, r=3.5, fill=c["fill"], stroke=c["accent"], sw=1.3)
        s.text(lx + 18, ly + 4, label, size=11, fill=t["muted"])
        lx += 18 + est(label, 11) + 22
    s.add(f'<path d="M{W - 28 - est(L["legend_loop"], 11) - 34:g} {ly} h26" stroke="{t["faint"]}" stroke-width="1.5" '
          f'stroke-dasharray="5 4.5" stroke-linecap="round"/>')
    s.text(W - 28, ly + 4, L["legend_loop"], size=11, fill=t["muted"], anchor="end")
    return s.render(L["aria"])


# ---------------------------------------------------------------- 图二：总体架构

ARCH = {
    "zh": {
        "aria": "派活 总体架构：入口、连接与编排、网关、协调服务器、开发者电脑五层，右侧为 GitLab",
        "title": "总体架构",
        "subtitle": "自研的只有协调服务器、接入程序、任务榜和一个很小的事件桥，其余用现成组件拼装。",
        "entry": "入口",
        "board": ("任务榜 Web", "React · 实时时间线"),
        "feishu": ("飞书", "群聊 @机器人 · 私聊 · 快捷操作 · 审批卡片"),
        "glue": "连接与编排",
        "bridge": ("feishu-bridge", "飞书长连接事件桥"),
        "n8n": ("n8n", "飞书事件 · GitLab 回执 · 通知出口"),
        "gw_label": "网关",
        "caddy": ("Caddy", "TLS"),
        "gw": ("agentgateway", "JWT 验签 · CEL 工具白名单 · 审计 · 代理大模型"),
        "coord": "协调服务器",
        "coord_en": "coordinator · Python / FastAPI",
        "motto": "模型提议，规则裁决",
        "faces": [("/a2a", "A2A 1.0"), ("/mcp", "MCP 工具"), ("/api", "REST + SSE")],
        "shell": ("协调 Agent 外壳", "大模型", ["理解需求 · 拆解 · 推荐派工", "归类 CI 失败 · 回答提问 · 巡检"]),
        "shell_levels": "L0 只建议  L1 先做再通知  L2 全自动",
        "same_tools": ["建议落地", "只走内核"],
        "kernel": ("确定性内核", "代码", ["任务库 · A2A 八态状态机", "权限矩阵 · 审批卡点 · 派工规则"]),
        "kernel_note": "模型不可用时照常运行",
        "pg": "PostgreSQL 16 · 唯一事实来源 · 事件只追加",
        "gitlab": "GitLab",
        "gitlab_note": ["代码与合并权", "始终在这里"],
        "gitlab_chips": ["任务分支", "Merge Request", "CI 流水线", "人工合并"],
        "gitlab_events": "事件",
        "webhook": "Webhook",
        "rest": "REST · SSE",
        "nat": "内网边界：开发者电脑只发起出站连接，不开任何入站端口",
        "sub": "出站 A2A 订阅（SSE 长连接）",
        "push": "git push（开发者自己的凭证，不经平台）",
        "dev": "开发者电脑 × N",
        "link": ("acp-link", "Go 单二进制 · 设备授权登录"),
        "agent": ("个人 Agent", "Claude Code / Codex · 各人自己的账号"),
        "wt": ("git worktree", "每个任务一个隔离工作区"),
        "legend": [("acp", "自研"), ("plain", "现成组件"), ("agent", "开发者本机"), ("git", "代码与 CI")],
    },
    "en": {
        "aria": "Paihuo architecture: entry points, glue, gateway, coordinator and developer machines, with GitLab on the right",
        "title": "Architecture",
        "subtitle": "Only the coordinator, the connector, the board and a tiny event bridge are custom. Everything else is off the shelf.",
        "entry": "ENTRY",
        "board": ("Task board", "React · live timeline"),
        "feishu": ("Feishu / Lark", "group @bot · DM · message shortcut · approval cards"),
        "glue": "GLUE",
        "bridge": ("feishu-bridge", "long-lived event bridge"),
        "n8n": ("n8n", "chat events · GitLab hooks · notify"),
        "gw_label": "GATEWAY",
        "caddy": ("Caddy", "TLS"),
        "gw": ("agentgateway", "JWT · CEL tool allowlist · audit · LLM proxy"),
        "coord": "Coordinator",
        "coord_en": "Python / FastAPI",
        "motto": "The model proposes, the kernel decides",
        "faces": [("/a2a", "A2A 1.0"), ("/mcp", "MCP tools"), ("/api", "REST + SSE")],
        "shell": ("Agent shell", "LLM", ["Parse requests · split · suggest", "Triage CI failures · answer · patrol"]),
        "shell_levels": "L0 suggest  L1 act + notify  L2 auto",
        "same_tools": ["acts only via", "kernel calls"],
        "kernel": ("Deterministic kernel", "code", ["Task store · 8-state A2A machine", "Permissions · approval gates · dispatch"]),
        "kernel_note": "keeps running without the model",
        "pg": "PostgreSQL 16 · single source of truth · append-only events",
        "gitlab": "GitLab",
        "gitlab_note": ["Code and merge", "rights stay here"],
        "gitlab_chips": ["task branch", "Merge Request", "CI pipeline", "human merge"],
        "gitlab_events": "events",
        "webhook": "Webhook",
        "rest": "REST · SSE",
        "nat": "NAT boundary: dev machines only dial out, no inbound ports",
        "sub": "outbound A2A subscription (SSE)",
        "push": "git push (the dev's own credentials, bypasses the platform)",
        "dev": "DEVELOPER MACHINES × N",
        "link": ("acp-link", "single Go binary · device login"),
        "agent": ("Personal agent", "Claude Code / Codex · the dev's own account"),
        "wt": ("git worktree", "one isolated workspace per task"),
        "legend": [("acp", "custom-built"), ("plain", "off the shelf"), ("agent", "on the dev machine"), ("git", "code & CI")],
    },
}


def build_arch(lang: str, theme_name: str) -> str:
    t = THEMES[theme_name]
    L = ARCH[lang]
    H = 792
    s = Svg(H, t)
    zh = lang == "zh"

    s.text(28, 40, L["title"], size=17, weight=700)
    s.text(28, 61, L["subtitle"], size=12, fill=t["muted"])

    SX, SR = 76, 692          # 中间主栈的左右边
    GX, GW = 712, 104         # 右侧 GitLab 立柱

    def band_label(x, y, label):
        s.text(x, y, label, size=10.5 if zh else 9.5, weight=700, fill=t["faint"], ls=1.0 if zh else 1.2)

    def node(x, y, w, h, role, title, sub=None, title_size=13.5, sub_size=10.8, mono_title=False, center=False):
        c = t[role]
        s.rect(x, y, w, h, r=10, fill=c["fill"], stroke=c["stroke"], extra='filter="url(#sh)"')
        s.add(f'<rect x="{x + 0.5:g}" y="{y + 9:g}" width="3" height="{h - 18:g}" rx="1.5" fill="{c["accent"]}"/>')
        if center:
            s.text(x + w / 2, y + h / 2 - (4 if sub else -5), title, size=title_size, weight=700, anchor="middle",
                   mono=mono_title)
            if sub:
                s.text(x + w / 2, y + h / 2 + 13, sub, size=sub_size, fill=t["muted"], anchor="middle")
        else:
            s.text(x + 16, y + (h / 2 - 4 if sub else h / 2 + 5), title, size=title_size, weight=700, mono=mono_title)
            if sub:
                s.text(x + 16, y + h / 2 + 13, sub, size=sub_size, fill=t["muted"])

    # ---- 入口
    y = 84
    band_label(SX, y + 2, L["entry"])
    y += 12
    node(SX, y, 176, 54, "acp", *L["board"])
    node(SX + 196, y, SR - SX - 196, 54, "plain", *L["feishu"])
    entry_bot = y + 54                                   # 150

    # ---- 连接与编排（只在飞书下面）
    y = 190
    gx0 = SX + 196
    band_label(gx0, y - 8, L["glue"])
    node(gx0, y, 190, 54, "acp", *L["bridge"], mono_title=True)
    node(gx0 + 210, y, SR - gx0 - 210, 54, "plain", *L["n8n"])
    glue_bot = y + 54                                    # 244
    # 飞书 → 事件桥 → n8n
    s.line([(gx0 + 95, entry_bot + 4), (gx0 + 95, y - 4.5)])
    s.line([(gx0 + 190 + 3, y + 27), (gx0 + 210 - 3.5, y + 27)])
    # n8n ↔ GitLab
    s.line([(SR + 3.5, y + 27), (GX - 3.5, y + 27)], start=True)
    s.text((SR + GX) / 2, y + 18, "", size=9)

    # ---- 网关
    y = 290
    band_label(SX + 112, y - 8, L["gw_label"])
    node(SX, y, 92, 50, "plain", *L["caddy"], center=True)
    node(SX + 112, y, SR - SX - 112, 50, "plain", *L["gw"])
    gw_bot = y + 50                                      # 340
    s.line([(SX + 92 + 3, y + 25), (SX + 112 - 3.5, y + 25)])
    # 任务榜 → 网关（穿过左侧空档）
    bx = SX + 46
    s.line([(bx, entry_bot + 4), (bx, y - 4.5)])
    s.pill(bx + 10, (entry_bot + y) / 2, L["rest"], size=10, fg=t["muted"], bg=t["bg"], stroke=t["border"], weight=600)
    # n8n → 网关
    nx = gx0 + 210 + (SR - gx0 - 210) / 2
    s.line([(nx, glue_bot + 4), (nx, y - 4.5)])
    s.pill(nx + 10, (glue_bot + y) / 2, "REST", size=10, fg=t["muted"], bg=t["bg"], stroke=t["border"], weight=600)

    # ---- 协调服务器
    cy0, cy1 = 372, 592
    c = t["acp"]
    s.rect(SX, cy0, SR - SX, cy1 - cy0, r=14, fill=c["fill"], stroke=c["accent"], sw=1.6, extra='filter="url(#sh)"')
    s.line([((SX + 112 + SR) / 2, gw_bot + 4), ((SX + 112 + SR) / 2, cy0 - 4.5)])
    s.text(SX + 18, cy0 + 28, L["coord"], size=15, weight=700)
    s.text(SX + 18 + est(L["coord"], 15, bold=True) + 10, cy0 + 28, L["coord_en"], size=11, fill=t["muted"], mono=zh)
    s.pill(SR - 16, cy0 + 23, L["motto"], size=11, fg=t["bg"] if theme_name == "dark" else "#FFFFFF", bg=c["accent"],
           anchor="end", weight=700, padx=10, h=22)
    # 三个面
    fy = cy0 + 44
    fw = (SR - SX - 36 - 2 * 10) / 3
    for i, (path, name) in enumerate(L["faces"]):
        fx = SX + 18 + i * (fw + 10)
        s.rect(fx, fy, fw, 30, r=8, fill=t["surface"], stroke=c["stroke"])
        s.text(fx + 12, fy + 19.5, path, size=11.5, weight=700, fill=c["text"], mono=True)
        s.text(fx + fw - 12, fy + 19.5, name, size=11.5, fill=t["text"], anchor="end", weight=600)
    # 外壳 → 内核
    by = fy + 44
    bh = 92
    lw = 236
    rw = 236
    lx = SX + 18
    rx = SR - 18 - rw
    for (x, w, key, role) in ((lx, lw, "shell", "plain"), (rx, rw, "kernel", "acp")):
        title, tag, lines = L[key]
        cc = t[role]
        if key == "kernel":
            s.rect(x, by, w, bh, r=10, fill=t["surface"], stroke=cc["accent"], sw=1.5)
        else:
            s.rect(x, by, w, bh, r=10, fill=t["surface"], stroke=cc["accent"], sw=1.1, extra='stroke-dasharray="4 3.5"')
        s.text(x + 14, by + 24, title, size=13.5, weight=700)
        s.pill(x + w - 12, by + 19, tag, size=9.5, fg=cc["text"], bg=cc["fill"], stroke=cc["stroke"], anchor="end",
               weight=700)
        for k, ln in enumerate(lines):
            s.text(x + 14, by + 45 + k * 16, ln, size=10.8, fill=t["muted"])
    s.text(lx + 14, by + bh - 10, L["shell_levels"], size=9.8, fill=t["plain"]["text"], weight=600)
    s.text(rx + 14, by + bh - 10, L["kernel_note"], size=9.8, fill=c["text"], weight=600)
    s.line([(lx + lw + 4, by + bh / 2), (rx - 4.5, by + bh / 2)], color=c["accent"], sw=1.7)
    mx = (lx + lw + rx) / 2
    for k, ln in enumerate(L["same_tools"]):
        s.text(mx, by + bh / 2 - 24 + k * 13, ln, size=10, fill=c["text"], anchor="middle", weight=600)
    # 数据库
    py = by + bh + 12
    s.rect(SX + 18, py, SR - SX - 36, 28, r=8, fill=t["surface"], stroke=c["stroke"])
    s.text((SX + SR) / 2, py + 18.5, L["pg"], size=11.2, fill=t["text"], anchor="middle", weight=600)

    # ---- GitLab 立柱
    gy0 = 96
    g = t["git"]
    s.rect(GX, gy0, GW, cy1 - gy0, r=14, fill=g["fill"], stroke=g["stroke"], extra='filter="url(#sh)"')
    s.text(GX + GW / 2, gy0 + 30, L["gitlab"], size=15, weight=700, anchor="middle")
    for k, ln in enumerate(L["gitlab_note"]):
        s.text(GX + GW / 2, gy0 + 52 + k * 15, ln, size=10.8, fill=t["muted"], anchor="middle")
    wy = 190 + 27
    s.pill(GX + GW / 2, wy, L["webhook"], size=9.8, fg=g["text"], bg=t["surface"], stroke=g["stroke"],
           anchor="middle", weight=700, h=20)
    chips = L["gitlab_chips"]
    chh, chg = 26, 18
    cyb = cy1 - 26 - chh                       # 最下面一格的上沿
    for k, label in enumerate(chips):
        yy = cyb - k * (chh + chg)
        last = k == len(chips) - 1
        s.rect(GX + 10, yy, GW - 20, chh, r=8, fill=t["surface"], stroke=g["accent"] if last else g["stroke"],
               sw=1.4 if last else 1.0)
        s.text(GX + GW / 2, yy + 17, label, size=10.5, weight=700 if last else 600, anchor="middle",
               fill=g["text"] if last else t["text"])
        if k:
            s.line([(GX + GW / 2, yy + chh + chg - 3), (GX + GW / 2, yy + chh + 4)], color=g["accent"], sw=1.4)
    ytop = cyb - (len(chips) - 1) * (chh + chg)
    s.line([(GX + GW / 2, ytop - 4), (GX + GW / 2, wy + 15)], color=g["accent"], sw=1.2, dashed=True)
    s.text(GX + GW / 2 + 9, (ytop + wy) / 2 + 8, L["gitlab_events"], size=10, fill=g["text"], weight=600)

    # ---- 内网边界
    ny = 632
    s.add(f'<path d="M24 {ny} H{W - 24}" stroke="{t["faint"]}" stroke-width="1.2" stroke-dasharray="2 5" stroke-linecap="round"/>')
    nat_w = est(L["nat"], 11, bold=True) + 28
    s.rect((W - nat_w) / 2, ny - 12, nat_w, 24, r=12, fill=t["bg"], stroke=t["border"])
    s.text(W / 2, ny + 4, L["nat"], size=11, fill=t["muted"], anchor="middle", weight=600)

    # ---- 开发者电脑
    dy0, dy1 = 668, 754
    a = t["agent"]
    s.rect(24, dy0, W - 48, dy1 - dy0, r=14, fill=a["fill"], stroke=a["stroke"], extra='filter="url(#sh)"')
    band_label(40, dy0 + 20, L["dev"])
    ny0 = dy0 + 30
    nw = (W - 48 - 32 - 2 * 22) / 3
    xs = [40 + i * (nw + 22) for i in range(3)]
    for x, key, mono in ((xs[0], "link", True), (xs[1], "agent", False), (xs[2], "wt", True)):
        title, sub = L[key]
        s.rect(x, ny0, nw, 44, r=9, fill=t["surface"], stroke=a["stroke"])
        s.text(x + 14, ny0 + 19, title, size=13, weight=700, mono=mono)
        s.text(x + 14, ny0 + 35, sub, size=10.2, fill=t["muted"])
    for i in range(2):
        s.line([(xs[i] + nw + 3.5, ny0 + 22), (xs[i + 1] - 3.5, ny0 + 22)], start=True, color=a["accent"])

    # acp-link ──出站订阅──▶ 网关（沿左侧上行）
    rail = 48
    s.line([(rail, dy0 - 4), (rail, 290 + 25), (SX - 4.5, 290 + 25)], color=a["accent"], sw=1.7)
    s.text(rail + 12, ny - 22, L["sub"], size=10.8, fill=a["text"], weight=700)
    # worktree ──git push──▶ GitLab
    px = GX + GW / 2
    s.line([(px, dy0 - 4), (px, cy1 + 4.5)], color=g["accent"], sw=1.7)
    s.text(px - 12, ny + 26, L["push"], size=10.8, fill=g["text"], weight=700, anchor="end")

    # 图例
    ly = H - 20
    lx2 = 28
    for role, label in L["legend"]:
        cc = t[role]
        s.rect(lx2, ly - 6, 12, 12, r=3.5, fill=cc["fill"], stroke=cc["accent"], sw=1.3)
        s.text(lx2 + 18, ly + 4, label, size=11, fill=t["muted"])
        lx2 += 18 + est(label, 11) + 22
    return s.render(L["aria"])


def main() -> None:
    for lang in ("zh", "en"):
        for theme in ("light", "dark"):
            (OUT / f"flow-{lang}-{theme}.svg").write_text(build_flow(lang, theme), encoding="utf-8")
            (OUT / f"architecture-{lang}-{theme}.svg").write_text(build_arch(lang, theme), encoding="utf-8")
    print("ok:", ", ".join(sorted(p.name for p in OUT.glob("*.svg"))))


if __name__ == "__main__":
    main()
