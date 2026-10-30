# 自动驾驶运营平台数据接入与按需会话实施计划

日期：2026-10-30

状态：遥测、观看租约、多车监看、Data 业务前端与运维首阶段已实现；实车执行、原生媒体和物理交接验收尚未关闭

平台入口：`frontend/`

车端参考：本地 `apollo-lite` 与 `origin/cyber@1fd705d`

框架入口：[多车接入、驾驶切换、模块与目录设计](frontend-platform-architecture.md)。
配套图示：[架构、模块与切换时序图](frontend-platform-diagrams.md)。
该文细化本计划的多车隔离、占用读模型、多 Room 观看及 A 释放后切换 B 的确认栅栏。
框架/模块/目录设计已完成；以下策略仅在“实施进度”明确标注时视为已实施。

2026-10-30 实施选型：Go Gateway + React/TypeScript + C++17 原生 Cyber 车端后台。
新增车端代码位于 `apps/vehicle-edge-cpp/`，不继续扩建 Python 主后台。
原 Python 路径和接口描述是能力参考，C++ 媒体/控制迁移须独立验证；先实施 P0/P1
独立遥测，未通过车辆交接和媒体能力验证前不开放跨车驾驶。

### 实施进度与交付边界

- 已合入 `cyber-apollo-base` 的键盘/手柄与前后视角验证成果，但不切换平台主实现。
  React 复用纯输入/视角状态机，经严格适配走当前 v2 模拟协议；保留单操作员单车、
  按需媒体和权威交接。旧 Python/v1 留作参考，不实现当前按需媒体/交接，不开放
  实车挡位/模式，不宣称六路真实相机已接入 C++。合并范围和验证记录见
  [SDK 计划](../.agents/teleop-sdk-plan.md#cyber-apollo-base-合并落地)。

- 最新业务接入已覆盖 `/data` Monitor、人工告警确认、只读 Mission query 生命周期、
  云端/设备积压与保留容量、80% 预警及有界非破坏性 NDJSON 导出。
  数据契约、轮询与 UI 分层；预览无网络/写入，查询未知结果保留原始身份。
  `/operations` 只保留兼容遥测读区。下文较早的“Monitor 仅缓存/无任务写入”
  记录不再描述当前能力；实车变更任务和模式仲裁仍未实现。
  本阶段命令、结果及剩余门槛见
  [SDK 计划的后续缺口实施章节](../.agents/teleop-sdk-plan.md#后续缺口实施业务前端与数据运维首阶段)。
- 双 SDK 独立交付已完成首阶段：鉴权公共库归 Auth 包，媒体需求/token 与
  监督生命周期归 Teleop 包；Data 包为可选运营扩展。只解压 Auth + Teleop
  的外部消费者已构建运行通过，含 LiveKit 的两包也已验证重定位及 worker smoke。
  真实 camera_gst 和车辆控制闭环仍未实施；后续计划在
  [`.agents/teleop-sdk-plan.md`](../.agents/teleop-sdk-plan.md)。
- 双 SDK 第二阶段软件通路已实现：可选 camera_gst GstSample adapter ->
  两帧入口/有界版本 IPC -> LiveKit EncodedVideoSource，并返回关键帧和码率/帧率目标。
  离线 H.264 已通过实际 RTC 解码；不代表真实相机已接入。
  源码按 common/auth/teleop/data/adapters/workers/apps 整理，公共 include 保持稳定。
  Apollo 分支挂接、相机资源引用计数、NVENC/Orin 实测和控制闭环仍未关闭。
- SDK 收敛补齐终止式并发安全 Stop、进程资源独占、会话反馈清理、显式 HTTP 初始化、
  token/path 控制字符拒绝和 worker vehicle_id 绑定；新增随包只读示例与 CTest
  `sdk_delivery` 自动验证两包独立消费。完成定义明确区分只读 SDK 基线与
  **模拟软件闭环与实车适配**；本轮已补齐前者，仍不宣称具备物理驾驶资格。
- v2 模拟控制已打通 Gateway 仲裁/设备 context、前端签名及会话生命周期、
  LiveKit/有界 IPC、C++ 验包/撤销/看门狗/反馈与模拟交接后跨车切换。
  `python3 tests/control-chain.py` 可验证完整软件通路；详细协议与启动方式见
  `apps/vehicle-edge-cpp/README.md`。真实执行器、相机台架与物理交接门槛保持关闭。

- 已建立 `api/schemas/vehicle-telemetry.schema.json`，区别于驾驶 DataChannel 的
  `vehicle.state`；约束可选字段、单位、时间、流 ID 和序号。
- `apps/vehicle-edge-cpp/` 实现 C++17 原生 chassis/localization 只读适配、
  线程安全最新缓存、OAuth 设备认证和有界 HTTPS 上报；原生媒体进展见 P3。
  没有执行器控制 writer。
- Go Gateway 实现注册车辆目录、设备上报、ACL 状态查询、Redis 原子最新值及旧流栅栏。
  `VEHICLE_REGISTRY_JSON` 已接入 Compose；未注册或未授权的车辆不会自动出现在目录。
- `frontend/` 车队与监控页改接真实接口；驾驶工作台选车使用相同目录。
  显式 `?preview=1` 才保留原静态演示。只查看状态不会创建 Room。
- P1 首期采用每 2 秒 REST 轮询而非 SSE；后续业务接入见下文 P4–P6 进度。
  源测量、回调、Gateway 接收年龄分别表达，离线保留最后值但不能当成实时数据。
- P0 的地图投影、源时钟和实例 sender 联调仍未关闭；P1 代码验证不等于车端部署验收。
  P2 及后续进度见下文；软件实现、媒体联调和 A→B 物理驾驶交接分别验收。
- 未修改 Apollo 工程、现有 Python 媒体入口或执行器策略；未部署、未连接真实车辆。
- 首期验证通过：Go 全量测试及遥测竞争测试，前端 13 项数据层测试及生产构建，
  C++ 独立测试、托管容器真实 protobuf 适配测试及原生可执行文件构建。
  C++ 实际生成的快照分别通过 Go 和前端解析器。可执行文件已检查动态库加载，
  但尚未进行 Cyber 运行时发现、跨进程订阅或车辆端到端验收。

### P2 首期：独立观看租约与权威媒体需求

- 新增 `viewing_lease*.go`，将观看者从旧车辆级共享计数分离为独立租约。
  acquire 绑定车辆、tenant、operator、客户端实例及 request ID；重复 acquire 不延长租约，
  renew/release 检查当前 observe ACL 和所有者。释放幂等，已过期/释放的租约不能续期。
- Redis Lua 使用 Redis TIME 原子维护租约、有效观看集合与需求 epoch/revision。
  TTL 为 30 秒、10 秒续期；最多 64 个有效观看者。过期在需求查询/变更时回收；
  幂等记录保留最多 24 小时，不能承诺超出该窗口的请求去重。时钟回退及存储故障显式失败。
- 设备自查 `GET /api/vehicles/{vehicle_id}/media-demand`；其他设备及浏览器不能代查。
  需求由有效 viewer 或真实 ACTIVE 控制租约产生，不信任旧 `VideoSession` 缓存字段。
  响应最多有效 5 秒、建议每秒查询，控制 TTL 较短时进一步收紧；当前无媒体宽限期。
- frontend 只读工作台已改用 acquire → Room → 串行 renew → release。
  连接失败、续期失败、退出、换账号、迟到 acquire 均清理；异常退出仍由 TTL 兜底。
  监看 token 使用独立 `observer-<viewing_session_id>` identity，禁止发布轨道和 DataChannel；
  控制身份及签名协议不变。视频仅显示来自目标 `vehicle-<id>` 的轨道。
- 旧 `/video` 接口和 Python 媒体入口保留兼容，不接入新需求权威；不可混用生命周期。
  观看租约不等同于 LiveKit token 撤销：其他需求保持 Room 时，旧 token 仍有自身有效期，
  当前未实现即时踢除/撤销。不能将释放观看当作驾驶权撤销或物理交接确认。
- P2 首期只提供云端/浏览器契约；后续 C++ SDK 和多 Room 实现见 P3/P4。
  不能用需求接口的单元测试代替无人零视频流量或安全切车的部署验收。
- P2 代码验证：Gateway `go test ./...` 与
  `go test -race ./internal/gateway -run "^TestViewing" -count=1` 通过，
  包括隔离真实 Redis 7 的 Lua 生命周期验证；前端 `npm test && npm run build`
  通过（31 项测试及类型/生产构建）。尚未进行浏览器—LiveKit—C++ 端到端验收。

### P3 续实施：原生 SDK 与按需媒体模拟闭环

- 已固定官方 LiveKit C++ SDK v1.13.0、commit 及 Ubuntu 22.04 x86_64 包 SHA-256；
  CMake 可选构建/安装真正 SDK worker，原生 Bazel 后台不依赖 Python 媒体桥接。
  `media_enabled` 默认 false；目前仅支持显式 simulation 相机，绝不把合成画面标为真实车端视频。
- 需求轮询、媒体监督、遥测和可选 Mission 上传为独立任务。需求期限扣除 OAuth/HTTP
  完整往返，使用单调时钟；相同 revision 的新响应可续期，缓存时间/旧 revision/退休 epoch
  不可复活需求。失败、需求归零或到期执行无宽限期清理，不影响遥测缓存和上传。
- 官方 SDK 阻塞 connect/publish/destruction，因此使用自有 worker 进程隔离，
  不让不可取消 SDK 调用阻塞后台；先请求正常退出，200ms 后仅对本进程拥有的 worker
  强制终止并回收。没有 detached 线程或 Python fallback；这不是执行器失效策略。
- 读取同一状态缓存通过 reliable DataChannel 发布 v2 只读 `vehicle.state` 反馈。
  它不是原 Python flat v1 消息的
  驾驶就绪依据，不能让旧客户端把新格式当作控制反馈；版本边界见模块 README。
- 可按明确配置的 topic 订阅真实 MissionRuntimeStatus、MissionRequestResult 和
  SystemStatus protobuf。仅 Runtime 的有效源时间/ID/状态可通过独立 HTTPS 任务上报
  Mission 状态；Result 没有源时间则保持未知。Monitor/Result 当前只进入缓存/RTC，
  尚未作为常在线平台诊断的独立持久来源。没有任务请求或控制 writer。
- 已通过 SDK-enabled CTest 3/3、disabled CTest 2/2、真实 protobuf Bazel 3/3 及原生
  可执行文件构建。隔离 LiveKit 接收端确实收到合成视频帧及 `vehicle.state`，
  接收端同时验证 v2 及 reliable；停止需求续期后 worker 退出且只读观察者仍在 Room；
  安装目录 worker smoke 通过。
  复现命令和依赖见 `apps/vehicle-edge-cpp/README.md`。
- **尚未关闭**：真实 Cyber 相机 reader/所有权与格式、真实 topic discovery、
  生产网络 OFF 流量/CPU/GPU/句柄证据、目标架构部署，以及物理控制/交接台架验收。
  模拟视频闭环通过不等于已能部署真实车辆按需推流。

### P4–P6 续实施：多车只读、持久业务与交接栅栏

- 工作台最多同时监看四辆车，各自持有 Room、观看租约、续期和清理任务；
  关闭其中一辆不释放其他车的观看权。仍禁止驾驶输入，不以多车选中代表驾驶切换完成。
- 首页静态业务数据替换为真实授权目录及独立业务查询。新增诊断、告警、只读 Mission
  和遥测历史；`?preview=1` 使用同一解析器的固定预览数据，不发送真实业务/驾驶请求。
  新鲜度用请求起点的单调时钟持续增长，超过五秒或错误后的快照显式显示为缓存。
- Gateway 新增 `vehicle-operations.schema.json`、SQLite v1 迁移与有界持久存储；
  每车分别保留最近 1000 条遥测/告警/Mission，查询上限为 300/100/100。
  告警当前来自新鲜底盘 error_code 转换，未知/陈旧数据不自动恢复故障；
  这不是完整 SystemStatus、人工告警处理流或车端重要事件持久队列。
- 新增 `GET /api/vehicles/{id}/operations` 及设备专用
  `POST /api/vehicles/{id}/mission-status`。任务仅接收幂等状态，不派发、取消或宣称
  Apollo Mission 已实接。历史有流切换及序号缺口标记，不是完整轨迹/录像回放。
- 遥测先写 Redis、后写 SQLite，二者不是分布式事务。SQL 故障返回 503；
  只允许完全一致、仍为 Redis 当前值且未归档的包重试 SQL，保留原始接收时间。
  已归档、被更新替代或内容不同的重放仍拒绝，不能借归档恢复突破旧流/序号栅栏。
- 控制仲裁已在 Redis Lua 中增加 tenant/operator 跨车唯一约束及持久车辆/操作者栅栏。
  HTTP release 改为 `202 PENDING`，过期也不视为交接；目录中的未确认占用为 unknown。
  `control-handover.schema.json` 分开表达原生撤销和物理交接两项确认；
  仅原生撤销确认不解锁，旧 session/revision 不可清除当前栅栏。
- `CONTROL_HANDOVER_ACK_ENABLED=false` 为默认部署门控。尚无经过批准的 C++ 控制接收、
  执行器反馈与物理交接策略，因此驾驶能力保持 false，不实现强制解锁或超时自动解锁。
  已有 Python 控制协议保留为参考，不等于原生控制迁移已完成。
- Compose 新增 Redis AOF/always/noeviction、Redis/SQLite 持久卷、健康依赖及非 root
  SQLite 目录；`/readyz` 同时检查 Redis 和 SQLite。SQLite 当前仅支持单 Gateway，
  不宣称多个副本的独立文件能共享业务历史；升级/备份边界见 `docs/operations.md`。
- 验证通过：Gateway `go test ./...`、业务/遥测归档/交接/观看定向 race 测试、
  `CGO_ENABLED=0 go build ./cmd/teleop-gateway`；frontend 37 项测试及生产构建；
  实际 Go operations 响应通过前端严格解析器。隔离真实 Redis 完成控制竞争/过期/确认
  及 AOF 重启验证；实际 Gateway 镜像完成认证上报、业务查询、非 root 文件权限、
  readiness 和容器重启后 SQLite 记录保留验证。未向共享 Compose 或真实车辆部署。
- **尚未完成的完整验收**：浏览器—LiveKit—原生视频首帧及 OFF 零视频流量证据、
  原生控制和物理交接、Monitor/Mission 实际 topic 联调及 Monitor 持久来源、人工告警处理、完整回放、
  地图投影/相机所有权/源时钟，以及全部故障 mock 场景。以上不以页面存在视为完成。

### 本轮：优先完成现有数据接口的 mock 契约验证

- 新增 `tests/platform-contract.sh`：合成车端输入调用真实 Gateway HTTP handler、
  认证/ACL、Redis 兼容测试实例及 SQLite，再将实际响应交给前端 Zod 与新鲜度/
  历史连续性规则校验，最后用发布的 Draft 2020-12 JSON Schema 校验。
  没有用手写响应替代 Gateway，也不需要真实车辆、密钥或部署。
- 16 个跨端场景已通过：未收到数据、行驶、停车、倒车/故障/序号缺口、缺失不恢复、
  陈旧不恢复、未来时钟、明确恢复、六种 Mission 状态、离线保留最后值、新流重启。
  同时验证错误设备/tenant 拒绝、非法版本/档位/数字/尾随 JSON 拒绝和多车记录隔离。
- 预览新增 `scenario` 参数；十种固定场景的双车数据共 20 份快照通过同一 schema。
  示例 `?preview=1&scenario=history`；完整场景与复现方法见 `frontend/README.md`
  和 `tests/README.md`。预览不产生观看租约、真实任务或驾驶请求。
- 验证发现并修正：旧预览告警 event_id 不符合 64 位十六进制契约；前端对
  非正时间戳、空/非法 stream 和 Mission ID、2048 UTF-8 字节任务描述限制校验偏宽。
  年龄仍允许零，缺失仍保持 null，不以默认值代替未知。
- 本轮结果：跨端场景 **16/16**，发布 schema 验证 **36/36**，前端
  `npm test` **39/39** 与 `npm run build` 通过；Gateway `go test ./...`
  及 PlatformMockContracts/Operations/TelemetryArchive/Viewing/ControlHandover/
  ControlHTTP 定向 `-race` 通过。系统 Python 的旧 jsonschema 不支持 Draft 2020-12，
  已用隔离 virtualenv 的声明依赖完成验证，未修改系统 Python。
- **mock 可完成与不可替代的边界**：现有接口的序列、数据质量、业务记录、授权、
  观看失败/超时/清理与服务端交接栅栏已具备可重复验证；真实视频/物理交接仍不是
  mock 验收对象。尚无接口的 Monitor 常在线持久接入、人工告警处理和完整回放，
  不以预览或现有 history 查询冒充实现；驾驶能力仍关闭。

### SDK + Cyber 模块化框架续实施

- 确认产品不变量：操作员可选择/切换多辆车，允许多车只读观察，但同一 tenant/operator
  最多控制一辆车。界面新增唯一操作目标，与观察 Room 分开；选中不申请控制权。
  后续 sender 只能绑定服务端的唯一 control session，不能跟随下拉框自动切换。
- C++ 实际拆分 `state/config/transport/auth/data/runtime` 六个 CMake/Bazel targets；
  OAuth 从业务 uploader 分离为独立 `AuthenticatedClient`，有界 HTTPS、token 刷新/
  401 失效机制复用，设备数据端点保持一致。`data_client.h` 是 uploader 的新入口，
  已同步全部 native 调用方；Cyber 和 protobuf 不进入通用 SDK。
- 新增 CMake package 导出、头文件/静态库安装、CPack TGZ，以及独立 `sdk_consumer`
  工程。可按需链接 `VehicleEdge::auth/data/runtime`；可选附带已在目标 Cyber 环境
  构建的可执行文件。SDK 安装不包含设备凭据，不自动启动进程/安装硬件驱动，
  也不宣称跨架构二进制通用。命令见 `apps/vehicle-edge-cpp/README.md`。
- 已核实 Apollo `camera_gst`：GPU 回调为 NVMM，并非 Cyber Image；
  视频分支是 `nvv4l2h264enc -> h264parse -> rtph264pay -> udpsink`，
  可单独启停 stream branch。现有 LiveKit SDK 有 `EncodedVideoSource`，
  因此设计优先复用 H.264 AU，不二次采集/编码，不把 RTP 包误当编码帧。
- **尚未接通真实相机**：后续增加 h264parse 后的 AU adapter、worker 有界 IPC、
  PTS/关键帧/SPS/PPS/拥塞反馈和资源所有权；Orin/aarch64 SDK 也须独立验证。
  本轮只读取 Apollo 源码，没有修改驱动或共享相机配置。
  完整模块与数据通路见架构文档 7.4 和 SDK 图。
- 验证通过：SDK CTest 3/3、无 LiveKit portable CTest 2/2、实际 RTC 合成帧/v2 状态
  接收及到期退出；在托管容器中 native Bazel 三项测试和可执行文件构建通过。
  CPack TGZ 已生成，并从另一个目录解压后独立构建/运行消费者通过，验证导出包可重定位，
  不借用源码路径或隐式 Cyber/LiveKit 依赖。前端 39 项测试与构建通过；
  操作目标选择不改变既有观看租约生命周期。未部署到车辆，未修改 Apollo 工程。

## 1. 已确认决策与范围

1. 保留远程驾驶 DataChannel：控制指令、当前车辆实时状态反馈走 LiveKit；不绕经云端业务遥测接口执行驾驶控制。
2. 其他模块使用独立遥测：车队总览、车辆详情、健康、告警、任务和历史不依赖观看会话，也不为获取车辆状态逐车加入 Room。
3. 视频按有效会话需求启停：无人观看且无有效控制会话时，不采集、不编码、不发布视频；不是维持低帧率待机推流。
4. 先完善框架和契约，再形成最小真实闭环，最后用同契约 mock 完善模块；不把静态演示数字当作数据接入。
5. 本文是设计与实施计划，不授权开放真实车辆驾驶、修改执行器策略或部署；不提交或切换分支。

本文扩展 [原统一入口与远程接管迁移设计](frontend-teleop-integration-design.md)。
原文中“遥测、资产、多 viewer、按需视频暂不建设”仅描述上一迁移阶段；本阶段以上述新范围为准。
原文身份认证、密钥边界、签名控制、导航保护和人工回退约束继续有效。

## 2. 方案制定时的基线与缺口

下表保留设计起点的源码证据；当前完成情况以文首实施进度和各阶段验收记录为准。

| 范围 | 已有能力 | 本阶段缺口 |
| --- | --- | --- |
| `frontend/` | 平台身份和只读 LiveKit 视频工作台 | 真实车辆目录、遥测层、观看租约、完整相机能力映射 |
| `origin/cyber` | Cyber 订阅、5 Hz `vehicle.state`、控制签名验证及车端防护、RTC 重连 | 常在线业务遥测和按观看需求启停 RTC/媒体 |
| Gateway | ACL、设备身份、控制租约、视频会话原型 | 车辆状态读写、订阅、可靠观看租约、需求协调 |
| 视频会话原型 | ACTIVE/STANDBY、viewer 数量、控制会话引用、宽限期 | viewer 共用车辆级 session ID，不能可靠管理多个观看者；缺少逐观看租约续期和失联回收 |
| 车端媒体 | 配置相机后入房即启动 publisher | 未把 Gateway 视频需求接入采集/编码生命周期 |
| `/api/telemetry` | 延迟和丢包统计 | 不是车辆状态入口或查询接口 |

源码定位：

- `origin/cyber:apps/vehicle-edge/src/vehicle_edge/cyber_bridge.py`
- `origin/cyber:apps/vehicle-edge/src/vehicle_edge/state_publisher.py`
- `origin/cyber:apps/vehicle-edge/src/vehicle_edge/livekit_transport.py`
- `apps/vehicle-edge/src/vehicle_edge/vehicle_node.py`
- `apps/vehicle-edge/src/vehicle_edge/video_publisher.py`
- `apps/vehicle-edge/src/vehicle_edge/video_state.py`
- `apps/teleop-gateway/internal/gateway/video_session.go`
- `apps/teleop-gateway/internal/gateway/video_session_api.go`
- `apps/teleop-gateway/internal/gateway/control_session_api.go`

分支内已有代码不等于已在目标环境验证。迁移 cyber 能力时只移植本计划需要的依赖和调用链，不整体合并控制功能或模拟配置。

## 3. 总体框架：一个状态源，两条消费链路

```text
Apollo / WheelOS
  Chassis / Localization / Monitor / Mission / Planning
                         |
                  Cyber 只读订阅
                         |
                标准化状态 + 最新缓存
                    /             \
       常在线遥测/事件               按需 RTC 会话
                |                  |
       Gateway 数据接入         LiveKit Room
                |             /      |       \
       最新状态/持久化       视频    状态反馈   签名驾驶指令
                |             \      |       /
       REST + 授权实时订阅       远程驾驶工作台
                |
       车队/详情/告警/任务/历史
```

### 3.1 常在线遥测链路

- Edge 在没有 RTC Room 时仍订阅车端消息、上报心跳和业务状态。
- 首期复用 HTTPS 设备认证与 Gateway，不以 MQTT/Kafka 或拆微服务为前置条件。
- Redis 保存最新状态，快照及订阅服务使用明确的版本/游标语义。
- 告警、任务、历史索引需要持久存储；实施对应模块时引入数据库及迁移，不以 Redis 最新值代替历史。
- 快照 latest-wins、有界缓冲；重要事件/任务结果使用独立事件 ID、持久队列、确认与去重，定义保留上限和队列满错误。
- Cyber 回调不做网络请求；遥测中断不影响自动驾驶，也不阻塞 RTC 状态与指令处理。

### 3.2 远程驾驶 DataChannel 链路：保留

| 数据 | 通道 | 语义 |
| --- | --- | --- |
| 驾驶指令 | `vehicle.control` | 沿用签名、session、序号、时效及车端验证；定向发送至车辆身份 |
| 当前车辆状态反馈 | `vehicle.state` | 沿用版本化快照、流 ID、序号；直接反馈底盘/定位及控制发布状态 |
| 告警/任务持久记录 | 云端业务接口 | 不以 DataChannel 的 reliable 代替持久化与确认 |

- 指令沿用 cyber 分支的 lossy、单个在途发送和有界最新值策略，不缓存重放动作。
- 状态当前使用 reliable，因为完整快照可能超过推荐的 lossy 负载；首期保留，约束包大小与积压，测量拥塞后的真实接收年龄。
- 发布超时不等于撤回已进入 SDK/传输层的包；接收端必须校验源时间、序号和新鲜度，不能只依赖发送超时。
- 后续只有在实测必要时，才拆分小型 lossy 高频反馈与较低频快照；不在首次迁移时更改全部协议。
- 浏览器验证 Gateway 分配的发送者 identity、目标车辆、topic、版本、大小和数据类型；状态包不能授予控制权。
- “控制包发出”“Cyber writer 接受”“执行器反馈/实际动作”严格区分。
- 业务遥测与 RTC 从同一标准化状态/采样来源派生，不分别实现单位、枚举或坐标转换。
- 工作台驾驶 HUD 只以有效 RTC 反馈作为实时依据；断开或过期立即显式降级，不能静默切换到较慢的云端值并继续允许驾驶。
- 云端状态可以展示为带来源及时间的参考信息，但不能恢复控制就绪状态。

建议初始频率：业务摘要约 1 Hz，RTC 状态沿用 5 Hz；只是联调起点，不代表已满足驾驶时延或安全要求。

## 4. 按需推流：判断需求，不判断房间存在

### 4.1 准确定义

“房间存在”不能代表有人需要视频：车端自己加入也会创建 Room，空房保留时间也不是业务会话。

Gateway 聚合有效需求：

```text
rtc_required   = 有效观看租约存在 OR 有效控制租约存在
video_required = rtc_required
```

首期观看租约代表整车已配置视频集；不提前建设逐相机租约系统。
后续若增加录像、诊断等需求，必须作为独立、可审计、有期限的需求源，不能默认常开。

- 车辆目录、遥测订阅、地图打开、token 签发、房间创建本身均不启动视频。
- 仅显式进入实时视频监看或申请控制，才产生需求。
- 无需求时 RTC 退出，视频为 OFF；保留 HTTPS 心跳、需求同步与业务遥测，仍有少量流量，不能宣称整车网络零流量。
- 不采用“车辆常驻 Room 再看是否有订阅者”的首期方案，避免房间自保持和后台媒体任务持续占用。
- 不能只依赖 dynacast/adaptiveStream：它们不替代采集、编码和发布任务的显式关闭。

### 4.2 生命周期

| 状态 | 行为 | 退出条件 |
| --- | --- | --- |
| OFF | 无 RTC 连接，无相机采集/编码/发布，独立遥测继续 | 得到新的有效需求 |
| STARTING | 获取新 Room token、连接 RTC、按配置打开相机、发布轨道和状态 | 实际就绪进入 ACTIVE；失败进入 ERROR；需求取消执行清理 |
| ACTIVE | 发布视频与 RTC 状态；驾驶另受控制就绪门控 | 需求归零进入 GRACE，RTC 故障进入恢复/错误处理 |
| GRACE | 短期保留当前会话以防快速切换抖动；明确仍可能消耗视频流量 | 新需求返回 ACTIVE；期限届满关闭媒体并退出 RTC |
| STOPPING | 拒绝恢复旧任务，取消并等待媒体任务、unpublish、释放自有相机、退出 RTC | 清理完成进入 OFF；新需求由协调器在清理后重启 |
| ERROR | 上报启动/媒体/清理错误，不显示视频就绪 | 仅在需求有效时有界退避重试；无需求执行清理 |

宽限期允许为零。现有 `VIDEO_GRACE_SECONDS` 默认 45 秒只是历史值，不直接作为新节流策略的确认参数。
OFF 不复用现有“1 fps、100 kbps”的 STANDBY profile；需要显式 OFF 及资源生命周期。
Grace、需求同步间隔、租约期限、启动超时在受控联调中确定，并形成最大启动/失联回收时限。

若视频来自自动驾驶共享相机进程，只关闭本 Agent 的 reader、encoder、track；不得停止自动驾驶拥有的采集设备或进程。

### 4.3 观看租约与控制需求

- 每次观看创建独立 `viewing_session_id`，绑定车辆、操作者、客户端实例、到期时间；车辆级 Room/session 标识与观看句柄分离。
- acquire 支持请求幂等，重复请求不重复计数；renew/release 校验所有者及车辆权限，release 幂等。
- 多 viewer 的计数、续期、释放、过期回收使用原子更新；不沿用当前读改写共享计数实现。
- 浏览器定期续租；正常退出尽力释放，崩溃/断网依赖 TTL 回收，不依赖 unload 成功。
- 控制需求从当前未过期的控制租约派生；不能相信视频状态中残留的 `ControllerSessionID`。
- 控制租约到期、撤销、acquire 回滚和续租失败都触发需求协调；webhook 只是加速信号，不能替代 TTL。
- 一个 viewer 离开不能关闭其他 viewer 或有效 controller 的视频。
- 同账号多标签页必须明确 RTC identity 策略，区分会话实例并验证 SDK 替换连接行为；身份策略未验证前不承诺此场景可用。
- 多车监看按车辆分别持有 Room 与观看租约；驾驶焦点唯一。跨车切换须完成旧车释放及车端确认，
  再独立申请目标车辆；具体状态机与身份演进见框架入口，不能只切换前端 `selectedVehicleId`。

### 4.4 唤醒与需求同步

首期使用已认证 HTTPS 短轮询，由独立任务获取 Gateway 的 RTC 需求；不依赖已连接的 DataChannel 唤醒自身。

需求响应至少包括：

```text
vehicle_id
demand_epoch / revision
rtc_required / video_required
valid_until
retry_after
```

- Gateway 设备接口复用设备身份解析，禁止查询其他车辆需求；浏览器接口使用车辆 ACL。
- 响应设置禁止缓存；epoch/revision 防止旧响应复活已释放的会话，重启后的 epoch 变化需重新协调。
- 有效期转换为本地有界单调计时；旧响应不得无条件延长授权，跨设备时钟不确定性必须检测并限定容差。
- Gateway 不可达时，不从 OFF 启动；已有 ACTIVE 只在最后确认的需求有效期内继续，不无限保活。
- 过期后停止媒体前，先让任何已武装远程控制进入既有失效处理；本方案不引入新的驾驶/制动策略。
- RTC 故障时独立遥测继续；需求仍有效才退避重连，每次获取新 token，不能恢复旧驾驶动作。
- 启停由一个协调器串行执行；generation 防止迟到 token、相机启动和旧轮询覆盖当前会话。

### 4.5 操作员流程与控制就绪

1. 用户显式点击监看，创建观看租约；随后获取受限 Room token 并连接。
2. Edge 在下次需求同步时启动 RTC；页面分别显示“等待车辆入房”“等待轨道”“等待状态”，不假报离线或已就绪。
3. 视频就绪、RTC 状态新鲜、控制租约有效、车端允许控制等条件满足后，才允许驾驶输入；取得租约本身不允许车辆运动。
4. 退出、切车、退出登录时取消输入、释放本人租约、断开浏览器 Room；Edge 依据剩余需求决定是否关闭。
5. 控制会话本身保持媒体需求；不能为省流量在有效驾驶期间自动退出 RTC。
6. 摄像头启动失败时仍可报告 RTC 状态和诊断，但控制保持不可用；监看失败不触发车辆控制动作。
7. 连接失败、取消中的迟到 acquire 结果都要释放；若释放请求丢失，由租约到期兜底。

## 5. 数据语义与模块设计

### 5.1 统一契约

- 状态分开表达连接、驾驶模式、任务、健康、控制会话和质量，不再只用 AUTONOMOUS/IDLE/ALARM/OFFLINE。
- `Chassis.speed_mps` 保持 m/s，界面转换 km/h；档位显式映射，缺失/INVALID/NONE 不默认 D。
- `steering_percentage` 是百分比，不是角度；电量缺失或 -1 不是 0%；proto2 缺失枚举不解释为默认有效状态。
- 定位保留源时间、measurement_time、回调年龄、质量、坐标参考及地图版本；非有限值显示未知。
- 区分源测量停滞、Cyber 回调中断、网络中断；浏览器继续计算数据老化。
- `pose.position` 是地图参考系下的米，不是经纬度；地理底图必须有验证过的投影/原点和转换版本。
- localization/chassis 独立时间，不把异步最新值伪装成同一时刻采样；重定位/地图切换断开轨迹段。
- 复用 v1 适配器，新增契约版本演进；云端和 RTC 对同字段使用一致语义。

### 5.2 模块与交付

| 模块 | 数据来源与职责 | 完成条件 |
| --- | --- | --- |
| 车队总览 | 资产目录、常在线遥测、最新位置、授权统计 | 不建立 Room 也能更新；在线/告警/驾驶状态可同时表达 |
| 车辆实时详情 | 云端底盘/定位与历史趋势；显式点开视频才申请观看租约 | 状态与视频分别退化，速度/档位/位置显示真实来源和年龄 |
| 诊断 | Monitor/SystemStatus、主机指标、主题频率与时间 | 未采集指标显示未知，不沿用硬编码正常值 |
| 工作台 | DataChannel 指令/反馈、按需视频、控制会话 | 支持实际相机能力；保留签名与 watchdog，来源校验和清理完整 |
| 告警 | 车端关键转换事件、服务端规则与持久处理流 | 去重、确认、恢复滞回；故障恢复不等于人工关闭，断网不视为恢复 |
| 任务 | MissionRequest/Result/RuntimeStatus，云端调度及协调 | Mission 为公共任务权威，超时为结果未知，幂等查询协调而非盲目重发 |
| 历史/回放 | 降采样遥测、事件、任务和后续录像索引 | 有缺口标记和时间基准；不默认无人观看时持续录像 |
| 档案 | 软件/地图/标定版本、相机和车辆能力 | 决定页面可展示能力，缺失能力不虚构 |

地图投影、源时间同步和任务实际能力是实施前置验证项。
Mission proto 声明不等于车端实现或当前可执行；首期任务只读，再按 capabilities 与授权开放操作。

### 5.3 拟新增或修订接口

以下是计划契约，不是已有可用 API：

| 接口 | 用途 |
| --- | --- |
| `POST /api/vehicles/{id}/state` | 常在线最新状态上报 |
| `POST /api/vehicles/{id}/events` | 事件上传与确认 |
| `GET /api/vehicles` | 授权目录和摘要 |
| `GET /api/vehicles/{id}/state` | 带 revision 的快照 |
| `GET /api/fleet/stream` | 授权增量订阅，缺口重取快照 |
| `POST /api/vehicles/{id}/video/acquire` | 修订为独立观看租约，支持幂等 |
| `POST /api/video/{viewing_session_id}/renew` | 新增续租，校验所有者 |
| `POST /api/video/{viewing_session_id}/release` | 修订为本人观看租约幂等释放 |
| `GET /api/vehicles/{id}/rtc-demand` | Edge 查询有期限的聚合 RTC 需求 |

不复用 `/api/telemetry` 承载业务状态，也不让浏览器读取 Redis。
观看接口响应形状变化需新旧兼容策略，不能直接让旧入口把车辆级 session ID 当新观看句柄。
流式读取沿用内存 token 和授权头；不把 token 放进 URL 以迁就原生 EventSource。

## 6. 实施计划与依赖

| 阶段 | 工作与目标位置 | 依赖 | 验收门槛 |
| --- | --- | --- | --- |
| P0 契约及关键风险验证 | 框架/模块/目录；`api/schemas/`、Edge/Cyber 适配、地图时钟、观看/占用/交接契约 | 无 | 多车身份、占用权威、坐标时间、实例化 sender 及释放确认边界明确 |
| P1 常在线最小真实闭环 | Edge 最新缓存及 HTTPS 上报；Gateway 最新状态/目录/订阅；frontend 数据层及详情 | P0 | 无 Room 时仍更新速度/档位/模式/位置；源中断正确显示过期 |
| P2 观看租约与需求协调 | Gateway viewer store/API、控制租约联动、TTL/原子更新、需求接口、占用摘要 | P0 | 多人/多车/并发/失联/回滚不泄漏需求，不跨车辆访问；可与 P1 独立推进 |
| P3 Edge 按需 RTC 与视频 | `vehicle_node`/transport/publisher 协调器、OFF 状态、资源清理、需求轮询 | P1、P2 | 无需求零视频媒体流量；启停与失败恢复不影响独立遥测 |
| P4 平台监看与驾驶反馈迁移 | 多车 Room registry、观看续租、占用展示、实例身份、控制仲裁/释放栅栏/切换状态机 | P1、P3 | 多车只读先验收；单车控制释放确认后验证 A -> B，未知结果不得切换驾驶 |
| P5 模块契约与 mock | 诊断/告警/任务/回放契约与页面拆分、统一 mock provider | P1、P4 | 模拟数据同解析器、固定场景、显式标识、禁止真实指令 |
| P6 业务模块实接及部署验收 | 持久存储、真实健康/事件/Mission/历史、Compose 配置与运维说明 | P5 | 按模块替换 mock，核对授权、保留策略、恢复与流量证据 |

P1/P2 逻辑独立，不要求多代理或并行修改同一文件。P4 的“监看完成”和“允许远程控制”是两个单独门槛。
首批建议交付 P0、P1、P2，再完成 P3 的无人零视频验证；不以补齐所有视觉页面阻塞真实闭环。

## 7. 验证与验收计划

以下是完整方案的验收要求；首期代码检查不能替代媒体、驾驶交接或部署验收。

### 7.1 必测行为

- 不创建任何观看/控制租约：车辆遥测持续更新，无 RTC Room 连接、相机采集任务或视频发布。
- 只打开车队地图/车辆状态页：不产生观看租约，不触发视频。
- 首个 viewer acquire：车端被 HTTPS 需求唤醒，进入 Room，发布配置相机及 `vehicle.state`。
- 两个 viewer：关闭一个继续推流；最后一个退出，且无 controller，经过配置宽限期后关闭。
- 重复 acquire/release、并发续租/释放、浏览器崩溃、TTL 到期均不残留错误计数。
- 观看到期但控制有效：不中断视频；控制过期但有 viewer：保持只读视频。
- 控制申请中 token 失败、进房失败或用户取消：回滚/回收控制和媒体需求；无残留控制引用。
- OFF 状态 Gateway 不可达：不启动 RTC；ACTIVE 超过最后确认需求期限：先关闭控制输入/执行既有失效处理，再清理媒体。
- RTC 断开、相机打开失败、单轨道失败、采集阻塞、停止后迟到响应不破坏遥测或创建重复 publisher。
- shutdown 必须 unpublish、终止/等待采集任务、释放本 Agent 资源并退出 Room；核对底层阻塞采集的可取消性。
- 数据重复、乱序、旧流、源时间不推进、NaN、缺失字段分别得到明确质量状态。
- 摄像头与 RTC 状态未就绪、反馈过期、租约失效均不能进入驾驶就绪；重连不自动发旧动作。
- 独立遥测、RTC 和接口返回值不泄露设备凭据、token、控制私钥。
- 多车状态/轨道/指令隔离、跨标签页控制互斥、占用摘要未知、A 释放未确认及 B 竞争失败，
  按框架文档的多车场景验收；不得将 HTTP release 成功当作车端确认。

### 7.2 流量与时延证据

在相同相机配置、运行时长和网络条件下，分别记录 OFF、单 viewer、双 viewer、宽限期、控制会话的：

- 车端视频发送字节/码率、RTC 连接状态、发布轨道数。
- 自有采集/编码任务与设备句柄、CPU/GPU 占用。
- 独立遥测发送量、更新间隔、丢失与数据年龄。
- acquire 到首帧/首个有效状态的时间，以及最后需求失效到媒体关闭的时间。

OFF 验收是视频媒体发送为零且媒体资源已释放，不是“总网卡流量为零”。
多 viewer 测量必须区分车端上行与 SFU 下行，不能按观看人数直接推断车端流量倍增。
不提前承诺节省百分比；按实测确定轮询、租约、宽限期及启动超时参数。

### 7.3 实施时使用的现有命令

| 范围 | 命令 | 条件 |
| --- | --- | --- |
| Gateway | `cd apps/teleop-gateway && go test ./...` | 租约、API、需求协调或遥测接口变更 |
| Vehicle Edge | `pytest apps/vehicle-edge/tests` | 生命周期/状态/协议变更，先执行相应测试文件 |
| C++ Edge | `ctest --test-dir apps/vehicle-edge-cpp/build --output-on-failure` | 先按该目录 README 完成独立 CMake 构建 |
| C++ Cyber | `env -u LD_LIBRARY_PATH bazelisk test --test_env=LD_LIBRARY_PATH= //:telemetry_test //:media_test //:cyber_adapter_test` | 在托管容器内的 C++ 模块目录执行 |
| frontend | `cd frontend && npm test` | 契约解析、新鲜度和 API 行为 |
| frontend | `cd frontend && npm run typecheck` | 数据层、页面与会话变更 |
| frontend | `cd frontend && npm run build` | 前端集成完成 |

前端已建立最小 `node:test` runner；现有数据层测试不能替代后续 Room/驾驶会话行为测试。
原生 Cyber 验证使用目标车端的托管开发环境与隔离测试 topic，不在宿主直接构建 Apollo，也不连接真实执行器。
部署联调使用受控模拟器或经人工批准的测试台架，不能以真实行驶车辆作为首次验证环境。

## 8. Mock 边界

- mock 实现统一状态/业务接口，不在每个组件内复制车辆数组和状态规则。
- 固定时间轴和种子，覆盖正常行驶/停车/倒车、部分自动、定位失效、视频失败、重连、乱序和地图切换。
- 媒体需求模拟覆盖 OFF/STARTING/ACTIVE/GRACE/STOPPING/ERROR、多 viewer、续租失败和控制租约到期。
- 告警模拟覆盖发生/恢复与人工处理两条状态线；任务模拟覆盖接受、拒绝、结果未知、恢复和终态。
- 实时、模拟、历史来源显式隔离；mock 模式禁止真实控制/任务请求，不能用模拟数据满足驾驶就绪条件。

## 9. 参考机制与待确认参数

- [LiveKit Data packets](https://docs.livekit.io/transport/data/packets/)：reliable 是会话内尽力交付，不是断线消息存储；采用序号、新鲜度和业务结果持久化。
- [Foxglove FrameTransform](https://docs.foxglove.dev/docs/sdk/schemas/frame-transform)：借鉴显式时间戳和坐标系契约，不引入整套平台。
- `apollo-lite/pkgs/wheelos_msgs/wheelos_msgs/chassis_msgs/chassis.proto`
- `apollo-lite/pkgs/wheelos_msgs/wheelos_msgs/localization_msgs/{localization,pose,localization_status}.proto`
- `apollo-lite/pkgs/wheelos_msgs/wheelos_msgs/monitor_msgs/system_status.proto`
- `apollo-lite/pkgs/wheelos_msgs/wheelos_msgs/mission_msgs/{mission_request,mission_request_result,mission_runtime_status}.proto`

地图投影、实际消息发布频率、时钟同步状态、相机所有权、首帧时限、宽限期和租约参数在 P0/受控联调确认。
这些参数不改变已确认的双链路和按有效需求启停原则；若无法安全回收媒体或保证控制失效处理，应阻止后续控制开放，而不是退回无期限常开。
