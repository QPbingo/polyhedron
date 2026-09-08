# 多面体

按已确认的界面实现的 Agent 终端工作台。左侧是功能栏与项目树，会话固定属于项目目录；右侧是原生 Codex / Claude Code 的 xterm 终端。

## 项目结构

```text
frontend/                 独立 React + TypeScript + Vite 工程
  src/                    工作台、登录、设置、终端协议与交互
  nginx.conf              生产静态资源、API 反代及 CSP
backend/                  独立 Node.js + TypeScript 工程
  src/relay/              账号、OIDC、配对、WebSocket 中继
  src/host/               本地 PTY、目录授权、操作权、SQLite、终端历史
  src/connector/          Mac 发起的出站连接、配对命令
  src/adapters/           Codex / Claude Code 原生命令与 Hook
  scripts/               macOS LaunchAgent、Keychain、安装包工具
  test/                   实际 HTTP/WS/PTY、状态和安全回归测试
demos/                    保留的静态设计演示（数据与正式应用独立）
compose.yaml              正式前端、中继和 PostgreSQL 的部署配置
```

前端不访问后端源码、文件系统或数据库。后端不直接输出 React 页面。两端有各自的 package.json、lockfile、依赖和构建命令。

## 本机运行

需要 Node.js 22.13+（推荐 Node 24 LTS），macOS 执行端；先自行安装并登录原生 Codex 或 Claude Code。前端控制端只需要桌面浏览器。

终端一：

```sh
cd backend
npm ci
npm run dev
```

终端二：

```sh
cd frontend
npm ci
npm run dev
```

打开 **http://127.0.0.1:18417/**，点击本机开发登录。在 Projects 旁点击「+」添加项目，点击「选择文件夹」浏览执行主机上的授权目录，进入目标文件夹后确认；路径和默认项目名会自动填写，也可手动输入路径。再悬浮该项目，打开「…」菜单新建会话。开发服务首次启动仅授权当前仓库根目录；目录授权可在执行 Mac 的 `backend/.data/host.json` 中修改后重启主机服务。网页不能扩大本机授权根目录。

开发模式创建独立的本机账号、主机凭据和 SQLite 数据，仅绑定回环地址，不能用于从其他 PC 登录。它不会创建假 CLI 会话。首次启动真实 CLI 时，原生目录信任、Hook 信任或厂商登录提示会保留在终端中，由用户自行完成。

`npm run dev` 启动中继、连接服务，以及独立的后台 Session Host。停止该命令只停止中继/连接服务；已启动的 Agent 保持运行。要明确停止本地主机及其 Agent：

```sh
cd backend
npm run host:stop -- --confirm
```

原型仍可通过之前的 http://127.0.0.1:4173/ 查看；正式应用是 18417 端口。

## 使用方式

- 项目绑定本机规范化后的真实目录。只允许已授权根目录，禁止不存在的路径及符号链接越界。
- 在项目的「…」菜单中选择“新建会话”，创建 Codex 或 Claude Code。相同目录已有运行任务时先确认文件冲突风险。
- 打开会话先查看；右上角“会话详情”中接管后输入。一个会话只有一个操作端，查看端不改变终端尺寸。
- 输入原样进入 CLI，支持原生菜单、审批与快捷键；没有额外的聊天层或网页自动审批。
- 关页或重启中继不结束进程。重新连接恢复快照，未知输入不自动重发。
- 详情中可重命名、中断、确认结束进程、查看分段历史、恢复有精确原生 ID 的历史会话，以及归档。
- 设置中包含六套配色、字号、主机配对/解绑、CLI 检测、运行时防休眠和本地历史保留设置。

## 正式跨 PC 使用

正式模式必须配置 OIDC、PostgreSQL 和 HTTPS/WSS，没有自动降级为开发登录的后门。

1. 准备 OIDC 应用，回调地址设为 `https://你的域名/auth/callback`。身份提供方负责注册、MFA/Passkey 和账号恢复。
2. 在私有环境配置 `PUBLIC_ORIGIN`、`OIDC_ISSUER`、`OIDC_CLIENT_ID`、可选 `OIDC_CLIENT_SECRET`、`POSTGRES_PASSWORD` 和至少 32 字符的随机 `RELAY_SESSION_SECRET`。
3. `docker compose up --build -d` 构建独立前端、中继和 PostgreSQL；在 HTTPS 网关后代理到本机 8080。中继无需暴露独立公网端口。
4. 执行 Mac 安装后端依赖并构建，发起绑定：

```sh
cd backend
npm ci
npm run build
npm run pair -- --relay https://你的域名 --root /Users/你/Projects --name '工作室 Mac'
```

5. 在同账号网页设置中确认配对码。Mac 主机凭据存入 Keychain，再分别运行 `npm run host`、`npm run connector`；需要自动启动时按 [macOS 操作说明](backend/scripts/README.md) 安装两个独立 LaunchAgent。
6. 在另一台 PC 登录同一账号，选择项目下会话并接管；文件和 CLI 凭据始终保留在原 Mac。

环境变量通过部署系统注入；复制 `.env.example` 不会自动载入，直接启动可使用 `node --env-file=.env dist/relay/main.js`。PostgreSQL 密码用于连接 URL 时须 URL 编码特殊字符；建议生成 URL 安全随机密码。TLS 网关须保留 Origin 和 WebSocket Upgrade 头。

如果安装的是独立 Compose 命令（本机当前如此），将 `docker compose` 替换为 `docker-compose`。

生产 CSP 在 `frontend/nginx.conf` 中实际输出：脚本仅同源，禁止对象嵌入及被其他站点 iframe 嵌入，允许 xterm 动态样式。传输使用可信中继 + TLS，不是端到端加密；中继不持久保存终端正文。

## 检查

```sh
cd backend
npm test
npm run build
npm run diagnose
cd ../frontend
npm run test:unit
npm run build
```

浏览器测试及真实两客户端联调见 [前端说明](frontend/README.md)。原生 CLI 启动检查是显式命令 `cd backend && node --import tsx test/native-smoke.ts`，只观察启动和信任界面，不发送提示词、不批准请求。

本机验证结果和尚需外部环境完成的验收见 [交付验证记录](docs/implementation/VERIFICATION.md)。此仓库提供可运行的实现及部署/打包工具；真实域名、身份提供方、签名证书和 Apple 公证凭据需自行配置。不会把未执行的云部署、付费模型任务、物理双 PC/Safari 验收或签名公证写成已通过。

本机已生成含独立 Node 24 的 macOS arm64 未签名安装包，位于 `backend/.data/packages/PolyhedronHost-unsigned.pkg`，不随源码提交。它尚未安装、签名或公证；重新打包与发行步骤见 [macOS 操作说明](backend/scripts/README.md)。
