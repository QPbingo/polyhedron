# Backend

独立的 TypeScript 后端工程，使用 Node 22.13+。详见根目录 README 的本机和正式部署步骤。

- `npm ci` 安装锁定依赖；postinstall 修复 node-pty 自带 spawn-helper 的执行位。
- `npm run dev`：明确的回环开发模式，自动生成私有开发配置，中继3001；Session Host 独立后台运行。
- `npm run relay` / `npm run host` / `npm run connector`：分别启动三个服务。
- `npm run pair -- --relay https://... --root /absolute/root`：一次性账号绑定，生产 macOS 使用 Keychain。
- `npm run diagnose`：检查原生 CLI 路径、版本、功能支持。
- `npm test` / `npm run typecheck` / `npm run build`：测试、检查与编译。

`src/relay` 只保存账号、登录、主机绑定、配对和无正文审计；开发用 SQLite，生产要求 PostgreSQL。`src/host` 使用 SQLite 保存项目/会话/Hook/快照，分段文件保存终端输出。默认128MiB、30天，快照与Hook也受清理约束；运行中最新恢复快照始终保留，因此必要快照可能超过极小配置配额。SQLite页和WAL的物理文件开销不等同于正文配额，运维需监控实际磁盘。

每个会话最多一个控制者；运行世代、操作权版本、输入序号由主机验证。授权票据绑定账号、主机、浏览器、方法、会话/运行和30秒有效期。输出按解析序号发送，快照不落在未完成控制序列中；普通输出积压2MiB、快照独立8MiB上限，慢客户端需重新取快照。后台终端只在 Mac 维护权威状态，浏览器只挂载选中的终端。

主机服务使用 mode0700 数据目录、mode0600 IPC Unix socket 和独立令牌。运行配置由 `HOST_CONFIG` 或 `--config` 指定。远程中继必须WSS；根目录只能在执行Mac授权。服务启动用独占 startup目录串行修复陈旧PID，防止并发启动修改同一SQLite。若启动过程中被强制终止而留下 `host-startup.lock`，先核对该配置的 `host.pid` 对应进程未运行，再删除空的启动锁目录并重启。

Hook 不接收权限决定，也不传送prompt、tool_input或tool_output。审批优先使用toolUseId关联，缺少ID时仅唯一同名tool关联；缺少关联证据时保持待审批直到权威Stop，不用无关并行工具事件清除。子Agent事件不改变父状态，缺失Hook显示未知。

[接口约定](../docs/implementation/CONTRACT.md) · [CLI兼容说明](src/adapters/README.md) · [账号/中继](src/relay/README.md) · [Mac服务与打包](scripts/README.md)
