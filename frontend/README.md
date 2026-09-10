# 多面体前端

独立的 React / TypeScript / Vite 应用。视觉沿用已确认的 `../demos`，通过真实 REST 和 WebSocket 连接中继；页面中不包含演示会话或预置项目。

```sh
npm install
npm run dev
```

默认地址 `http://127.0.0.1:18417`。`/api`、`/auth`、`/ws` 代理到 `127.0.0.1:3001`（可用 `VITE_API_TARGET=http://127.0.0.1:13001` 覆盖）；中继 `PUBLIC_ORIGIN` 应匹配浏览器访问地址。生产环境运行 `npm run build`，由独立静态服务器及同源反向代理托管 `dist/`。部署应使用 HTTPS，并保留后端的严格 Origin、Cookie 与 CSRF 设置。生产反向代理应配置 CSP 响应头；开发服务器不注入会阻止 Vite HMR 的 CSP。脚本只需 `script-src 'self'`；xterm 的动态样式需要 `style-src 'self' 'unsafe-inline'`。

```sh
npm run typecheck
npm run build
npm run test:unit
npm run test:e2e
```

协议测试需要 Node.js 22.13+。浏览器测试使用本机 Chrome，在独立端口启动 Vite；测试内使用真实 Web Crypto 握手和加密帧，但不会运行真实 Agent 或发送付费模型请求。测试覆盖 Host 指纹固定、密文 RPC、统一 offset、快照/实时事件竞态、只读接入、接管后尺寸确认、控制权撤回、断线不重发、重连新通道、过载重新同步、journal 故障、离线无缓存会话、六套配色、项目归属、历史和响应式布局。截图写入 `test-results/`。

终端使用 xterm、Fit、Search 和可选 WebGL，WebGL 不可用时保留默认渲染器。读者使用主机快照的行列尺寸；只有明确接管当前加密通道后才发送尺寸变化和输入。每次重连创建全新通道并先以只读方式安装 Host 快照与连续 journal 尾部。关闭页面与断线不会请求终止进程，未确认的输入不会自动重发，历史只从在线 Host 读取。

主机配对码、可用 Agent、授权根目录都来自后端。项目目录校验、单写控制权、`runtimeOffset` / `controlOffset`、原生会话恢复与进程终止由 Host 再次验证。Relay 不提供离线项目/会话列表；Host 离线时历史不可见。

真实双窗口集成使用隔离的回显 PTY 固件，禁止指向真实 Agent 会话。先按后端测试说明启动 `backend/test/serve-fixture.ts`，再启动匹配端口的前端：

```sh
VITE_API_TARGET=http://127.0.0.1:13001 npm run dev -- --port 15174
LIVE_FRONTEND_URL=http://127.0.0.1:15174 LIVE_SESSION_ID=<fixture-session-id> LIVE_SESSION_TITLE='真实 PTY 联调' LIVE_PTY_TEST=1 node test/live-browser-check.mjs
```

浏览器副本不转发协议查询响应。由于 xterm 5.5 的公共 `onData` 混合真实输入和查询回复，`src/terminalInput.ts` 隔离了固定版本的内部 `onUserInput` 来源标记；升级 xterm 时必须重新跑查询、键盘、IME 与粘贴测试。OSC52 被显式忽略，OSC8 仅允许用户确认后的 HTTP(S) 链接。

项目行隐藏路径副标题，新建会话与项目设置收在悬浮/键盘聚焦可见的单一菜单中。`terminalHighlights.ts` 使用 xterm 公共 buffer/render 事件，对原生 Codex `›` / Claude `❯` 提示行及软换行叠加浅色背景；普通输出保留原样。它是视觉提示符识别，不是语义角色协议，未知或改变的 CLI 提示符不会强制着色。显示层不拦截鼠标或键盘事件，兼容普通与全屏缓冲。
