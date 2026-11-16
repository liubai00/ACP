# 派活（ACP）文档索引

文档编号规则：`ACP-DOC-<三位序号>`，文件名 `ACP-DOC-<序号>-<名称>-v<主>.<次>.md`。
内容有实质变化升次版本号（v1.1 → v1.2），架构方向或交付方式变化升主版本号（v1.2 → v2.0）。每份文档末尾保留变更记录。
在线可编辑版本为 Claude Doc，本目录为留存版，两边同步更新：先改在线版，再导出覆盖本目录并升版本号。

| 编号 | 文档 | 当前版本 | 日期 | 给谁看 | 在线版 |
| --- | --- | --- | --- | --- | --- |
| ACP-DOC-001 | 多 Agent 协作平台设计方案 | v2.1 | 2026-11-09 | 所有人 | https://claude.ai/artifact/GZmkZHQEwcVfV47SySQPJn |
| ACP-DOC-002 | 云服务器部署手册 | v1.2 | 2026-11-09 | 运维 | https://claude.ai/artifact/JzAmGw3x3PNzqE1vPoJUjA |
| ACP-DOC-003 | 开发者接入手册 | v1.0 | 2026-11-09 | 开发者 | https://claude.ai/artifact/GpGnHNYSQL6XuYMdTeKvFB |
| ACP-DOC-004 | 接口规范 | v1.3 | 2026-11-10 | 二次开发者 | 无在线版，来源是仓库 `contracts/API.md` |
| ACP-DOC-005 | 开发计划 | v1.2 | 2026-11-09 | 项目负责人 | https://claude.ai/artifact/NGJCj23peKT7EGjFbHWs9X |
| ACP-DOC-006 | 交接文档 | v1.0 | 2026-11-09 | 接手的人 | https://claude.ai/artifact/ARDSt6xH8ypENT6oCnTKys |

接手先读 ACP-DOC-006，它按“一页看懂、部署迁移、飞书、GitLab、开发者接入、运维”的顺序串起其余文档。

v2.0 起文档统一为“一次交付全部功能、一道验收门”的口径：不分阶段，开发按六个工作包 W0 到 W5 先后进行。ACP-DOC-005 v1.2 记录了六个工作包的完成与验证情况。

ACP-DOC-004 由 `contracts/API.md` 复制而来：接口变更先改 `contracts/API.md`，再同步本目录的副本并升版本号。

图片目录 `images/` 按全套文档统一顺序编号：01 到 05 属于设计方案（05 交付范围与开发顺序），06 部署拓扑属于部署手册，07 开发顺序属于开发计划。

历史版本放在 `archive/`，被替换的图片放在 `archive/images/`，只保留当前版本在本目录。
