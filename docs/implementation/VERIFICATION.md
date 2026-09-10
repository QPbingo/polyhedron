# 主机权威远程会话交付验证

日期：2026-09-11（Asia/Shanghai）

## 交付结论

本次实现已将远程会话切换到“执行主机唯一权威、Relay 仅转发密文、浏览器按统一 offset 投影”的模型。当前源码、自动化测试和隔离真实浏览器联调均通过；验证范围内未发现未处理的交互、数据同步或状态管理异常。

设计与协议边界见：

- `docs/superpowers/specs/2026-09-11-host-authoritative-session-journal-design.md`
- `docs/implementation/CONTRACT.md`

## 已实现的关键约束

- 每个会话只有一个由 Host 分配的连续 `offset`；`runtimeOffset` 和 `controlOffset` 都引用对应事实的 offset。
- 项目、会话、终端、历史、Agent 状态和操作结果只以 Host 本地加密 SQLite journal 为权威来源。
- journal 使用 WAL、`synchronous=FULL`、每会话数据密钥、AES-256-GCM 和 keyed hash 事件链；历史不再按旧时间/容量配置自动删除。
- 输入、resize、中断、终止、启动和读取操作先提交 `*_requested`，副作用后再提交结果；不确定结果标记为 `operation_indeterminate`，不自动重放。
- PTY 输出先持久化，再进入 headless terminal 和远端广播；journal 故障时暂停远端读取/控制并对 PTY 施加背压。
- 浏览器与 Host 使用 Ed25519 身份签名、P-256 ECDH、HKDF-SHA256 和 AES-256-GCM 建立端到端加密通道；Relay 只看到路由字段、短期授权和密文。
- Host 指纹采用 TOFU 固定；指纹变化转换为稳定的 `HOST_IDENTITY_CHANGED` API 错误并阻止连接。
- 多浏览器可同时查看，但一个会话同一时刻只有一个 channel 可写；刷新、断线和重连必须创建新 channel，并从只读状态重新接管。
- 快照和实时 journal 事件在浏览器中串行消费；重复 offset 被忽略，缺口触发重同步，跨 runtime 事件不会混入旧终端。
- Relay 不保存项目/会话投影；Host 离线时只展示主机绑定，项目、会话和历史均不可从云端读取。

## 自动化验证结果

| 检查 | 结果 | 覆盖重点 |
| --- | --- | --- |
| 后端完整测试（默认 SQLite 环境） | **104 通过，0 失败，2 个 PostgreSQL 环境项按设计跳过** | journal、故障注入、真实 PTY、Host/Connector/Relay、OIDC、授权、隐私、迁移和进程控制 |
| 后端完整测试（PostgreSQL 17） | **106/106 通过，0 跳过** | 使用一次性专用 PostgreSQL 17 容器顺序运行完整套件，并执行 Relay 持久化、并发配对和 PostgreSQL 行级明文隔离检查 |
| 后端类型检查与生产构建 | 通过 | `tsc --noEmit`、`tsc` |
| 前端单元测试 | **10/10 通过** | 加密 RPC、首次信任后重连、并发 nonce、Host 指纹、offset 去重/缺口/runtime 边界、输入门控和提示行渲染 |
| 前端 Chrome E2E | **23/23 通过** | 项目内会话、直接终端输入、首次信任恢复、接管/撤销、resize 权威快照、重连只读、超过 200 个运行的分页历史、journal 故障、设置、响应式和无障碍 |
| 前端类型检查与生产构建 | 通过 | `tsc --noEmit`、Vite production build |
| 原生 Agent 启动烟测 | **Codex、Claude Code 均通过** | 仅启动真实 CLI 并读取 PTY 画面；无配置错误，不发送模型 prompt |
| 真实双浏览器链路 | **通过** | 真实 Relay/Connector/Host/Vite、隔离回显 PTY、首次 TOFU、双端接管、旧端拒写、历史和重连 |

后端故障与安全测试明确覆盖：

- 请求记录失败时不执行 PTY 副作用；进入 PTY/进程副作用后即使调用本身抛错，也持久标记为不确定且不重放；结果提交失败时不返回成功，重启后同样转为不确定状态。
- 终止操作只有在进程组或 PTY 至少一条初始信号路径确认投递后才记录成功；两条路径都失败时记录为不可重放的不确定结果。
- PTY 输出提交失败时不广播明文字节；Hook 去重、Agent 状态和 native session 绑定在同一事务中更新。
- 快照损坏时从加密 journal 重建当前 runtime；Host 重启后记录 `runtime_interrupted` 并清除旧控制权。
- Host 进程被真实 `SIGKILL` 后可借助持久 PID 记录安全重启；身份密钥与配置在 rename 前后崩溃点均保持可恢复。
- SQLite 只读、写锁竞争和 `SQLITE_FULL` 均在状态变更前失败关闭并持久化故障锁，显式校验恢复后才重新开放操作。
- 启动会分页校验超过 200 个历史 runtime，并按不重叠区间线性重放；旧版明文派生 digest 会迁移为密文 digest/HMAC 并执行页清理。journal 与业务行迁移会先持久写入 `privacy_scrub_pending`，仅在 checkpoint/VACUUM 成功后清除；迁移提交后中断会在下次启动继续清理。
- WAL truncate checkpoint 的 `busy/log/checkpointed` 返回值会被显式验证；活跃 reader 阻止清空 WAL 时，启动失败关闭并保留 scrub 标记，待读事务释放后继续清理。
- 两个加密客户端争抢同一会话时，旧 `controlOffset` 的输入被拒绝并记录；同一 channel ID 不能复用。
- Relay 数据库、WAL、日志采集和原始转发帧中均不存在测试项目路径、会话标题、prompt 或终端输出哨兵明文，而 Host 可以正常解密并返回完整数据。
- 浏览器首次确认 Host 指纹后会创建全新 WebSocket/加密通道并立即读取状态；非法浏览器关闭码导致接收队列中断的回归路径已有严格 WebSocket 模拟和真实 Chrome 覆盖。

## 真实浏览器链路

使用隔离回显 PTY 启动真实 Relay、Connector、Host 和 Vite 页面，并用两个独立 Chrome 上下文完成：

1. 开发登录和 Host 端到端加密握手。
2. 只读 attach、显式接管、权威 resize 后直接在 xterm 输入。
3. 第二浏览器接管，第一浏览器立即只读，旧端输入未进入 PTY 或历史。
4. 两端看到相同输出；历史同时包含两个已接受输入，不包含被阻止输入。
5. 关闭两个浏览器后重新打开，Host 进程和历史仍存在，重新连接保持只读。
6. 设置页显示已固定的 Host 指纹。
7. 浏览器 `console` 和 `pageerror` 列表为空。

随后在 Codex 桌面应用内浏览器复核 1280×720 布局：左侧导航与右侧终端并排，详情面板浮于终端右侧，文档宽高不溢出，终端快照/历史可见，错误日志为空。

所有真实输入只发送到测试夹具提供的隔离回显 PTY，没有向真实 Codex/Claude 会话发送 prompt。

## 静态审计

- Relay schema 和 store 已删除 `host_projections`；启动迁移只保留显式 `DROP TABLE IF EXISTS host_projections` 用于清理旧数据库。
- Relay 生产路径不解析 RPC method、params、result、终端、快照或历史正文；明文 RPC/Host 内容帧会被拒绝。
- 前端 `localStorage` 仅包含配色、字号、完成提示和 Host 指纹，不保存终端或会话正文。
- Host 中的 `pty.write`、`pty.resize`、signal 和广播路径均位于串行 journal 流程之后。唯一特殊路径是 headless terminal 生成的协议响应：它先记录长度和 digest，再写入 PTY；这是终端协议数据，不是用户输入。
- `runtimeEpoch`、`controlEpoch`、`inputSeq` 和 `outputSeq` 已从生产浏览器协议移除；仅迁移代码读取旧字段并立即规范化删除。
- `git diff --check` 通过。

## 复现命令

```sh
cd backend
npm test
npm run typecheck
npm run build

cd ../frontend
npm run test:unit
npm run typecheck
npm run build
npm run test:e2e
```

PostgreSQL 项使用 `TEST_DATABASE_URL` 指向专用测试数据库。真实双浏览器脚本的隔离夹具和环境变量见 `frontend/README.md`，不得把 `LIVE_PTY_TEST=1` 指向真实 Agent。

## 外部环境边界

以下项目依赖交付环境，不能由本机隔离测试替代：真实 OIDC 租户与域名/TLS 网关、两台物理设备和弱网长时测试、真实断电或物理磁盘耗尽、真实 Codex/Claude 账号登录与权限审批、Apple 签名/公证及全新 Mac 安装。自动化已使用真实 `SIGKILL`、SQLite 只读/锁竞争/容量上限和注入式 rename/fsync 边界覆盖同类恢复逻辑，但不会把它们表述为硬件级验收。TOFU 也不能防御首次连接时的主动恶意 Relay；高安全部署应使用主机侧指纹带外核对。
