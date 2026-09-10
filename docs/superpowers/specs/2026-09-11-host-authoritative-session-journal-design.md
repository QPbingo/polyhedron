# 主机权威远程会话与统一 Journal 设计

日期：2026-09-11

状态：交互设计已逐节确认；正式规格待用户最终评审。本文只定义设计，不代表功能已经实现或验证。

## 1. 背景与决策摘要

产品需要允许同一账号的多个浏览器通过云端中继查看一台本地执行主机上的 Agent 终端，并由其中一个浏览器继续输入和控制。SSH 不属于当前方案；浏览器、云端中继和本地执行主机使用 HTTPS/WSS 通信。

本设计作出以下核心决策：

- Agent、PTY、会话事实、操作权和完整历史都以本地执行主机为唯一权威来源。
- 云端中继只负责身份认证、短期授权、在线路由和密文转发，不保存项目、会话或终端内容投影。
- 一个会话可以被多个同账号设备查看，但同一时刻只有一个可写控制端。
- 重连永远先进入只读状态；接管必须由用户明确触发，同账号设备无需原设备批准。
- 每个会话只使用一个由主机分配、严格递增的 `offset` 排列所有权威事实，不再分别维护 `runtimeEpoch`、`controlEpoch`、`inputSeq` 和 `outputSeq`。
- 所有已授权操作和 PTY/Agent 输出必须先在本地主机持久化，之后才能执行需要前置记录的副作用或向远端确认、广播。
- 本地 journal 不可用时采用失败关闭：远程查看历史和所有控制操作均停止，不能让远端画面领先于本地记录。

## 2. 目标与非目标

### 2.1 目标

1. 多个浏览器最终获得同一份权威终端状态和同样的会话事实。
2. 任意网络重连、浏览器切换或中继重启都不会造成重复输入、双写控制或静默丢失输出。
3. 所有可审计操作均先记录在执行主机；Relay 数据丢失不能改变会话事实。
4. 不确定是否已经送入 PTY 的操作绝不自动重放。
5. Relay 无法从持久化数据中获得项目、会话、输入、输出、路径或快照正文。
6. 执行主机离线时，历史不可读取；主机恢复后从本地 journal 重新同步。

### 2.2 非目标

- 不提供 SSH 接入、P2P 直连或局域网旁路。
- 不允许多控制端并发写入，也不合并多个输入流。
- 不把 Relay 变成会话状态机、租约权威或历史存储。
- 不承诺 Session Host 崩溃后继续持有原 PTY 文件描述符或恢复正在执行的系统调用。
- 不承诺不同操作系统、字体和 GPU 的字形像素完全一致；保证的是相同 PTY 行列下的逻辑屏幕、光标、ANSI 状态和业务界面数据一致。
- 不防御已取得执行主机管理员/root 权限且同时能访问解密密钥的攻击者。

## 3. 权威边界与组件职责

```text
浏览器 A（观察/控制） ─┐
                      ├─ HTTPS/WSS ─ Relay ─ 出站 WSS ─ Connector ─ Session Host ─ PTY/Agent
浏览器 B（观察）     ─┘                                  │
                                                         ├─ SQLite journal
                                                         ├─ 权威 headless 终端
                                                         └─ Keychain 密钥
```

### 3.1 Session Host

Session Host 是唯一可以：

- 分配会话事件 `offset`；
- 判定当前控制端；
- 接受输入、resize、中断、终止和恢复；
- 消费 PTY 输出并更新权威 headless 终端；
- 生成快照和历史；
- 判定操作成功、失败或结果不确定的组件。

所有改变会话事实的处理都经过同一个串行事件写入器。浏览器本地状态、Relay 到达顺序和 Connector 重连状态都不能取代它。

### 3.2 Connector

Connector 维持主机到 Relay 的出站连接，转发加密帧并处理背压。它不缓存可执行输入、不授予操作权、不生成权威 offset，也不在断线后自行重放控制请求。

### 3.3 Relay

Relay 可以持久化：

- 账号、设备和主机绑定关系；
- 主机公开身份材料及撤销状态；
- 短期授权凭证所需的最小元数据；
- 主机在线路由、连接时间、传输字节量和认证结果等无正文安全审计。

Relay 不得持久化：

- 项目名称、项目路径和会话名称；
- 会话列表、Agent 状态或终端状态投影；
- 输入、PTY/模型输出、快照、历史和 Hook 正文；
- native session ID、控制端身份或操作结果正文。

Relay 断线期间不排队输入或输出。恢复连接后，浏览器使用本地主机的 offset 协议补齐。

### 3.4 浏览器

浏览器是权威状态的投影：

- 只保存当前连接内的 `appliedOffset` 和渲染状态；
- 不使用 localStorage 或 IndexedDB 持久化终端正文；
- 断线时可以保留内存中的最后画面，但必须标记为“离线、可能过期”；
- 不能在离线状态积攒 Enter、审批、Ctrl+C 或其他待重放输入；
- 重连后先只读同步，用户明确接管后才允许输入。

## 4. 统一事件序列

### 4.1 Offset 语义

每个 `sessionId` 拥有独立的 64 位单调递增 `offset`。offset 只由 Session Host 在本地事务中分配。

规则如下：

- 已提交事件的 offset 连续、不可修改、不可复用。
- 未提交事务分配的 offset 对外不可见，回滚后允许重新分配。
- 浏览器只按 offset 应用权威事件；`offset <= appliedOffset` 的事件视为重复。
- 收到 `offset > appliedOffset + 1` 时视为缺口，停止应用后续事件并请求重新同步。
- 心跳、网络 ACK、ping/pong 和加密握手不是会话事实，不占用 offset。

`runtimeEpoch` 由最近一次 `runtime_started` 事件的 offset 表示；`controlEpoch` 由最近一次 `control_acquired` 事件的 offset 表示。无需再维护独立排序计数器。

### 4.2 事件类型

至少包含：

| 类别 | 事件示例 |
| --- | --- |
| 生命周期 | `session_created`、`runtime_start_requested`、`runtime_started`、`runtime_exited`、`runtime_interrupted` |
| 连接与读取审计 | `client_attached`、`history_read_requested`、`history_read_served`、`client_detached` |
| 操作权 | `control_requested`、`control_acquired`、`control_rejected`、`control_released` |
| 控制操作 | `input_requested`、`input_applied`、`resize_requested`、`resize_applied`、`interrupt_requested`、`interrupt_applied`、`terminate_requested`、`terminate_applied` |
| 失败结果 | `operation_failed`、`operation_indeterminate` |
| 内容与状态 | `pty_output`、`agent_state_changed`、`native_session_bound` |
| 存储与安全 | `journal_degraded`、`journal_recovered`、`integrity_warning` |

“所有操作记录”指所有通过身份验证并进入 Session Host 的读取、接管和控制操作。未通过身份验证的网络请求记录在无正文安全日志中，避免攻击者用垃圾请求填满会话 journal。

### 4.3 Operation ID

每个浏览器操作携带不可预测的 128 位 `operationId`。它只用于幂等和重试，不参与排序。

- 去重键至少包含 `sessionId + deviceId + operationId`。
- 相同 operationId、相同操作类型和相同 payload digest 的重试返回原结果，不再次执行。
- 相同 operationId 携带不同类型或 digest 时作为协议违规拒绝并记录。
- `input_applied` 仅表示字节已被本机 PTY 写入接口接受，不表示 Agent 已理解、执行或成功完成 prompt。

### 4.4 输入隐私

输入请求事件保存操作类型、操作者、字节长度、payload digest、控制权和结果，不额外保存原始按键字节。这样不会把关闭回显时输入的密码复制进操作审计。

正常可见的用户 prompt 由 PTY 回显形成 `pty_output`，与模型输出、工具输出和全屏终端控制序列使用同一事实流保存。若程序关闭终端回显，相应输入不会出现在历史画面中。

## 5. 操作权与并发控制

### 5.1 单控制端

一个会话最多有一个当前控制端。不同会话可以由不同设备同时控制。

接管流程：

1. 浏览器在只读状态明确点击“在此设备继续”。
2. Host 先提交 `control_requested`。
3. Host 串行判断账号、设备和会话状态。
4. 成功时提交 `control_acquired`；该事件的 offset 成为新的 `controlOffset`。
5. 第二次提交成功后才向新控制端确认，并向所有观察端广播。
6. 旧控制端立即只读；其携带旧 controlOffset 的迟到请求被拒绝并记录。

同账号设备可直接接管，不需要旧设备批准。并发接管时，以主机最先成功提交的 `control_acquired` 为准。

控制权绑定 `deviceId + clientInstanceId + encryptedChannelId`，不能只绑定账号或设备。浏览器刷新、WebSocket 重建或端到端通道重建都会产生新的 channel，默认没有写权限，不能沿用旧 channel 的 controlOffset。

Host 使用仅存在内存中的短周期 channel 心跳判断连接活性；心跳本身不占用会话 offset。控制通道断开或超过本地超时后，Host 提交 `control_released`。新设备接管不必等待旧超时，但任何控制权变化都必须先由 Host journal 确认。

### 5.2 可写请求

输入、resize、中断、终止等请求必须携带：

- `sessionId`；
- `operationId`；
- 当前 `controlOffset`；
- 操作类型和经过限制的 payload。

Host 在执行前重新验证当前控制权。验证和提交通过同一个串行器处理，避免检查后控制权又发生变化。

### 5.3 PTY 尺寸

只有当前控制端可以申请 resize。成功提交的 `resize_applied` 定义权威 PTY 行列，所有观察端按这一尺寸渲染，空间不足时缩放容器或滚动，不能反向修改 PTY。

接管时先同步屏幕，再测量稳定布局并提交一次 resize。短时间内的连续浏览器尺寸变化可以合并，但最终执行的 resize 仍需拥有独立 operationId 和 journal 结果。

## 6. 持久化优先的执行协议

### 6.1 一般操作

对于已授权的远程和本地 UI 操作，Host 使用以下顺序：

1. 验证身份、参数、当前 runtime 和 controlOffset。
2. 在本地事务中提交对应的 `*_requested` 事件。
3. 如果提交失败，返回 `JOURNAL_UNAVAILABLE`，不执行 PTY 或进程副作用。
4. 执行 PTY 写入、resize、signal、spawn 或读取等操作。
5. 提交 `*_applied`、`operation_failed` 或 `operation_indeterminate`。
6. 只有结果事件提交成功后才响应请求并广播新状态。

读取历史同样先提交 `history_read_requested`，生成有界响应后提交 `history_read_served`，再返回内容。

### 6.2 无法消除的原子性边界

SQLite 提交和 PTY/进程副作用不能组成同一个原子事务。进程可能在步骤 4 完成后、步骤 5 提交前崩溃。

因此：

- 恢复时，只有 requested 而没有最终结果的副作用操作一律标为 `operation_indeterminate`。
- 不根据 operationId 自动重新执行结果不确定的输入、中断、终止、spawn 或 resize。
- UI 明确显示“执行结果未知，请检查终端/进程状态”，不能冒充失败或成功。
- 对可以证明尚未进入副作用阶段的内部验证失败，记录 `operation_failed`；实现不能用猜测扩大“确定未执行”的范围。

这是一项有意的安全取舍：允许出现一次需要人工判断的未知结果，不允许因自动重放造成重复 prompt 或重复副作用。

### 6.3 PTY 输出

输出路径为：

1. 从 PTY 收到原始字节。
2. 通过串行写入器提交 `pty_output`。
3. 将已提交字节应用到权威 headless 终端。
4. 按 offset 广播给浏览器。

只有已持久化输出可以进入远端权威画面。模型文本、工具输出、终端查询结果和用户可见回显都遵守同一路径。

输出可以按时间和大小做有界合批，例如最多约一帧时间或固定字节上限；不得为了吞吐量进行无界内存缓存。SQLite 写入跟不上时必须对 PTY 读取施加背压。如果底层 PTY 适配器无法可靠暂停读取，该适配器不能通过验收，不能退化为“丢记录但继续广播”。

如果输出已经提交、但 headless 终端解析失败，Host 停止广播并从最近有效快照重放 journal。相同版本和配置下仍然失败时，会话进入完整性故障态；不得跳过出错字节后继续显示。浏览器终端与 Host headless 终端必须锁定兼容的解析器版本、Unicode 宽度配置和必要终端选项。

### 6.4 Journal 不可用

磁盘满、事务失败、`fsync` 失败、数据库损坏、加密密钥不可用或完整性检查失败时，会话进入 `journal_unavailable`：

- 禁止接管、输入、resize、中断、终止、恢复和历史读取；
- 已打开客户端转为只读故障态；
- 停止向远端广播尚未提交的输出；
- 对 PTY 读取施加背压，Agent 进程不自动结束，但可能因 PTY 缓冲区填满而自然阻塞；
- 不因进程重启自动清除故障。

管理员修复存储后，Host 必须完成数据库、事件链、密钥和 headless 重放检查，提交 `journal_recovered` 后才能重新开放操作。

### 6.5 Hook 与 Agent 状态

Hook、native session ID 和 Agent 状态也必须经过串行 journal：本地 Hook 桥接先提交原始事件的受控投影，再更新物化状态，最后才向浏览器广播。去重标识与状态更新位于同一事务，禁止出现“去重记录已保存、状态更新丢失”后把重试错误忽略的情况。

Hook 等待设置严格的本地超时。journal 不可用时桥接快速返回失败、会话进入 `journal_unavailable`，不广播未经持久化的 Agent 状态；不能为了维持状态徽标而无限阻塞 Agent CLI。

## 7. 本地数据模型与加密

### 7.1 单一 SQLite 存储

终端事件、操作事件、会话物化状态和快照统一存放在一个 SQLite 数据库中，移除 JSONL 与 SQLite 的权威双写。

数据库要求：

- WAL 模式；
- `synchronous=FULL`；
- 外键和约束启用；
- 单写入器；
- 事件插入与会话 head/物化状态更新位于同一事务；
- 启动时执行适当的 SQLite 完整性检查和应用级事件链检查。

核心逻辑表包括：

- `session_heads`：当前最大 offset、当前 runtime 起点、当前 controlOffset、状态和 head hash；
- `session_events`：sessionId、offset、eventId、类型、operationId、actor、时间、加密 payload、payload digest、前序 hash 和事件 hash；
- `session_snapshots`：sessionId、baseOffset、PTY 行列、加密序列化终端状态、校验值和生成时间；
- `session_keys`：仅保存由主机主密钥包裹后的每会话数据密钥。

具体 DDL 在实施计划中通过迁移和故障测试确定；本规格不把示意字段当成最终数据库接口。

### 7.2 静态数据加密

- Host 主密钥保存在 macOS Keychain，不写入数据库、日志或 Relay。
- 每个会话使用独立随机数据密钥；事件敏感 payload 和快照使用标准 AEAD 加密。
- 数据库只保存被主密钥包裹后的会话数据密钥。
- 事件头保留建立索引和恢复所需的最少非敏感字段；路径、标题、终端内容和 native ID 属于加密 payload。
- 密钥不可用时禁止以空密钥、明文或新密钥覆盖方式继续运行。

不自行设计加密原语；实现应使用平台 Web Crypto/Node crypto 或经过维护的标准协议库，并固定算法与格式版本。

### 7.3 完整性链的能力边界

事件使用 keyed hash 链验证 payload 修改、事件重排以及在 session head 仍存在时的中间删除。SQLite 事务和数据库完整性检查负责检测常见撕裂写入。

本地 hash 链不能在没有外部可信锚点的情况下证明整个数据库未被完整回滚，也不能防御同时控制数据库与 Keychain 的管理员。实现和产品文案不得声称具备超出这一边界的防篡改能力。

### 7.4 保存和删除

本地 journal 默认永久保留，不按时间或配额自动删除事件。系统显示每个会话和全部历史的磁盘占用，并在接近阈值时提前告警。

历史删除必须由用户明确触发，并说明终端历史、操作审计和恢复能力会一起受影响。删除使用会话数据密钥销毁与数据库清理；由于 SSD、文件系统快照和备份机制，产品不承诺物理介质上的不可恢复擦除。

## 8. 快照、同步与渲染

### 8.1 快照规则

快照是某个已提交 `baseOffset` 的物化终端状态，只用于加速加载：

- 快照不能包含尚未提交的 PTY 字节；
- 快照写入失败不影响 journal 的正确性；
- 恢复时可以选择更旧的有效快照并重放尾部事件；
- 快照损坏时丢弃并从更旧快照或 journal 重建；
- 快照不会替代、截断或自动删除原事件。

### 8.2 Attach 和增量同步

浏览器 attach 时提供最后已应用 offset（新客户端为 0）。Host 先记录已认证的 attach/read 操作，然后在同一串行边界确定同步水位，返回：

- 一个 `snapshot(baseOffset)`；
- 从 `baseOffset + 1` 到响应水位的连续事件；
- 当前 journal head offset；
- 当前 controlOffset、runtime 起点和只读原因。

快照选择、尾部读取和实时订阅必须原子衔接，或使用等价的水位缓存，确保没有初始化缺口。响应发送后产生的新事件进入同一有序实时流。

历史响应可能较大，生成过程中不能长期阻塞 PTY 写入器。实现使用数据库读快照固定 `contentOffset`，在提交 `history_read_served` 后才允许发送响应，并从 `contentOffset + 1` 缓冲实时事件。客户端完成快照安装前缓存这些增量，随后按 offset 依次应用。这样读取审计可以先落盘，又不会漏掉读取期间产生的输出。

网络重复由 offset 去重；网络缺口触发重新同步。浏览器不能用本地猜测填补缺口，也不能跨过缺口继续展示“最新”状态。

### 8.3 多端一致性定义

在相同 sessionId、权威 PTY 行列和 appliedOffset 下，各客户端必须得到相同：

- 主屏/备用屏内容；
- ANSI 属性、颜色和超链接状态；
- 光标位置、可见性和终端模式；
- 当前 runtime、Agent 状态、控制端和会话操作可用性。

客户端自己的滚动位置、文本选择、浏览器缩放和字形抗锯齿属于本地显示偏好，不写入 journal。观察端不得因自身容器大小改变权威终端行列。

## 9. 端到端传输安全

### 9.1 两层传输保护

浏览器、Relay 和 Connector 仍使用 TLS/WSS。终端和控制正文另外通过浏览器与 Host 之间的应用层端到端加密传输，Relay 只转发不透明帧。

Host 拥有保存在 Keychain 的长期身份密钥，使用它认证临时会话密钥。浏览器保存已见过的 Host 指纹；指纹变化时禁止静默连接并要求重新确认。

### 9.2 首次信任限制

同账号新设备可以直接连接这一产品要求意味着：如果主机指纹首次完全通过 Relay 获取，系统属于 trust-on-first-use。它能防止 Relay 数据库泄露和连接后的被动窥探，但不能在首次连接时完全防御主动恶意 Relay 替换身份。

因此：

- 产品必须明确显示首次信任和指纹变化状态；
- 可以提供执行主机本地二维码/短码核对作为高安全可选流程；
- 在没有引入账号级端到端根密钥、透明日志或带外验证前，不得宣称能抵御首次连接 MITM；
- 是否将带外首次验证升级为强制要求属于后续产品决策，不阻塞本设计的同账号直接使用流程。

### 9.3 授权

- Relay 签发短期、绑定 accountId、deviceId、hostId、用途和有效期的授权凭证。
- Host 独立验证签名、受众、过期时间和重放状态。
- 授权只允许建立加密通道和申请会话操作，不能直接授予控制权。
- 控制权仍以 Host 成功提交的 `control_acquired` 为唯一依据。
- 账号或设备撤销后停止续发短期凭证；Host 拒绝过期凭证，但不因此终止本地 Agent。

### 9.4 浏览器与日志安全

- 终端页面使用严格 CSP，不加载第三方脚本、广告、会话录制或远程字体。
- 日志、指标、崩溃上报和错误对象不得包含终端正文、输入 payload、路径、标题、token 或解密密钥。
- 对 OSC 52、可点击链接、粘贴、多行输入和危险终止操作保留明确权限与确认边界。
- 相同账号不等于相同浏览器进程可信；每个设备拥有独立可撤销身份。

## 10. 崩溃与恢复

### 10.1 Host 启动恢复

Host 启动时：

1. 打开 Keychain 和数据库并验证版本。
2. 执行 SQLite 与事件链检查。
3. 重放每个会话的有效快照和尾部事件，重建物化状态。
4. 将上次运行中没有明确退出的 runtime 标为 `runtime_interrupted`。
5. 将只有 requested、没有最终结果的副作用操作标为 `operation_indeterminate`。
6. 所有会话保持无人控制；浏览器重连后先只读。

旧 PTY 文件描述符不视为可恢复资源。即使旧子进程仍暂时存在，也不能在无法证明输入输出连续性的情况下重新宣称为活动 runtime。

### 10.2 用户恢复

用户明确选择恢复后，Host 先记录请求，再使用精确 native session ID 和原项目目录启动新 PTY。成功后提交新的 `runtime_started`，其 offset 成为新 runtime 边界。

恢复不会自动重放旧输入、重新执行未知操作或伪造旧进程仍在运行。旧历史保留只读，并在 UI 中显示 runtime 分界。

### 10.3 Relay、Connector 和浏览器恢复

- Relay 重启：Host 和浏览器重新建立连接，Agent 不退出；从 Host offset 同步。
- Connector 重启：不得结束 Session Host；连接恢复后不重放缓存控制帧。
- 浏览器刷新或换设备：先只读 attach，使用快照和事件恢复，再由用户选择是否接管。
- Host 离线：Relay 只显示主机离线，不提供会话列表或历史正文。

## 11. 迁移策略

当前实现中的 SQLite 元数据、JSONL 输出段和 Relay 会话投影不满足本设计。迁移必须：

1. 在原数据只读保留的情况下导入新的单库 journal。
2. 对无法恢复原始操作顺序的旧记录标记 `legacy_imported` 和来源范围，不伪造精确 offset 语义。
3. 校验输出字节数、序列范围、会话关联和可重建终端快照。
4. 导入失败时回滚新数据库，不修改或删除原文件。
5. 用户确认迁移成功并经过备份窗口后，才提供显式清理旧数据入口。
6. 删除 Relay 中旧的项目/会话投影，并验证数据库、日志、缓存和备份生命周期中的清理行为。

具体迁移是否必须兼容现有开发数据，在实施计划开始前通过仓库状态和发布环境确认；不能默认现有数据可以直接丢弃。

## 12. 错误模型

协议至少区分：

- `AUTH_INVALID` / `AUTH_EXPIRED`；
- `HOST_OFFLINE`；
- `READ_ONLY`；
- `STALE_CONTROL`；
- `RUNTIME_CHANGED`；
- `OFFSET_GAP`；
- `OPERATION_DUPLICATE`；
- `OPERATION_COLLISION`；
- `OPERATION_INDETERMINATE`；
- `JOURNAL_UNAVAILABLE`；
- `INTEGRITY_CHECK_FAILED`；
- `HISTORY_NOT_AVAILABLE`；
- `BACKPRESSURE_LIMIT`。

错误响应本身不得泄露其他账号的 hostId、sessionId、项目或会话存在性。客户端必须把“请求已发送”“主机已持久化”“PTY 接受”和“Agent 完成”显示为不同语义，不能统一叫“成功”。

## 13. 验证与故障注入矩阵

### 13.1 原子边界

对每种有副作用操作，在以下位置注入进程崩溃：

1. requested 提交前；
2. requested 提交后、副作用前；
3. 副作用调用中；
4. 副作用返回后、结果提交前；
5. 结果提交后、响应或广播前。

验证：没有未记录副作用；未知结果不会重放；已提交但未广播的结果可以通过 offset 同步恢复；客户端不会把超时等同于失败。

### 13.2 存储故障

- 磁盘满和只读文件系统；
- SQLite busy、I/O error、WAL/checkpoint 失败；
- `fsync` 失败；
- 数据页、快照、事件 payload 和尾部损坏；
- Keychain 锁定、密钥缺失或错误密钥；
- 进程 `SIGKILL` 和模拟断电后的恢复。

验证所有故障都进入失败关闭，且修复前不能通过重启绕过。

### 13.3 网络与幂等

- 帧重复、延迟、乱序、丢失和截断；
- 浏览器、Connector、Relay 分别重启；
- operationId 重试和碰撞；
- 快照生成期间持续大输出；
- attach、历史读取和实时订阅交错。

验证 offset 连续、无重复副作用、无初始化缺口，并确保 Relay 不需要保存正文即可恢复。

### 13.4 并发控制

- 两个及以上同账号设备同时接管；
- 接管期间旧端发送输入、resize 和 Ctrl+C；
- 新控制端快速刷新、断网和再次接管；
- 不同会话由不同设备并行控制；
- 其他账号猜测 hostId/sessionId 和重放授权凭证。

验证每个会话只有一个有效 controlOffset，旧请求均被 Host 拒绝并记录。

### 13.5 终端一致性

覆盖：

- ANSI 颜色和属性；
- UTF-8 分帧、中文、emoji、组合字符和宽字符；
- 光标、滚动区、主/备用屏；
- 全屏 TUI、终端查询、粘贴和 IME；
- resize 与输出交错；
- 大输出和慢观察端。

在固定 xterm/headless 版本与 Unicode 宽度配置下，对相同 appliedOffset 计算逻辑终端状态摘要并跨客户端比较。浏览器截图只用于视觉回归，不取代状态摘要。

### 13.6 安全与隐私

- 检查 Relay 数据库、缓存、日志、指标、错误追踪和网络抓包不存在业务明文；
- 验证跨账号、过期凭证、撤销设备、重放和会话串线均失败；
- 验证 Host 指纹变化阻止静默连接；
- 验证 CSP、XSS、OSC 52、危险链接和日志脱敏；
- 验证关闭回显输入不会被操作 journal 复制保存；
- 验证数据库拷贝在没有 Keychain 密钥时无法解密正文。

### 13.7 长时间与容量

- 高输出会话持续运行并同时连接快、慢多个客户端；
- journal 写入速度低于 PTY 输出速度；
- 历史增长接近磁盘告警阈值；
- 周期快照、WAL checkpoint 和历史读取并发。

验证内存有界、背压生效、控制消息不会被历史传输饿死，并且系统不会自动删除历史掩盖容量问题。

## 14. 验收门槛

实现只有同时满足以下条件才可声称完成：

1. 现有单机终端、项目、会话、Hook 和 UI 功能回归通过。
2. 上述故障注入、并发、网络、终端一致性和隐私测试通过。
3. 代码中不存在绕过 journal 直接执行远程或本地 UI 控制操作的路径。
4. 代码中不存在持久化失败后仍广播输出或确认操作成功的路径。
5. Relay 的 schema、日志和测试证明不再保存项目/会话/终端投影。
6. 至少两台浏览器完成查看、显式接管、旧端失权、断线恢复和历史读取闭环。
7. 对 SQLite 与 PTY 无法原子提交、首次连接 TOFU 和管理员权限攻击边界有准确产品说明。
8. 数据迁移经过可回滚验证，且没有未经用户确认的数据删除。

## 15. 后续实施约束

本规格通过最终评审后，先使用 `writing-plans` 编写分阶段实施计划，再开始修改代码。建议阶段顺序为：

1. 建立统一事件协议与 SQLite journal，并增加故障注入设施；
2. 将所有 Host 操作改为持久化优先和失败关闭；
3. 重构快照、历史和浏览器 offset 同步；
4. 重构单控制端与重连行为；
5. 缩减 Relay 数据模型并加入端到端加密；
6. 迁移旧数据；
7. 完成跨设备、安全、压力和回归验收。

任何阶段都不能以“后续会补”为由临时保留丢记录后继续广播、自动重放未知输入或 Relay 保存终端正文的路径。

## 16. 技术依据

- SQLite WAL 的提交、并发和 checkpoint 语义：https://sqlite.org/wal.html
- SQLite `PRAGMA synchronous` 的持久性语义：https://sqlite.org/pragma.html#pragma_synchronous
- Node.js 文件同步与 flush API（用于审计旧实现和迁移工具，新的权威事件不再依赖 JSONL 双写）：https://nodejs.org/api/fs.html
