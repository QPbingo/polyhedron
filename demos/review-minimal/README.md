# 八处标注反馈检查

实际静态页面在独立 Chrome 中检查，减弱动效模式。

- `feedback-1231.png`：对应用户的 1231×805 视口；终端贴齐右侧四边，外围留白与圆角为 0；输入框完整可见。
- `desktop.png`、`desktop-1280.png`、`compact-desktop.png`：1440×1000、1280×800、1100×800。
- `settings.png`、`new-session-dialog.png`：设置和新建弹窗。
- `narrow-760.png`、`narrow-390.png`：窄窗口兜底，无横向溢出。
- 八个标注选择器全部移除；活动状态保留在左侧会话列表；接管与中断仅在会话详情中。
- 浏览器回归通过详情接管、输入、草稿保留、设置中的断线重连、审批后的左侧状态更新、新建后左侧标题更新、搜索、离线禁用、详情、专注模式、指南、六套配色与字号。未捕获脚本错误。状态模型 6 项测试通过。

复现：按上级 README 配置 Playwright 与 Chrome，执行 `node demos/browser-check.cjs`。
