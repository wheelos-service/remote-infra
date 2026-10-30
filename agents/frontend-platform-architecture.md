# 自动驾驶运营平台框架、多车接入与模块目录设计

日期：2026-10-30

状态：遥测、观看租约、多车只读监看、业务持久化及服务端交接栅栏已落地；原生媒体与物理交接验收见实施计划

实施计划：[数据接入与按需会话计划](frontend-data-integration-plan.md)

可视化：[总体架构、模块、媒体状态机与跨车切换时序图](frontend-platform-diagrams.md)。

本文是本阶段的模块、目录及多车会话设计入口。实施顺序、按需推流状态机和已有源码证据
继续引用实施计划，不另建第二套规则。本文不创建空目录、空接口实现或演示业务代码。

技术选型更新：服务端保留 Go，客户端保留 React/TypeScript；车端目标改为
C++17/Cyber 原生后台，入口为 `apps/vehicle-edge-cpp/`。已有
`apps/vehicle-edge/` Python 代码仅作为旧入口与协议参考，不作为新增车端后台主线。
已实现独立遥测及原生 SDK 合成媒体闭环；真实相机/控制仍需验证部署和车辆交接条件，不因已有 Python
能力而宣称 C++ 已支持。实施进度以各阶段实际证据为准。

## 1. 框架结论与边界

采用“多车资产与状态总览、多车只读视频、单车独占驾驶”的工作模式：

- 每辆车独立身份、消息缓存、在线状态、媒体需求与 Room，不把多车驾驶放进同一 Room。
- 打开平台先读取授权车辆、遥测和控制占用摘要，不自动打开全部车辆视频。
- 操作员可主动打开多个车辆的视频；每个视频面板拥有独立观看租约和 Room。
- 一个工作台只有一个驾驶目标、一个输入焦点和一个指令发送器。
- 从 A 切换到 B 必须先结束 A 的控制，再独立申请 B；不预先同时持有两车控制权。
- 业务状态由云端遥测读取；当前驾驶车辆的控制与实时反馈保留 DataChannel。

服务端已增加约束：同一 tenant/operator 至多持有一个活动/交接中的驾驶会话，
包含其他标签页、设备及 Gateway 实例。Redis Lua 原子维护车辆/操作者持久栅栏，
释放或到期不自动解锁；匹配设备的当前 session/revision 双重确认才可清除。
这不等于 C++ 已实现物理交接；确认接口默认禁用，平台驾驶保持不可用。

不建设自动强抢、跨操作员无缝接棒、批量驾驶或故障后自动切换驾驶车辆。
遥测在线、拥有租约、有人发送指令、车辆实际运动是不同事实，页面分别表达。

## 2. 系统分层与所有权

```text
                  frontend 统一平台
      /------------------------------------------\
      | 车队/详情/告警/任务/历史 | 多车监看/单车驾驶 |
      \------------------------------------------/
             | REST + 授权流           | 多个独立 Room
             v                        v
       Go Gateway 单体             LiveKit SFU
  认证/ACL/设备身份/资产目录             |
  遥测接入/车队读模型/占用摘要            |
  观看租约/控制仲裁/需求协调              |
       |             |                |
       v             v                |
  Redis 最新状态   业务持久存储           |
       ^                              |
       | HTTPS 遥测/事件/需求/会话同步     |
       |                              |
  Edge A           Edge B          Edge N
     |                |               |
  Cyber A          Cyber B         Cyber N
```

模块是逻辑边界，首期不是独立微服务：

| 模块 | 权威事实/责任 | 不负责 |
| --- | --- | --- |
| 认证与权限 | 操作者、权限域、设备身份、observe/control ACL | 判断车辆已经安全停车 |
| 车辆目录 | 已登记车辆、能力、地图/软件版本 | 用心跳自动登记任意设备 |
| 遥测服务 | 最新状态、源质量、在线判断、授权订阅 | 授予驾驶控制权 |
| 会话与仲裁 | 观看租约、车辆控制互斥、操作者约束、交接状态 | 把 Room 存在视为有人驾驶 |
| 媒体需求协调 | 有效需求聚合、revision、RTC 启停授权 | 直接执行油门/制动 |
| Edge | 本车采集、状态标准化、会话校验、媒体与控制生命周期 | 信任前端自报的控制占用 |
| LiveKit | 会话媒体与 DataChannel 传输 | 持久化业务状态或充当控制租约权威 |
| 业务模块 | 告警闭环、任务协调、历史索引 | 将请求已接收等同车端已执行 |
| 前端工作台 | 多车展示、连接资源、驾驶输入及切换编排 | 以本地状态代替服务端仲裁 |

Redis 不可用时控制申请/续期失败关闭，不以进程本地锁替代集群互斥。
业务数据库已采用单 Gateway 本地 SQLite，保存有界遥测、告警转换及 Mission 状态；
Redis AOF 持久保存重放和交接栅栏。多 Gateway 共享业务记录需另行迁移数据库。
视频/record 对象存储及录像索引仍为后续能力，当前没有后台录像。

## 3. 多车接入与隔离

### 3.1 标识模型

| 标识 | 用途与生命周期 |
| --- | --- |
| `vehicle_id` | 资产永久标识；设备 subject 经服务端注册映射到车辆 |
| `device_instance_id` / `boot_id` | 一次 Edge 运行实例与重启边界，不代表设备权限 |
| `stream_id` / `sequence` | 状态流重启、重复与乱序检测 |
| `client_instance_id` | 标签页/工作台实例，服务端绑定认证主体，不能当凭据 |
| `viewing_session_id` | 一个观看者对一辆车的有期限观看权 |
| `control_session_id` | 一辆车的一次控制授权，绑定操作者、客户端、密钥及期限 |
| `lease_revision` | 服务端控制状态版本/撤销栅栏，用于车端应用确认和防止旧状态复活 |

权限域内组合标识必须唯一；Redis、缓存、流式订阅和审计一并遵守，不能只在 URL 中隔离。
现有车辆身份/ACL 机制继续复用，具体组织字段与键格式在契约阶段确定，不假设当前服务已经支持任意多租户模型。

### 3.2 设备上线

1. 管理侧登记车辆、设备主体映射和可观测/可控制权限，不由首个遥测包自动授予权限。
2. 每辆车运行自己的 Edge；配置本车 ID、设备凭据及 Cyber domain/namespace。
3. Gateway 校验设备身份与目标车辆，验证状态版本、大小、时间和序列后更新最新读模型。
4. 前端授权列表同时包含在线和离线资产；设备心跳只改变状态，不改变登记和 ACL。
5. 设备重启开启新数据流；同车双实例需服务端实例代次/所有权协调，拒绝旧实例覆盖。

同机多车仿真必须显式隔离 Cyber 通道和 domain、相机来源、node 名称及凭据；
不能只把公网 `vehicle_id` 改名而继续读取同一底盘消息。
车辆控制就绪还必须绑定当前有效 Edge 实例。重复实例无法仲裁时标记冲突并禁止新控制，
不得允许两个实例都发布执行器指令。

### 3.3 车队数据聚合

- 页面使用一个授权车队快照和一个增量订阅，不逐车轮询控制接口或建立 Room。
- 车队摘要结合遥测、控制租约和媒体状态，由 Gateway 返回有明确来源版本的字段。
- 各来源独立时间戳；不把聚合读模型宣传为一个同步采样事务。
- 订阅按车辆集合和权限过滤，权限收回时撤销订阅/租约并清除相应缓存。
- 每车输入限额、事件限额、缓存及背压独立；一车故障不能挤占全部车队更新。
- 大车队使用服务端分页/筛选、地图可见范围及列表虚拟化，实际规模上限通过测量确定。

## 4. 页面：先看多车状态，再按需看视频

建议工作台布局：

```text
授权车队列表                  多车只读视频区
A 在线 | 被其他人占用           [A 只读] [B 只读]
B 在线 | 可申请                 [C 只读] [添加车辆]
C 在线 | 本人其他终端占用
D 离线 | 状态未知              单一驾驶焦点：B（未取得控制）
                              [申请控制] / [释放控制]
底部固定区：当前驾驶车辆、操作者、会话/反馈状态、交接进度
```

- “查看全部车辆是否有人操作”不要求观看全部视频，列表占用摘要即可满足。
- 视频面板只能显式添加；同时打开数量、清晰度与刷新率采用有限资源预算，参数实测后确定。
- 达到预算拒绝新增或由用户选择关闭哪个观察面板，不能静默关闭当前驾驶车辆的视频。
- 浏览器后台视频可按显式策略降低质量；当前驾驶关键视频不能自动降为不可用后继续开放输入。
- 点击列表、hover 或切换详情不会改变驾驶目标；焦点选择与驾驶授权独立。
- 跨车操作按钮始终显示目标车辆，避免只换标题但 sender 仍指向上一辆车。

### 4.1 控制占用不是一个布尔值

| 展示状态 | 权威依据 | 操作 |
| --- | --- | --- |
| 可申请 | 最新服务端摘要无有效控制/交接占用 | 可以点击申请，但仍可能竞争失败 |
| 当前工作台持有 | 当前 subject + client instance 匹配 | 可释放；驾驶另受就绪条件约束 |
| 本人其他终端持有 | subject 相同、client instance 不同 | 禁止悄悄续租或接管，提示回原终端释放 |
| 其他人持有 | 服务端有效租约 | 允许有权限的只读观看，不允许强抢 |
| 正在释放/待确认 | 服务端交接状态 | 不显示可申请 |
| 未知/已过期摘要 | 查询失败、游标缺口或摘要超龄 | 刷新状态，不把未知展示成空闲 |

在 observe 权限范围内返回允许展示的操作者名称或脱敏标识、占用状态与更新时间，
不返回私钥、token、完整会话密钥材料；普通列表不暴露原始 control session。
“租约占用中”不等于操作者正在输入；输入活跃度只能来自带年龄的 Edge 接收证据。

### 4.2 页面与路由

沿用 HashRouter，逐步从单个 Home 组件拆分：

| 路由 | 页面 |
| --- | --- |
| `/#/fleet` | 车队总览 |
| `/#/vehicles/:vehicleId` | 车辆详情及诊断/任务/事件/历史/档案 |
| `/#/teleop` | 多车占用列表、按需监看入口 |
| `/#/teleop/:vehicleId` | 聚焦车辆工作台；URL 不授予控制，也不自动申请 |
| `/#/alerts` | 告警事件 |
| `/#/tasks` | 任务管理 |

路由只保存可公开的车辆/视图信息；不持久化控制私钥、token 或自动恢复驾驶意图。
进入/离开 teleop 使用统一生命周期，跨详情切换不能销毁后遗留一个仍续租的控制发送器。

## 5. 多 Room 与控制身份

- 每车继续使用独立 Room；一个浏览器可以持有多个只读 Room 实例。
- 每辆车在同一客户端实例内最多一个 Room owner，由 registry 管理引用，不让不同组件各连一遍。
- 每条轨道、RTC 状态、timer 和异步响应都绑定 `vehicle_id + connection_generation`。
- 不能把“最近收到的车辆状态”放入一个全局对象供所有卡片复用。
- 车辆 participant 身份继续由 Gateway 绑定；只接受与面板目标相符的状态和轨道。

同车多标签页必须演进操作者 RTC 身份：由 Gateway 为每个客户端会话生成独立 participant identity，
并在控制授权中绑定预期的 sender identity。operator subject 不再同时承担“人”和“连接实例”的标识。

当前 token 使用 `operator-<operator_id>`，车端也按该字符串校验 sender；只修改前端 identity
会破坏校验，必须一起修改 Gateway token/会话契约、Edge verifier 和旧入口适配。
浏览器提交的任意 identity 不能被服务端直接采信。签名私钥仍按新控制会话生成，
不跨车复用、不从 observer 连接推导控制权限。

首期 observer/controller 升降级采用显式断开重连，不假设 SDK 支持无缝权限更新：
保留观看租约，关闭原 observer Room，使用绑定新控制会话的 token 重连，重新等待轨道和状态。
释放控制后如继续看 A，则使用仅观察权限重连；其他车的 Room 不受影响。
即使旧 controller token 尚未到期，Edge 也必须依据撤销后的控制会话拒绝指令。

## 6. A 车释放后切换到 B 车

### 6.1 不变量

1. 单车控制互斥和单操作者互斥均由服务端保证，覆盖多标签页和多设备。
2. A 的控制结束未确认之前，不能申请 B 的控制；允许先只读查看 B。
3. 本地停止发送、租约释放、车端撤销、实际车辆交接条件是四种不同证据。
4. 无法确认时进入阻塞状态，允许继续观察，不猜测 A 已停车或已恢复自动驾驶。
5. B 被占用或申请失败，不能自动重新获得 A，也不能自动强抢 B。

### 6.2 正常路径

```text
控制 A
  -> 用户请求切换 B，显示 A/B 并确认
  -> 进入 RELEASING_A，关闭持续驾驶输入与续发动作
  -> 按既有已验证流程结束 A 的驾驶，不新增自动回自动/换挡动作
  -> Gateway 将 A 会话置为 RELEASING，停止接受续租，发出撤销 revision
  -> Edge 应用撤销，清理 A 的待执行指令及会话，回报相关 revision
  -> 车端交接条件得到确认；Gateway 完成释放并解除操作者交接占用
  -> 清除 A 的 controller sender/密钥，按选择关闭或保留只读观看
  -> B 先进入只读监看，等待视频和实时状态
  -> 用户显式申请 B，服务端原子竞争车辆/操作者占用
  -> 成功后重建 controller 连接，重新检查所有驾驶门控
  -> 用户显式开始操作 B，不自动延续 A 的输入
```

“车端交接条件”需依据车辆/运行模式明确：至少有源时间有效的状态与明确退出远程控制证据，
是否要求停车、执行器状态及后续控制权归属需要单独审核。
现有停止反馈、middleware publication 或速度显示为零不能独自证明完成安全交接。
条件未定义或不具备可验证能力的车辆只能监看，不能开放跨车驾驶切换。

### 6.3 服务端释放与确认栅栏

Gateway 已实现 release 返回 `202 PENDING`、独立查询/设备确认及持久栅栏；
HTTP 成功不代表 Edge 已清除旧 session。原生控制接收/撤销与物理交接策略尚未实现，
确认端点默认禁用。以下是完整目标，不能把服务端状态机当作原生执行证据。

完整目标及当前边界：

- 控制生命周期包括 ACTIVE、RELEASING、RELEASED/EXPIRED/REVOKED，以及可查询的未确认交接结果。
- 释放请求带幂等请求 ID；返回操作状态/版本，而不是伪装成同步完成；接口兼容单独设计。
- 撤销 revision 和结束记录保留足够时间，Edge 通过独立 HTTPS 同步取得，不能依赖 RTC 保持连接。
- Edge 原子应用撤销、清空旧动作、与执行任务建立顺序边界后回报 `applied_revision`，
  回报关联 vehicle、当前 device instance、control session、源时间与交接证据。
- 应用确认既通过业务链路记录，也可在 RTC 展示；不信任浏览器自报确认，不把通用 heartbeat 当作撤销确认。
- Gateway 验证回报属于当前设备代次及待结束会话；迟到旧确认不能结束新会话。
- 操作者占用在 RELEASING/待确认期间继续保留；原授权 TTL 到期不等于物理交接确认。
- 超时进入“释放结果未确认”，阻止申请 B；通过重连核对、有效车端回报或独立授权的人工作业解决，
  不提供普通前端绕过按钮。异常记录需要持久恢复，Gateway 重启不能将其误判为空闲。

车辆端 lease expiry、watchdog 和命令时效仍独立生效，不因等待交接确认延长旧驾驶授权。
此栅栏用于防止上一车尚未退出远程控制就开始下一车，不宣称本平台完成车辆安全认证。

### 6.4 失败、竞争与取消

| 场景 | 行为 |
| --- | --- |
| A release 响应丢失 | 按请求 ID 查询并协调；不再次生成副作用，不申请 B |
| A 断网/无车端确认 | 关闭本地动作，保持结果未知，等待恢复或授权处置 |
| B 被其他操作员抢先取得 | 返回 409 与允许展示的占用信息，停留只读 |
| 用户在释放前取消 | 保持 A 当前上下文；不改驾驶目标 |
| 释放已开始后取消切换 | 继续完成 A 的结束流程，不自动恢复旧 session |
| B 申请成功但进房失败 | 输入保持禁用，回滚/协调 B 的会话和媒体需求 |
| 迟到 A 的 token/状态/签名任务 | generation 检查后丢弃；必要的迟到租约须补偿释放 |
| 浏览器关闭/崩溃 | TTL 与 Edge 失效机制兜底，未确认交接进入恢复队列 |

### 6.5 后端原子仲裁

控制 acquire/renew/release 协调车辆占用与操作者占用，不采用两个独立 SETNX 后尽力回滚。
首期单 Redis 主存储使用原子脚本；若未来部署 Redis Cluster，必须重新设计跨槽事务/权威存储，
不能假设当前脚本天然适用。
token 签发和媒体需求不是 Redis 事务的一部分，采用幂等补偿、状态查询及过期协调；
失败不能残留一个摘要显示空闲但仍有效的驾驶授权。

## 7. 模块划分与依赖方向

### 7.1 前端

| 模块 | 状态所有者与接口 |
| --- | --- |
| app shell | 路由、认证、全局导航保护；不拥有具体车辆 Room |
| contracts | 状态/占用/会话类型和运行时校验，无 React/LiveKit 依赖 |
| vehicles | 按车辆 ID 的目录、能力、遥测、占用读模型，快照/增量协调 |
| monitoring | Room registry、观看租约、轨道与 RTC 状态，每车实例隔离 |
| teleop | 单一 control coordinator、签名 sender、驾驶门控、跨车 switch reducer |
| fleet/vehicle pages | 使用只读模型；显式调用监看入口，不直接创建 Room |
| alerts/tasks/history | 各自业务数据及 API；不访问驾驶 sender |
| mock | 实现已确定的 provider 契约，不进入生产指令路径 |

依赖方向：pages -> feature service/hook -> contracts/API/transport。
`teleop` 可以使用 `monitoring`；`monitoring` 不反向调用驾驶输入。
后端占用摘要写入 read model，不能让组件自己推导或修改控制权。
Zustand 仅在需要跨页面共享读模型时使用；Room、密钥和 sender 放生命周期服务，
不能放可序列化/持久化 store 或调试快照。

### 7.2 Gateway

- 保留现有单 Go 服务、`internal/gateway` 和认证入口，按文件职责增加模块。
- registry/state/fleet query 提供授权读模型；control/video/demand 提供会话权威。
- 所有 HTTP handler 走同一身份/ACL helper，再调用服务/存储；不在每个 handler 重写租约规则。
- 控制仲裁写入状态版本并产生可重建的占用变化；车队事件流只消费其摘要。
- 接口 DTO 区分设备同步、普通观察、本人会话，不能直接把内部 ControlSession 全量用于列表。
- `app.go` 只组装依赖/路由，不继续堆业务状态机；先复用现有审计和 Redis 机制，不创建通用插件框架。

### 7.3 Edge

- 一个 Edge 进程只属于一辆车，拥有一个需求协调器和至多一个 RTC 连接。
- Cyber adapter -> latest state -> telemetry uploader / RTC state publisher，两路独立背压。
- session sync -> verifier/runtime，media demand -> RTC/media coordinator。
- 设备实例、控制 revision、租约期限共同约束旧会话恢复；媒体重连不恢复驾驶动作。
- 多车聚合、任务跨车调度和操作员选择逻辑不放进车端。

### 7.4 SDK + Cyber 的车端模块化落地

以“可嵌入 SDK + 薄 Cyber 适配 + 独立网络任务”为主线，不要求
摄像头驱动、遥测、鉴权与驾驶控制都编译进一个大组件。

| 层 | 当前实现/接口 | 依赖及边界 |
| --- | --- | --- |
| 规范化公共层 | `VehicleEdge::state`，缓存及 JSON 契约 | 不依赖 Cyber/LiveKit；共享字段/单位/缺失语义 |
| 配置/HTTP 层 | `::config`、`::transport` | 保护配置、URL 校验、有界 HTTPS；复用公共标识规则 |
| 鉴权 SDK | `::auth`，`AuthenticatedClient` | OAuth 获取/刷新/401 失效；每网络任务独立实例；不把设备凭据交给前端 |
| 远程驾驶 SDK | `::teleop`，`TeleopClient/DemandGate/MediaService` | 需求及媒体 token、单调期限和 worker 回收；仅依赖鉴权公共模块，当前只读，不授予驾驶权 |
| 可选数据 SDK | `::data`，`TelemetryUploader` | 遥测、Mission 上传；不依赖 Cyber 或 LiveKit |
| 完整兼容运行层 | `::runtime`，`SourceService` | 聚合 data + teleop，保留独立源上传 |
| Cyber 数据 adapter | Bazel `:cyber_adapter` + `:vehicle_telemetry` | 真实 WheelOS protobuf reader；回调只更新缓存，不阻塞网络 |
| LiveKit 媒体 backend | 可选 `vehicle_media_worker` | 合成视频或外部 H.264 AU -> 官方编码源；与 Cyber ABI 隔离 |
| camera_gst adapter | 可选 `::camera_gst`，`CameraGstAdapter` | GstSample 转换、有界 AU/IPC、关键帧/码率辅助接口已实现；驱动挂接、资源所有权及硬件/aarch64 待验收 |
| 控制 adapter | **待实施且禁用** | 单会话签名验证/失效处理/执行反馈/物理交接；不复用媒体开关 |

上表 CMake 全名为 `VehicleEdge::<name>`，对应 Bazel `:<name>`；
共享 SDK 已可通过 `find_package(VehicleEdgeSDK)` 链接，CMake 安装导出与 CPack TGZ
已实现。Cyber 依赖只留在 native targets。SDK 不安装设备凭据、不自动开服务、不自动启用驾驶。
当前数据 SDK 类型入口是 `vehicle_edge/data_client.h`；
`http_client.h` 仅保留传输层，调用方已一并迁移。
远程驾驶需求/token 已迁至 `vehicle_edge/teleop_client.h`，不再由数据 SDK 提供。
纯远程驾驶交付为 Auth + Teleop 两包，分别支持
`find_package(VehicleAuthSDK)` / `find_package(VehicleTeleopSDK)`；
运营 Data 包可不安装。完整方案及阶段边界见
[双 SDK 计划](../.agents/teleop-sdk-plan.md)。

#### 已核实的 camera_gst 接口与视频数据通路

依据本地 `apollo-lite/modules/drivers/camera_gst` 源码：

- `README.md`：输出 NVMM GPU 回调和可选 H.264/RTP；**不发布 Cyber Image**。
- `streamer.h`：`Start(config, GpuFrameCallback)`、`StartStreaming()`、
  `StopStreaming()`；`Stop()` 会结束整个相机流，不能拿它实现共享相机的远程需求关闭。
- `pipeline_builder.cc::BuildDefaultStreamBranch()`：
  `nvv4l2h264enc -> h264parse -> rtph264pay -> udpsink`。
- `camera_gst_component.cc`：已有 Cyber StreamControl service；
  GPU 回调当前用于观察/日志，不是可跨进程传递的图像 topic。
- `frame_types.h::GpuFrame`：持有 NVMM/NvBufSurface 生命周期，
  指针不能直接跨进程放入 Cyber 消息或当作 CPU 字节使用。

**首选路径**：复用相机/硬编，在 `h264parse` 后、`rtph264pay` 前建立有界媒体分支，
输出完整 H.264 access unit，经薄媒体 adapter 交给官方
`livekit::EncodedVideoSource`，再由 LiveKit SDK 完成 WebRTC 发布。
现有 RTP/UDP 不是 LiveKit 客户端，不能只替换目标 host 为 SFU 地址；
也不能将 RTP 包直接传入 `captureFrame()`。若为了零侵入暂用本地 RTP，
必须明确增加 jitter/depay/parse adapter，而不是假定已有直连能力。

编码输入约束：明确 stream/track/camera ID、尺寸、H.264 字节格式、
AU 边界、PTS 到单调/源时间的映射、关键帧及 SPS/PPS；有界队列且不在采集回调中
进行网络请求。SDK 的 `takeFeedback()` 关键帧请求和码率/帧率目标返回编码器，
队列丢帧或重连后等待新可解码关键帧，不重放旧视频。
实际协商的 H.264 profile/格式和目标平台能力须实测，不能由头文件支持推断硬件已兼容。

**进程边界**：当前 worker 隔离 SDK 阻塞，继续保留。
已实现独立 descriptor 4 的有界编码帧/反馈 IPC；descriptor 3 保留需求期限与状态。
AU 最大 128 KiB、入口最多两帧、局部到达与 IPC 年龄最多 250ms；
丢帧/拥塞/代次切换后丢弃参考链并等待含 SPS/PPS 的 IDR。
PTS 映射到本地单调时钟不等于验证了相机源时钟和端到端延迟。
`CameraGstAdapter::SubmitSample()` 不持有 GstBuffer/NVMM，不访问网络；
回调必须在销毁 adapter/service 前停止。仅接受 byte-stream/au，无 B 帧。
不在未验证前将 SDK 直接塞入自动驾驶共享采集线程。后续可以增加同进程
publisher，但必须证明阻塞隔离和清理不影响自动驾驶。

**按需权限边界**：Gateway 有效观看/控制租约 -> 设备认证需求查询 ->
期限 gate -> 本 Agent 的编码/发布分支。需求结束只拆远程分支/worker；
自动驾驶仍使用的采集、GPU callback、感知 reader 不关闭。
如果多个消费者共用编码分支，先落实 owner/reference 机制，不能直接调用
全局 `StopStreaming()` 影响其他消费者。

#### 操作员：多车选择不等于多车控制

界面独立维护：可选车辆列表、多个观察 Room、唯一操作目标、唯一服务端控制会话。
本轮已加入“设为操作目标”，选择/切换不申请租约、不更换 Room、不发送指令；
页面明确显示当前工作台没有控制车辆。之后接入控制协调器时，指令必须绑定
服务端 session 的 vehicle，而非跟随 `focusedVehicleId` 或最近状态包。
A 交接未确认时即使选中 B，也不得授予 B 控制；后台已存在相应跨车持久栅栏。

#### 安装与实施顺序

1. **已完成**：拆分 SDK build targets、统一鉴权/数据接口、导出头文件/静态库/
   CMake package、TGZ 打包，以及独立安装消费者验证。
2. **已有软件闭环**：Cyber reader -> cache -> Data SDK -> Gateway -> 前端；
   需求 -> worker -> LiveKit 合成视频/状态，及离线 H.264 AU -> IPC -> 实际 RTC 解码。
   实际 topic/设备部署仍需联调。
3. **软件适配已完成，硬件待验收**：camera_gst GstSample adapter、worker 帧 IPC、
   关键帧/码率反馈接口；尚未挂接 Apollo 共享相机分支，未验证实际编码器反馈、
   aarch64/Orin 或相机端到端延迟，不修改现有共享相机所有权。
4. **独立门槛**：SDK + native 可执行文件按目标平台打包、系统服务和凭据配置、
   安装/升级/卸载及故障恢复验证。当前可选打包已构建的 native 可执行文件，
   但不宣称 TGZ 同时交付 Cyber 运行时和硬件驱动。
5. **后续且禁用**：原生控制/执行反馈/物理交接；先台架确认，再开放真实驾驶。

## 8. 目标目录结构

以下均为目标路径；新增文件只在实现相应功能时创建。已有同名模块优先复用，
cyber 分支模块按需迁移，不整体搬代码，不为目录整齐而先重构已稳定功能。

### 8.1 契约与文档

```text
agents/
  frontend-platform-architecture.md       本文：框架/多车/模块/目录
  frontend-platform-diagrams.md           总体/模块/状态机/跨车切换图
  frontend-data-integration-plan.md       阶段、链路、按需视频与验收
  frontend-teleop-integration-design.md    原迁移阶段记录
api/
  README.md                              接口与版本兼容入口
  schemas/
    datachannel-control.schema.json      保留现有签名协议
    vehicle-state.schema.json            标准化状态/源质量/版本
    fleet-summary.schema.json            遥测摘要与控制占用 DTO
    viewing-session.schema.json          观看租约与续租
    rtc-demand.schema.json               媒体需求与期限
    control-session.schema.json          实例身份/释放状态/应用确认
```

契约为跨 Go/Python/TS 的语义基准；各语言适配器使用公共 fixtures 验证，
不首期引入大规模代码生成工具链。破坏性变化要版本化。

### 8.2 前端

```text
frontend/src/
  App.tsx
  app/
    AuthProvider.tsx
    PlatformLayout.tsx
    routes.tsx
  lib/
    api/
      client.ts                          授权请求、错误、取消
      stream.ts                          订阅/游标/重新同步
    contracts/
      vehicle-state.ts
      fleet-summary.ts
      sessions.ts
    teleop-config.ts                     复用公开配置
  features/
    vehicles/
      vehicle-api.ts
      vehicle-store.ts
      use-fleet.ts
      selectors.ts                       单位/展示派生，不改原始事实
    monitoring/
      viewing-session.ts
      room-registry.ts
      vehicle-room.ts
      use-vehicle-monitor.ts
      components/VideoGrid.tsx
    teleop/
      control-api.ts
      control-coordinator.ts
      secure-control-sender.ts
      switch-machine.ts
      use-teleop-workspace.ts
      components/ControlOccupancy.tsx
      components/ControlPanel.tsx
    fleet/
    vehicle/
    alerts/
    tasks/
    history/
  pages/
    Home.tsx                             渐进迁移，不继续承载所有业务
    FleetPage.tsx
    VehiclePage.tsx
    TeleopWorkbench.tsx                   页面编排，不内置 SDK/租约逻辑
    AlertsPage.tsx
    TasksPage.tsx
  components/ui/                         保留现有基础组件
  mocks/
    providers.ts
    scenarios/                           确定性多车/租约/切换场景
```

feature 内测试就近放置；只有形成稳定共用逻辑才抽公共模块。
只读详情与驾驶 HUD 可共用数值展示组件，但数据来源和就绪规则不能合并。

### 8.3 Gateway：先按文件划分，不先拆包

```text
apps/teleop-gateway/
  cmd/teleop-gateway/main.go
  internal/gateway/
    app.go
    oidc_auth.go / vehicle_acl.go / vehicle_identity.go
    vehicle_registry.go / vehicle_registry_api.go
    vehicle_state.go / vehicle_state_api.go
    fleet_query.go / fleet_stream.go
    control_lease.go / control_session.go / control_session_api.go
    control_handover.go                   释放栅栏、回报与恢复
    video_session.go / video_session_api.go
    rtc_demand.go / rtc_demand_api.go
    livekit_token.go / audit.go
    ..._test.go
  migrations/                            引入持久业务/交接记录时新增
```

`control_handover` 扩展现有 ControlSession，不建立另一套驾驶授权。
告警/任务/历史先在同一服务内按职责实现，只有复杂度和维护证据足够时再拆内部包或服务。

### 8.4 Edge：C++ 原生后台，保留 Python 兼容入口

```text
apps/vehicle-edge-cpp/
  MODULE.bazel / BUILD.bazel              原生 Cyber executable 与 protobuf 测试
  CMakeLists.txt                         双 SDK 导出/组件打包/可选 GStreamer 与 LiveKit
  cmake/                                依赖固定与可重定位安装配置
  bazel/                                GStreamer pkg-config 发现
  config/device.example.json
  include/vehicle_edge/
    config.h / state_cache.h / http_client.h / auth_client.h
    teleop_client.h / media_demand.h / media_service.h / encoded_video.h
    data_client.h / source_service.h
    cyber_adapter.h / camera_gst_adapter.h
  src/
    common/                              config / state_cache / http_client
    auth/                                auth_client：OAuth
    teleop/                              teleop_client / media_demand /
                                         media_service / encoded_video
    data/                                可选 data_client / source_service
    adapters/cyber/                      protobuf 转换；仅依赖 state
    adapters/camera_gst/                 可选 GstSample/反馈辅助接口；不持有相机
    workers/                             media_backend / media_worker
    apps/                                vehicle_telemetry 只读组装
  tests/
    telemetry_test.cc / cyber_adapter_test.cc / media_test.cc
    encoded_video_test.cc / camera_gst_test.cc
    livekit_integration_test.cc / livekit_e2e.py
    sdk_consumer/ / teleop_consumer/       独立安装消费者，不借用源码路径
apps/vehicle-edge/                       Python 旧入口保留，不自动与新后台双启动
```

控制会话同步/接收、执行反馈与物理交接只在实现时新增，不建立空实现。
C++ 后台迁移需保持原协议与安全边界，
不能把 Python 类型/SDK 调用直接翻译为未经验证的 C++ 接口。CPU/GPU、Mission、持久事件
及媒体 SDK 在对应阶段接入；在确认执行器归属前禁止新旧后台同时控制同车。

## 9. 框架落地顺序与验收门

1. 完成车辆/实例身份、占用摘要、观看租约、控制释放及目录契约；核对旧入口和 cyber 兼容点。
2. 形成多车目录和常在线遥测闭环，页面能显示每车占用，不建立多余 Room。
3. 完成观看租约、媒体需求与多车只读 Room registry，验证资源预算和互不串流。
4. 完成实例化控制身份、服务端仲裁、撤销 revision 和交接恢复；先隔离模拟验证单车释放。
5. 完成 A -> B 的状态机及异常路径，再开放多车驾驶切换验证。
6. 框架稳定后按模块契约补 mock/业务页面，最后逐模块接入真实健康、Mission、事件和历史。

必须覆盖的多车场景：

- A/B 遥测、相机和控制反馈绝不串车；旧 A 回调不能改写 B HUD 或 sender。
- A 被占用、B 空闲、C 离线能同时正确显示；权限外车辆不可查询。
- 两操作员竞争同车只有一个成功；同操作者跨设备申请两车由服务端拒绝。
- A 已释放但无 Edge 确认时，B 只能观看；TTL/Gateway 重启不能绕过未确认交接。
- B 竞争失败、token 失败、连接取消、回滚失败均不恢复 A 的旧指令。
- 删除 A 面板不影响 B；关闭一个 viewer 不影响别人的观看或控制。
- 多车观察预算满时不驱逐当前驾驶连接；观察故障不触发跨车自动接管。

本阶段交付是以上框架、边界及目录设计；性能上限、部署参数和实际交接条件仍需受控验证，
不能把文档设计当作已实现功能或安全保证。
