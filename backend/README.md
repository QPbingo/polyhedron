# Backend

独立的 TypeScript 后端工程，使用 Node 22.13+。详见根目录 README 的本机和正式部署步骤。

- `npm ci` 安装锁定依赖；postinstall 修复 node-pty 自带 spawn-helper 的执行位。
- `npm run dev`：明确的回环开发模式，自动生成私有开发配置，中继3001；Session Host 独立后台运行。
- `npm run relay` / `npm run host` / `npm run connector`：分别启动三个服务。
- `npm run pair -- --relay https://... --root /absolute/root`：一次性账号绑定，生产 macOS 使用 Keychain。
- `npm run diagnose`：检查原生 CLI 路径、版本、功能支持。
- `npm test` / `npm run typecheck` / `npm run build`：测试、检查与编译。

`src/relay` 只保存账号、登录、主机绑定、配对和无正文审计；开发用 SQLite，生产要求 PostgreSQL。它不保存项目、会话、路径、Agent 状态、输入、输出、快照或历史投影。`src/host` 的单一 SQLite journal 是会话事实的唯一权威来源，项目、会话、Hook、快照和终端输出均使用 AES-256-GCM 静态加密；WAL 使用 `synchronous=FULL`。历史默认永久保留，设置中的天数和容量仅用于磁盘告警，不会自动删除记录。

每个会话最多一个可写加密通道。Host 用单一递增 `offset` 排列运行、接管、输入、尺寸、Hook 和 PTY 输出事实；`runtimeOffset` 与 `controlOffset` 都是对应 journal 事件的 offset，不存在额外输入/输出序号。所有操作先提交 requested 记录，再执行副作用，再提交结果；结果未知不会自动重放。输出必须先提交，再更新 headless 终端并广播。journal 写入失败时暂停 PTY 读取并关闭远程历史与控制，Agent 不会被自动结束。

浏览器与 Host 使用 P-256 ECDH、HKDF-SHA256、AES-256-GCM 和 Ed25519 Host 身份签名建立内容加密通道。正常工作的 Relay 只能看到路由标识、短期授权和密文。Host 私钥使用独立、仅存于本机 Keychain 的主密钥加密；浏览器以 TOFU 方式固定 Host 指纹，指纹变化时拒绝连接。首次连接仍应在高安全场景通过执行主机本地指纹做带外核对。由于“同账号新设备无需本地批准”的产品约束，Relay 当前仍是授权信任边界；主动恶意 Relay 可以使用所持 Host 授权凭据另开通道并发起操作，不能将本实现描述为对 Relay 的零信任方案。

主机崩溃后正在运行的本地 PTY 无法恢复，重启会提交 `runtime_interrupted` 并清除旧控制权。只有 requested、没有结果的操作恢复为 `operation_indeterminate`。损坏的终端快照会从加密 journal 重放；journal 或密钥完整性失败时服务失败关闭。修复磁盘/密钥问题前不要删除数据库或生成替代密钥。

主机服务使用 mode0700 数据目录、mode0600 IPC Unix socket 和独立令牌。运行配置由 `HOST_CONFIG` 或 `--config` 指定。远程中继必须 WSS；根目录只能在执行 Mac 授权。服务在读取或迁移配置前原子创建并同步 `host.pid`，防止两个进程同时修改同一 SQLite；进程被强制终止后，下次启动会先核对 PID 存活性与记录文件身份，再安全清理陈旧记录，无需手工删除启动锁目录。

Hook 不接收权限决定，也不传送prompt、tool_input或tool_output。审批优先使用toolUseId关联，缺少ID时仅唯一同名tool关联；缺少关联证据时保持待审批直到权威Stop，不用无关并行工具事件清除。子Agent事件不改变父状态，缺失Hook显示未知。

[接口约定](../docs/implementation/CONTRACT.md) · [CLI兼容说明](src/adapters/README.md) · [账号/中继](src/relay/README.md) · [Mac服务与打包](scripts/README.md)
