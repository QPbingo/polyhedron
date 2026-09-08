# 多面体

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

样式已经用户确认，现已实现独立的 frontend/（React、TypeScript、Vite、xterm）与 backend/（Fastify、PTY Session Host、连接服务、OIDC 中继）。本地状态使用 SQLite，正式中继使用 PostgreSQL；两端独立安装、构建和部署。原静态 Demo 保留在 demos/。

## Users

需要从不同 PC 操作同一台本地 Mac 上 Codex 或 Claude Code 会话的用户。

## Product Purpose

通过同一个账号连接本地 Agent，会话可查看、接管和恢复，操作感觉与 CLI 一致。

## Operating Context

执行端 Apple Silicon Mac，控制端 PC 浏览器。个人账号，多端查看，单端操作；不考虑移动端。

## Capabilities and Constraints

用户已确认 docs/superpowers/specs/2026-09-08-agent-workbench-v1-design.md 的 V1 方向。正式应用使用真实目录、持久化项目/会话及原生 CLI PTY；会话必须绑定具体项目。开发登录限本机，正式跨 PC 登录使用 OIDC、HTTPS/WSS 和主机配对。demos/ 中仍是独立演示数据。实现与验收边界见 docs/implementation/VERIFICATION.md。

## Brand Commitments

名称：多面体。用户要求操作简洁易懂。第一版的纸面、石墨、像素桌面三个方向均被否定；第二版使用 UI UX Pro Max，并参照 https://uupm.cc/demo/telemedicine 重新设计 HTML Demo。最新要求是配色更靓丽、提供多个方案：现保留第二版布局，新增电光蓝、鸢尾紫、珊瑚橙、翡翠绿、玫瑰粉五套配色，原版蓝青作为对照。默认展示电光蓝，最终配色仍待用户选择，不恢复第一版三个方向。最新反馈进一步要求尽量简约：当前已改为会话列表与终端双栏，去掉宣传和重复卡片，六套配色、设备与字号集中到设置。用户随后通过八处标注进一步去掉品牌、右侧标题/路径/控制栏和底部主机栏，活动状态统一在左侧会话中显示，接管与中断保留在按需打开的会话详情中。最新要求参考 Orca 侧栏：上方为功能入口，下方为 Projects，Session 归属项目目录；当前 Demo 已实现项目树、目录绑定与项目内新建会话。

## Product Principles

- 熟悉的终端操作优先。
- 显示清晰的执行位置与操作权。
- 装饰不妨碍内容阅读。
- 明确区分演示与真实执行。

## Evidence on Hand

已确认的 V1 方案、静态设计原型、正式前后端实现、真实 PTY/HTTP/WebSocket/PostgreSQL 测试与 Chrome 双客户端联调记录。没有正式客户数据；长时间混合 Agent 压力和物理双 PC 验收仍待执行。
