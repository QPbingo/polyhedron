# 多面体 HTML Demo · 项目工作台

静态 HTML/CSS/JavaScript 演示，无运行依赖。左侧参考 Orca 的功能区 + Projects 层级，右侧终端贴齐整个工作区，无外围留白或圆角。

## 启动

直接打开 `index.html`，或在项目根目录运行：

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory demos
```

访问 http://127.0.0.1:4173/ 。

## 当前操作

- 上方：搜索项目/目录/会话、全部会话、待处理、已结束。
- 下方：Projects。项目可折叠，会话嵌套在所属项目下，状态随会话显示。
- Projects 旁的 + 添加项目名称、目录和执行主机；项目旁的 + 是唯一的新建会话入口，自动绑定该项目；表单只展示项目名称和目录，不提供切换。
- 项目目录在新建表单和会话详情中可见。相同主机的同一规范化目录不允许重复添加；同名不同目录是不同项目。离线项目无法新建或接管。
- 终端右上角“会话详情”提供目录、主机、操作权、手动接管和中断。选择会话不会自动接管。
- 左下角“设置”提供六套配色、设备、终端字号；“演示连接”中可模拟断线重连。
- 支持搜索快捷键 Cmd/Ctrl+K、模拟输入、终端内审批（权限检查会话输入 1 或 2）、复制和专注模式。

项目与会话使用固定 `projectId` 绑定，目录和主机由项目提供。所有设备、目录和输出均为演示，不读取真实目录，不执行输入命令，也不连接真实 Agent。刷新会重置演示项目、会话和草稿；配色偏好独立保存。

## 配色

电光蓝、鸢尾紫、珊瑚橙、翡翠绿、玫瑰粉和原版蓝青。设置内即时切换，也可用 `?palette=electric`、`iris`、`coral`、`emerald`、`rose`、`original` 直达。查询参数优先于本地偏好。

## 检查

```sh
node --test demos/model.test.cjs
node --check demos/app.js
PLAYWRIGHT_MODULE=/path/to/playwright node demos/browser-check.cjs
```

Playwright 与 Chrome 仅用于浏览器检查。支持 `CHROME_PATH` 和 `DEMO_URL`；测试使用独立浏览器资料。

9 项模型测试覆盖项目关联、目录规范化、重复目录、同名不同目录、无效/离线项目限制和搜索；浏览器检查覆盖项目分组/折叠、项目内新建与目录绑定、添加项目、路径搜索，以及已有输入、接管、审批、断线恢复、设置和专注流程。

最新实际截图在 `demos/review-projects/`，包含 1231×805 用户视口、其他桌面宽度和窄窗口兜底。此前的 `review-minimal/`、`review-simple/`、`review-palettes/`、`review-v2/` 为历史版本；第一版纸面/石墨/像素三个方案已被否定。

未验证真实 CLI、跨设备通信、Safari 或完整无障碍流程。移动端仍不属于产品范围。

当前预置 5 个演示项目，每个项目 3 条会话，共 15 条：polyhedron-web（前端）、polyhedron-api（接口）、terminal-lab（终端实验）、pocket-notes（笔记应用）、prism-ui（组件库）。每条会话包含对应的示例终端内容，刷新后仍可查看预置数据。
