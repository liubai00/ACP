# 派活 任务榜（board）

派活（代号 ACP）的 Web 前端：看任务全貌、查找与跟进任务、看 Agent 实时进展、审批、管理成员与自动化设置。
界面语言为简体中文，布局与配色沿用开源项目 [Kiranism/next-shadcn-dashboard-starter](https://github.com/Kiranism/next-shadcn-dashboard-starter)（MIT），默认使用其中的 **Discord** 主题。

接口以仓库根目录的 `contracts/API.md` 为准，类型定义在 `src/types/api.ts`，请求封装在 `src/lib/api.ts`。

## 技术栈

Vite 7 + React 19 + TypeScript（strict）+ Tailwind CSS v4 + shadcn/ui（base-nova 风格，基于 Base UI）+ React Router 7（BrowserRouter）+ TanStack Query 5 + TanStack Table 8 + Recharts 3 + lucide-react + sonner。

## 常用命令

```bash
npm install            # 安装依赖（Node 20+，推荐 22/24）

npm run dev            # 真实模式：/api /auth /a2a /mcp /.well-known /healthz 代理到 http://localhost:8000
VITE_BACKEND_URL=http://127.0.0.1:18000 npm run dev   # 代理到别的 coordinator 地址

npm run dev:mock       # 模拟模式：不需要后端，前端内置示例数据（读取 .env.mock，VITE_MOCK=1）

npm run build          # tsc -b 类型检查 + vite build，产物在 dist/
npm run preview        # 本地预览 dist/（端口 4173）
npm run lint           # ESLint
```

模拟模式下的登录方式：

- 「飞书登录」：模拟一次 OAuth 回调，以「张伟（管理员）」身份进入，会走完整的 `/login/callback#token=...` 流程；
- 管理员账号：`admin` / `admin`；
- 开发登录：任意名字（不存在会自动创建，可勾选「以管理员身份登录」）。

模拟数据覆盖全部接口：8 种状态的任务、飞书/任务榜/Agent/GitLab/API 来源、成员与在线/忙碌/离线的 Agent、MR 与流水线、审批、时间线、协调建议、14 天趋势、来源事件、n8n 工作流与执行、设置、个人令牌。
认领、补充信息、审批、发消息等操作会改变内存里的数据，并通过模拟的实时流推送到详情页；正在执行的任务每 15 秒会收到一条模拟的 Agent 进度消息。
想看「未连接 n8n」的空状态：在浏览器控制台执行 `localStorage.setItem('acp_mock_n8n', 'off')` 后刷新。
模拟层通过动态 import 加载，生产构建（`npm run build`）不会包含任何模拟代码。

## 部署

`Dockerfile` 为两阶段构建：`node:22-alpine` 构建，`nginx:1.27-alpine` 提供 `/usr/share/nginx/html`。

```bash
docker build -t acp/board --build-arg NPM_REGISTRY=https://registry.npmmirror.com .
```

- `NPM_REGISTRY` 构建参数（默认 `https://registry.npmjs.org`）用于 `npm ci`，`deploy/compose.yaml` 会传入；
- `nginx.conf`：监听 80，所有前端路由回退到 `index.html`；`/assets/` 带哈希的文件长缓存（immutable），`index.html` 不缓存；开启 gzip；
- nginx **不代理** API。同一域名下 `/api`、`/a2a`、`/mcp`、`/auth`、`/.well-known`、`/healthz` 由 Caddy 转给 coordinator，其余路径给本镜像。

## 目录结构

```
board/
├─ index.html                首屏前应用主题的内联脚本（避免闪烁）
├─ vite.config.ts            @ 别名、开发代理、分包
├─ components.json           shadcn/ui 配置（base-nova + lucide）
├─ Dockerfile / nginx.conf
└─ src/
   ├─ main.tsx               入口；VITE_MOCK=1 时先安装模拟层
   ├─ App.tsx                路由表、QueryClient、全局 Provider
   ├─ index.css              Tailwind 入口、@theme 变量映射、业务语义色
   ├─ styles/
   │  ├─ fonts.css           打包的西文字体（仅 latin 子集，中文走系统字体）
   │  └─ themes/*.css        10 套配色（来自 Kiranism，MIT）
   ├─ types/api.ts           契约类型
   ├─ lib/
   │  ├─ api.ts              类型化请求、401 处理、SSE 订阅
   │  ├─ token.ts            acp_token 存取、JWT 解码、重定向白名单
   │  ├─ auth.tsx            登录态、/api/me、令牌自动刷新、401 跳转
   │  ├─ queries.ts          react-query 查询键与 hook
   │  ├─ labels.ts           所有中文标签与状态配色（状态、优先级、来源、场景…）
   │  └─ format.ts           时间/数字格式化
   ├─ hooks/                 use-task-stream（SSE 并入缓存）、use-mobile、use-debounce
   ├─ config/nav.ts          侧边栏导航分组
   ├─ components/
   │  ├─ ui/                 shadcn/ui 生成的组件（尽量不改）
   │  ├─ layout/             侧边栏、头部、面包屑、用户菜单、PageContainer
   │  ├─ theme/              主题列表、ThemeProvider、主题下拉与明暗切换
   │  ├─ data-table/         表格、列头排序、分面筛选、列显示、分页
   │  ├─ tasks/              任务卡片、列定义、时间线、流程条、操作按钮、详情各分区、新建任务对话框
   │  └─ command-palette.tsx Ctrl+K 命令面板（搜索任务、跳转页面、切换主题）
   ├─ pages/                 每个路由一个文件（懒加载）
   └─ mock/                  模拟后端（seed.ts 生成数据，index.ts 拦截 fetch 并实现接口）
```

## 页面与路由

| 路由 | 页面 |
| --- | --- |
| `/` | 项目全貌：KPI、14 天趋势、状态分布、来源、负责人负载、需要关注、最近动态 |
| `/tasks` | 查找任务：搜索、分面筛选（状态多选；来源/优先级/负责人/仓库单选）、排序、分页，筛选条件保存在 URL |
| `/tasks/:id` | 任务详情：操作按钮（由 `allowed_actions` 决定）、流程条、时间线（SSE 实时）、代码与 CI、审批、子任务、协调建议 |
| `/board` | 任务进展：按状态分列的看板，失败/取消/拒绝收在最右侧 |
| `/sources` | 数据来源：各来源状态与来源事件 |
| `/people` | 负责人：成员（管理员可编辑角色）与 Agent（`?tab=agents`） |
| `/workflows` | 自动化流程：n8n 工作流与最近执行 |
| `/settings` | 设置（仅管理员可见、可改）：自主等级、飞书建单方式、监听的群 |
| `/account/tokens` | 个人令牌：从右上角头像菜单进入，给手动配置 Claude Code / Codex MCP 用 |
| `/login`、`/login/callback` | 登录与飞书回调（从 URL fragment 读取 `token` 和 `redirect`） |
| `/device?code=XXXX` | 确认 acp-link 设备登录 |

前端路由不会以 `/api`、`/a2a`、`/mcp`、`/auth`、`/.well-known`、`/healthz` 开头。

## 认证与实时更新

- 令牌存在 `localStorage` 的 `acp_token`，所有请求带 `Authorization: Bearer`；
- 任何接口返回 401：清掉令牌、清空缓存、跳转 `/login?redirect=<当前路径>`；
- 令牌距过期不足 24 小时会自动调用 `POST /auth/refresh`；
- 登录回调和 `redirect` 参数只接受站内相对路径，防止开放重定向；
- 详情页用 `EventSource('/api/tasks/{id}/stream?access_token=...')` 订阅：`timeline` 事件直接追加到时间线，`task` 事件合并摘要字段后再静默拉一次详情（`allowed_actions`、MR、审批不在摘要里）；连接断开会指数退避重连，右上角显示「实时 / 重连中」。

## 主题是怎么工作的

`<html data-theme="discord" class="dark">`：

- `data-theme` 选择配色，每个 `src/styles/themes/<名字>.css` 定义一套 CSS 变量（`--background`、`--primary`、`--chart-1`…），以及 `[data-theme='x'].dark` 的暗色版本；
- `.dark` 切换明暗；`src/index.css` 里的 `@theme inline` 把这些变量映射成 Tailwind 工具类（`bg-primary`、`text-muted-foreground`…）；
- 状态徽标用的 `--success`、`--warning`、`--info`、`--danger` 是与主题无关的语义色，保证在任何主题、明暗下都有足够对比度；
- 用户选择保存在 `localStorage`（`acp_theme`、`acp_mode`），`index.html` 的内联脚本在首屏前应用，避免闪烁；
- 快捷键：`Ctrl+K` 命令面板，`Ctrl+Shift+D` 切换明暗，`Ctrl+B` 收起/展开侧边栏。

新增主题：把 tweakcn 等工具导出的变量存成 `src/styles/themes/<名字>.css`（选择器写成 `[data-theme='<名字>']` 和 `[data-theme='<名字>'].dark`），在 `src/index.css` 里 `@import`，再加到 `src/components/theme/theme-config.ts` 的 `THEMES`。

## 新增一个页面

1. 在 `src/types/api.ts` 补类型，在 `src/lib/api.ts` 加请求函数，在 `src/lib/queries.ts` 加查询键和 hook；
2. 在 `src/mock/index.ts` 用 `route('GET', '/api/xxx', ...)` 加模拟实现（必要时在 `seed.ts` 造数据）；
3. 新建 `src/pages/xxx.tsx`，默认导出组件，外层用 `<PageContainer title=… description=… actions=…>`；表格用 `components/data-table/*`，卡片用 `components/ui/card`；
4. 在 `src/App.tsx` 用 `lazy(() => import('@/pages/xxx'))` 注册路由（放在 `AppLayout` 下即自动要求登录）；
5. 需要出现在侧边栏就加到 `src/config/nav.ts`（可用 `role` 限定角色）；面包屑会自动取导航标题；
6. 中文文案和状态配色统一放在 `src/lib/labels.ts`；
7. `npm run build && npm run lint` 通过后再提交。

## 致谢与许可

- 布局与 10 套主题配色来自 [Kiranism/next-shadcn-dashboard-starter](https://github.com/Kiranism/next-shadcn-dashboard-starter)（MIT License, Copyright (c) Kiranism），主题文件头部保留了出处说明；
- UI 组件由 [shadcn/ui](https://ui.shadcn.com)（MIT）生成；字体来自 [Fontsource](https://fontsource.org)（OFL）。
