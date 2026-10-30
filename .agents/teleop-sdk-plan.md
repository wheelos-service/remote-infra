# 双 SDK 远程驾驶交付方案

## 目标与边界

在已有 Apollo/Cyber、camera_gst 和车辆适配的环境中，只新增安装 Auth SDK
与 Teleop SDK。运营数据 SDK 为可选项，不要求安装车队遥测、Mission、告警或历史模块。
“两个 SDK”是交付边界，不代表没有 libcurl、JsonCpp、LiveKit、Cyber 等运行依赖。
云端仍需认证、控制会话仲裁和 LiveKit；可以托管，不要求客户安装完整运营平台。

| 交付包 | 内容 | 不承担 |
| --- | --- | --- |
| Auth SDK | 设备身份、OAuth 获取/刷新/失效处理、受限 HTTPS；内部公共配置/状态类型 | 授予车辆控制权 |
| Teleop SDK | 会话/媒体、RTC 视频与状态、v2 签名验包/撤销/看门狗、模拟执行反馈与模拟交接 | 运营上传、实车执行器、安全策略或物理交接资格认证 |
| 可选 Data SDK | HTTPS 遥测、Monitor 健康/持久事件、SQLite Inbox/Outbox、类型化任务接收/查询 | 驾驶授权、相机资源所有权、实车运动和安全复位 |

现有库保留细粒度内部模块；对外提供独立 CMake package 和 CPack 组件包。
Teleop 和 Data SDK 各自只依赖 Auth SDK，不互相依赖。完整 VehicleEdgeSDK 保留聚合兼容入口。
每个网络任务独立持有鉴权客户端；不跨线程共享 curl/token，也不安装或记录真实凭据。

## 数据与资源通路

```text
camera_gst -> H.264 AU adapter -> 有界 IPC -> Teleop LiveKit worker -> 操作端
Cyber 状态 -> 车辆适配/状态缓存 -> Teleop DataChannel -> 操作端
操作端控制 -> DataChannel -> 会话校验 -> 车辆控制适配 -> 车辆自身安全控制
Auth SDK <-> 认证服务；Teleop SDK <-> 会话/需求服务
可选 Data SDK -> HTTPS 运营服务（不在远程驾驶关键链路）
```

camera_gst 已有 NVMM 回调及 H.264/RTP 分支，不发布 Cyber Image。
优先在 h264parse 后、RTP 打包前取得完整 H.264 access unit，
交给 LiveKit EncodedVideoSource；不能将 RTP 数据报当作编码帧。
必须验证字节格式、SPS/PPS、PTS、关键帧恢复和编码器反馈。
网络线程不能阻塞采集回调；队列有界，重连/丢帧后等待可解码关键帧。
结束远程发布只释放自己的流需求，不停止自动驾驶共享的采集。
保留隔离 worker 的有界取消，NVMM 指针不能直接跨进程传递。

观看、操作目标与控制权独立。控制仲裁保持服务端权威，并在车端再次校验；
同一操作员最多控制一辆车，A 撤销且交接确认后才能控制 B。
Room/token/视频存在均不代表驾驶授权；断网或凭证恢复不能自动恢复驾驶意图。
车辆安全退出条件及执行器行为需车辆负责人审核，不能由通用 SDK 猜测。

## 实施阶段

1. **本轮：独立交付和数据通路拆分。** 把需求/token API 从 TelemetryUploader
   移到 TeleopClient；媒体服务/worker 不再依赖运营上传模块。
   导出 Auth、Teleop、可选 Data 包；验证只解压前两个包即可独立构建消费者。
   保持现有 HTTP 协议和聚合构建行为，无车辆控制写入。
2. **软件已实现，真实相机待验收。** camera_gst GstSample 薄适配、有界帧 IPC、
   LiveKit 编码源和反馈已实现；离线 H.264 已通过实际 RTC 解码。
   尚需 Apollo 共享相机分支接线、所有权协调、批准的相机台架验证及 aarch64/Orin 资格确认。
   当前固定 LiveKit 二进制仅适用于已验证的 Linux x86_64。
3. **软件模拟闭环已实现，物理控制待验收。** v2 会话/实例绑定、签名/序号/
   新鲜度、撤销、看门狗、模拟执行反馈及模拟交接已实现并打通控制端；
   物理执行器与交接仍要求明确车辆接口、安全策略及批准台架。
4. **后续：交付验收。** 目标平台安装、升级/回滚、共享相机资源、多车切换、
   断网/重连/进程故障；发布支持矩阵与明确未支持项。

## 本轮验收

- 无 Data 包的 Auth + Teleop 安装目录可被独立 CMake 消费者发现、链接、运行。
- Teleop 需求/token 保持原有 OAuth/401/HTTP 语义，不接受异常状态或无效 token。
- 原有完整 SDK、portable 测试与实际 RTC 合成视频/状态/到期退出不回归。
- 未修改 Apollo 工程、未访问真实相机、未新增执行器指令或启用驾驶。

## 当前进展

阶段 1 已完成；阶段 2 已完成可离线验证的软件通路，驱动/硬件门槛未关闭；
阶段 3 的模拟软件验收已完成；阶段 4 的目标硬件门槛未关闭：

- `TeleopClient` 已迁出需求/token；媒体服务和 LiveKit worker 仅链接 teleop，
  不再链接 data/runtime。Bazel 与 CMake 分层一致。
- 已导出 `VehicleAuthSDK`、`VehicleTeleopSDK`、可选 `VehicleDataSDK`，
  保留完整 `VehicleEdgeSDK` 兼容入口；CPack 分别生成 auth/teleop/data TGZ。
- Auth + Teleop 两包在新目录解压后，独立消费者构建/运行通过，
  没有 data 头文件/静态库，也不导入运营 targets。
  含 LiveKit 的两包同样通过独立消费者及重定位后的 worker smoke。
- portable CTest 2/2、启用 LiveKit CTest 3/3、
  完整安装消费者 1/1、托管容器 native Bazel 测试 3/3 与可执行文件构建通过；
  实际 RTC 合成视频/v2 状态接收和需求到期退出通过。
- 已覆盖需求非 200、401 刷新、缺失/空/错误类型/换行 token 和非法 JSON 拒绝；
  修复多个独立 package 重复发现 JsonCpp 时旧版 CMake config 重复定义 target 的问题。
- 未修改 Apollo 工程；真实相机、实车控制执行、物理交接及 aarch64 仍未完成。

### 编码视频与目录整理

- 源码已按 `common/auth/teleop/data/adapters/{cyber,camera_gst}/workers/apps`
  分层；公共 include 与导出名称稳定。Cyber adapter 只依赖 state，不再间接依赖 Data。
- Teleop SDK 新增 `EncodedIngress` 与 `MediaService::SubmitEncodedFrame`：
  最多两帧、每 AU 最大 128 KiB；到达/IPC 超时、拥塞、非法输入和不连续后等待新 IDR。
  IDR 必须携带前置 SPS/PPS，输入契约为无 B 帧的 Annex B AU。
- 独立 descriptor 4 传递有界版本帧与反向反馈，descriptor 3 保持原授权期限/状态通路。
  MediaProcess 同时管理两通道的继承/关闭；SDK 阻塞仍隔离在可回收 worker。
- LiveKit worker 已支持显式 `h264_annexb`，通过官方 EncodedVideoSource
  发布，不进行额外解码/重编码；PTS 绑定本地单调时钟，缺帧恢复等待关键帧。
- 可选 `CameraGstAdapter` 消费 byte-stream/au GstSample、返回显式输入结果，
  提供关键帧事件和 NVENC bps 辅助接口；帧率目标返回相机所有者处理。
  不注册/覆盖现有回调，不拥有或启停共享采集；源码树中的 Apollo 驱动未修改。
- 既有 `vehicle_telemetry` 只组装只读数据，不自动接入相机；
  客户必须在拥有相机分支的组件中嵌入 adapter，不能仅修改配置就宣称真实视频已接通。

### 尚不能关闭的门槛

- camera_gst 当前没有可直接复用的编码 AU callback；需相机所有者添加独立 appsink
  分支和需求引用计数，不能把全局 StartStreaming/StopStreaming 当作独立租约。
- NVENC profile/SPS/PPS/关键帧与码率事件、相机源时间/延迟以及 Orin/aarch64
  需要批准的目标平台验证；本地离线测试不能代替。
- 控制阶段尚缺经确认的车辆控制接口和物理交接策略。保持无控制 writer、
  无控制自动恢复、无实车驾驶；不以通用 SDK 猜测安全退出/执行器行为。

### 本阶段验证记录

- `ctest --test-dir apps/vehicle-edge-cpp/build --output-on-failure`：
  LiveKit 构建 5/5 通过；portable 构建 4/4 通过（含新增 sdk_delivery）。
- `python3 apps/vehicle-edge-cpp/tests/livekit_e2e.py`：
  合成 RGBA 与离线 baseline H.264 均收到实际解码帧和 reliable v2 状态；
  编码反馈返回且停止续期后 worker 正常退出；错车快照在获取媒体凭证前拒绝。
  此命令额外需要 FFmpeg/libx264。
- 托管容器 `bazelisk test //:telemetry_test //:media_test //:cyber_adapter_test
  //:encoded_video_test //:camera_gst_test`：5/5 通过；
  `bazelisk build //:vehicle_telemetry` 通过。
- 托管容器 CMake `EDGE_ENABLE_GSTREAMER=ON`、LiveKit OFF：
  构建通过，进入构建目录执行 `ctest --output-on-failure`，5/5 通过。
  系统缺少的 JsonCpp 仅下载/解包到临时工作区，没有修改全局依赖。
  CMake 3.19 不支持 `ctest --test-dir`，不可将其“No tests were found”当作通过。
- Auth + Teleop TGZ 解压到新目录后的消费者、重定位 worker smoke、
  完整 SDK 安装消费者，以及含可选 GStreamer 的两组件安装消费者均通过。
  `deps(//:camera_gst) intersect set(//:data //:runtime)` 查询为空。
- 新增检查覆盖 AU/SPS/PPS/IDR、RTP 拒绝、错误 caps/PTS、
  双帧背压、迟到 IPC、异常反馈、会话代次与双 descriptor 继承/回收。
  临时 native 工作区、下载的依赖和自建 LiveKit 容器已清理。

### SDK 收敛：交付完成定义

当前可以验收的是 **Auth + Teleop 的媒体和模拟控制软件闭环**；
不能将模拟执行/交接称为实车执行或物理交接认证。

| 模块/门槛 | 状态 |
| --- | --- |
| Auth SDK、可选 Data SDK、独立包导出 | 软件基线已实现 |
| Teleop 按需视频、实时状态、H.264 输入/反馈 | Linux x86_64 软件通路已实现 |
| 安装后不依赖 Data 的最小消费者和示例 | 自动化验收已接入 CTest |
| camera_gst 实际分支挂接与相机资源引用计数 | 未完成，属于相机集成 |
| C++ 控制会话同步/撤销、签名验包、指令接收与反馈 | v2 模拟软件闭环已实现，实车 writer 未接入 |
| 物理交接、车辆安全退出、Orin/aarch64 运行时 | 未验收，不能启用实车 |

本次补齐：

- `MediaService::Stop()` 显式、终止式、幂等，串行化并发 Stop；
  先终止媒体、再等待网络任务退出，返回后状态 OFF、输入拒绝；
  destructor 继续兜底。worker 的 200ms 回收期限不等于整个 Stop 的 HTTP 等待时间。
- MediaProcess 禁止复制，避免 PID/fd 重复所有权；构造时拒绝空缓存、非法标识及
  启用媒体却缺少 worker/config/source 的调用，不以线程崩溃掩盖参数错误。
- 编码器反馈随会话清除，不继承旧 bitrate；显式上游丢帧可立即请求 IDR。
- OAuth/media token 与 API path 拒绝 NUL/空白/控制字符；仍保留 401 失效及显式错误。
- HTTP 初始化从“假设已有遥测 uploader 提前初始化”改为共享显式入口；
  MediaService 启动自身线程前初始化。旧 libcurl 的宿主程序须在 Cyber/GStreamer
  创建线程前调用 `InitializeHTTPTransport()`，不能依赖隐含 Data SDK 构造顺序。
- 媒体 worker 对照自身 device config 校验快照 vehicle_id，防止配置/状态错车混用。
- `examples/teleop` 是随 Teleop 包交付的独立 CMake 只读示例：
  使用真实 Auth + Teleop 链接、保护配置预检、明确 synthetic source、信号退出；
  不依赖 Data，不自动开启真实相机或驾驶。
- `tests/sdk_delivery.cmake` 在新目录打包/解包/链接消费者与随包示例；
  可选 GStreamer/LiveKit 配置均覆盖。独立媒体生命周期测试验证只请求需求接口、
  实际双 IPC、反馈、并发 Stop 和停止后输入拒绝。

### 控制端与 SDK v2 模拟闭环

- 使用新增 v2 协议，不修改旧 Python/v1 执行器映射。指令为整数归一化 per-mille，
  使用确定顺序的紧凑 JSON 数组作为 Ed25519 签名字节；
  schema 位于 `api/schemas/datachannel-control-v2.schema.json`。
- Gateway v2 acquire 绑定 client_instance_id 与独立 `control-<session_id>` RTC 身份。
  device-self context 在单条 Redis Lua 中读取 active lease、持久 fence revision、
  到期 TTL 与 pending 状态；不以媒体 generation 代替控制 revision。
- C++ `ControlReceiver` 校验 sender、vehicle/session/browser/receiver instance、
  revision、签名、递增序号、数据边界、墙钟窗口及单调 IPC 到达时间。
  每个接收实例生成独立随机 ID，重启不能重放上一进程的签名。
- 控制权本地最多 500ms，减去完整 HTTP RTT；100ms 轮询。
  接受指令后 300ms 看门狗；超时/撤销/网络/worker 故障清空模拟 setpoint 并锁定，
  同一会话续期不能自动重启。宿主 20ms 检查不是硬实时安全承诺。
- `ControlService` 由 MediaService 宿主持有，不随 RTC worker 一起退出。
  worker 有界 IPC 转交指令，反向可靠反馈包含接受序号、模拟结果和拒绝原因；
  不加载执行器适配器，不写 Cyber 控制指令。
- 模拟开关双重保护：设备 `control_mode=simulation`，Gateway
  `SIMULATED_CONTROL_VEHICLES_JSON` 明确列出的废弃/模拟车辆 ID。
  仅 v2 模拟会话允许 `simulation-ack`，保持物理 ACK 开关关闭。
- `frontend` 提供显式启用的模拟控制面板及独立生命周期：
  签名发令、续期、反馈校验、死手按钮、失焦/断线/超时停止、
  释放并等模拟交接后才能切换。观看租约继续独立。
- `python3 tests/control-chain.py` 使用真实 Gateway HTTP + Redis Lua 语义、
  前端实际 WebCrypto 签名模块、真实 LiveKit、生产 C++ 监督/IPC/接收器，
  完成验包/拒绝重放及篡改/看门狗/禁止自动恢复/仲裁/模拟交接/跨车切换验收。
  身份和执行端是测试替身，测试 worker 不随安装包交付。

下一步仅在批准的目标车辆环境定义并实现执行器适配、安全退出与物理交接策略，
完成 camera_gst 实际挂接及 Orin 平台资格确认；不把本地模拟结果当作实车通行证。

本轮验收记录：

- LiveKit CTest 6/6、portable CTest 5/5（均含实际两组件打包/安装后消费者）。
- `python3 tests/control-chain.py`：真实跨端模拟控制闭环通过。
- `python3 apps/vehicle-edge-cpp/tests/livekit_e2e.py`：错车拒绝、合成视频、
  离线 H.264、状态与媒体需求到期退出回归通过。
- `cd frontend && npm test`：45/45；`npm run build` 通过。
  `node scripts/control-test-signer.mjs --vector ../apps/vehicle-edge-cpp/build/control_receiver_test`
  验证前端真实签名字节和 C++ 公钥验证兼容。
- Gateway `go test ./...` 与控制 context/handover/HTTP 的针对性 race 通过。
- 托管容器 Bazel 6/6（新增 control_receiver_test）及 native Cyber executable 构建通过。
- `docker compose config --quiet`、`git diff --check` 通过；
  所有测试使用隔离身份与模拟执行，没有访问真实车辆或变更 Apollo 驱动。

### Data SDK：遥测、Monitor、持久任务

软件实现：

- `data_client` 负责严格 HTTPS 协议；`health_service` 只投影 Monitor 权威状态；
  `durable_store` 只负责单车私有 SQLite 事务、去重与容量；
  `task_service` 负责 Inbox/dispatch fence/未知状态及身份对账；
  `data_service` 组合独立网络所有者，不依赖 RTC/Teleop。
- 既有车速/档位/电量/定位 latest-wins 上传不变；静态 profile 独立于周期遥测，
  未知值不变成零，源时间/接收时间不混用。
- Monitor 保留各检查项和截断标记，逐接收样本本地持久化故障状态与 outbox；
  WARN/ERROR/FATAL 的 raised/changed/recovered 与云端人工确认分别存储。
  恢复需明确 OK 经过 2 秒迟滞，缺失/未知/过期/截断或超过 2.5 秒的观测间隔不计恢复。
- Gateway 新增 `/data` 独立读模型及严格 device-self 接口，既有 `/operations`
  契约不变；schema v1->v2 事务迁移。身份/ACL、重复字段、容量及冲突明确拒绝。
- 任务先云端落库，再设备 Inbox 落库（received），dispatch fence（reconciling）
  先于适配调用；超时为 unknown，重启只对账而非重发变更。
  report_sequence 严格连续，终态不可覆盖；原始 Mission 结果保留身份和 commit/retry/terminal 信息。
- 默认 tasks disabled；提供无执行器的模拟等待和只读 Mission query。
  query 校验实际公开契约 v1 与新鲜能力清单，匹配目标账本身份/查询错误身份，
  对应回调结果不被其它任务消息覆盖。实车 submit/cancel/replace/安全复位未启用。
- `:vehicle_data` 是独立 Cyber/Data 入口；`:vehicle_telemetry` 保留完整组合。
  Auth + Data 包经实际解压、消费者链接/运行验证，无 Teleop/LiveKit 依赖。
  单进程本地盘、私有目录、单车绑定；达到保留容量显式报错，不偷偷丢弃去重身份。

验证入口与责任边界：

- `bash tests/data-chain.sh`：真实 C++ SDK + Go HTTP/鉴权/ACL/SQLite，
  覆盖遥测/profile/Monitor、落库后 ACK 丢失的重试、任务分阶段报告与进程重启。
- CTest `data_test`：持久性、错车/双进程拒绝、容量原子性、过期/map 拒绝、
  缺失/过期/截断恢复保护及未知任务对账；`sdk_delivery` 增加 Auth + Data 安装验收。
- Native `cyber_adapter_test` 使用实际 WheelOS proto，`vehicle_data` /
  `vehicle_telemetry` 都需构建；SDK 成功查询不等于任务完成或运动许可。
- 保留容量的归档/轮换、实车任务执行/模式仲裁、实际 topic/地图验证与硬件验收仍需
  明确部署流程；不把只读/模拟测试称为实车执行验收。

本轮 Data 验收结果：

- `ctest --test-dir apps/vehicle-edge-cpp/build --output-on-failure`：7/7 通过。
- `ctest --test-dir apps/vehicle-edge-cpp/build/dual-portable --output-on-failure`：
  6/6 通过；两种构建均实际验证 Auth + Data 独立解包/消费者运行。
- `bash tests/data-chain.sh`：通过，覆盖落库后 ACK 丢失、重试与两次设备进程启动。
- Gateway `go test ./...`：通过；完整 Gateway race 及最后 Data/Operations 针对性
  race 均通过。后者命令为 `go test -race ./internal/gateway -run 'TestData|TestOperations' -count=1`。
- 托管原生环境 Bazel 6/6 通过；最后 query 能力/回调保护增补后
  `//:cyber_adapter_test` 再次通过，`//:vehicle_data` 和 `//:vehicle_telemetry` 构建通过。
  使用 `--override_module=wheelos_msgs=/apollo/pkgs/wheelos_msgs` 校验实际公开 proto；
  Data-only 依赖图不含 `:teleop`、`:telemetry`、`:camera_gst`。
- `clang-format --dry-run --Werror`、`bash -n tests/data-chain.sh`、
  `git diff --check` 通过。新的三个组件 TGZ 已生成到
  `apps/vehicle-edge-cpp/build/packages/`；没有安装真实设备凭据或访问真实执行器。

### 后续缺口实施：业务前端与数据运维首阶段

已实现：

- `frontend/src/lib/vehicle-data-api.ts` 定义严格 `/data` 契约；
  `use-vehicle-data.ts` 负责单车串行轮询、身份隔离、取消和新鲜度；
  `VehicleDataPanel.tsx` 负责 Monitor/告警/任务/容量 UI，不承担控制租约或 RTC 生命周期。
  车辆详情保留 `/operations` 遥测历史兼容读区，告警/任务页切换到 `/data`。
- Monitor 显示原始检查状态和紧急停车要求，未知/未来/过期/截断不推断健康或恢复；
  人工确认与设备 recovered 独立。服务端返回 `can_manage`，每次变更仍验证角色和车辆 ACL。
- 仅开放 `mission_query` 只读查询。202、received、reconciling、unknown 和终态分别显示；
  超时/断网不伪造失败，同载荷同身份重试，轮询确认落库后解除重试状态。
  用户可明确清除本地重试，但不会取消已落库任务；离开前保存待核实 ID。
- C++ `DurableStore::Statistics()` 提供 retained/pending outbox/inbox 与故障键计数，
  DataService 经独立于可靠 outbox 的 health HTTP owner 上传 `/data/diagnostics`。
  版本 1 信封字段为 `type=vehicle_data_diagnostics`、vehicle/stream/sequence/publication，
  `store` 包含 capacity/outbox_retained/outbox_pending/inbox_retained/inbox_pending/faults_retained。
- Gateway `/data` 返回设备诊断及云端保留/待处理/unknown/未确认量；80% 容量预警。
  `/data/records` 使用车辆 ACL、每页最多 100 条和固定插入上界；
  前端完成全部游标/身份验证才生成 NDJSON，不删除去重身份。
  逐页读取的人工确认/任务结果可能变化，不能把导出当成一致性备份。

本阶段证据：

- `cd frontend && npm test && npm run build`：52/52 及类型/生产构建通过；
  覆盖严格身份/状态、未知写入结果、响应体卡住的期限、完整有界导出和只读预览。
- Gateway `go test ./...` 与 `go test -race ./internal/gateway -run 'TestData' -count=1`
  通过；包含诊断身份/容量、导出分页/隔离/无删除及非法游标参数。
- LiveKit CTest 7/7、portable CTest 6/6 通过，包含 Auth + Data 独立安装消费者。
- `bash tests/data-chain.sh` 通过：实际 C++ OAuth/HTTP/SQLite → Gateway HTTP →
  前端严格解析/导出；覆盖丢失 ACK 和重启。
- 实际 WheelOS proto 下 Native `//:data_test`、`//:cyber_adapter_test` 2/2 通过，
  `//:vehicle_data` 和 `//:vehicle_telemetry` 构建通过。
  三个组件 TGZ 已更新；没有修改 Apollo checkout 或连接真实车辆。

仍未完成，不能以本阶段完成替代：

1. 实车任务 submit/cancel/suspend/resume/replace 与自动驾驶/遥控模式仲裁：
   需要经确认的执行/反馈/安全退出协议；当前仅 query/simulate_wait，单个未知任务仍会阻塞后续任务。
2. 实际 camera_gst 回调与资源所有权集成、Orin/aarch64、实际 topic/时钟/地图验证，
   执行器及物理交接台架证据；生产控制开关仍关闭。
3. 保留身份安全轮换/恢复演练、通知升级与检索工作流、地理投影/完整回放、
   共享数据库扩展及生产升级/回滚验收。当前提供诊断、导出与备份流程，不自动清库。

## cyber-apollo-base 合并落地

以 `afb6320` 保存当前 React/Go/C++ SDK 和运营数据基线，再合入
`origin/cyber-apollo-base` 的 `a996f89`。不替换 C++ 主实现，不引入 Python
到 SDK 安装包；不提交旧 `frontend/dist`。用户的 `docs/todo.md` 不在本次提交范围。

已落地：

- React 经纯状态机适配复用键盘、按住按钮、标准手柄（映射确认、LB 使能及回中）
  和前后视角选择；不引入旧 v1 sender。严格归一化输入转 v2 整数，
  拒绝非有限/越界/同时油门制动，挡位/模式不降级。
- 失焦/隐藏释放，卸载清理键鼠/手柄监听及定时器；单车控制锁覆盖 pending，
  目录暂失不卸载仍占有控制的面板。离开/登出提示覆盖模拟控制会话。
- 前后各三路、单前视兼容、手动覆盖、中心放大、真实解码帧过期提示；
  自动方向意图不会被旧挡位反转。目录挡位仅作新鲜性受限的辅助显示。
  仅挂接可见组，保留 adaptiveStream；不承诺隐藏画面即停止车端上行。
- Gateway token 两侧测试均保留。旧 v1 控制台遇 `202 PENDING` 或丢失释放响应
  显式阻止再次获取控制，不把 middleware 写成功当物理 ACK。
  Python 启动示例改为 loopback/只监看，无远端测试身份或默认 Cyber 控制写入。
- 当前架构及旧参考边界同步至前端、SDK、Python/旧控制台和架构/测试文档。

验证（软件模拟；不是实车验收）：

- `cd frontend && npm test`：56/56；`npm run build`：类型检查和生产构建通过。
- `cd apps/operator-console && npm test`：69/69，使用现有 frontend TypeScript
  工具链；含 pending/丢失释放响应与监听器卸载回归。
- Gateway `go test ./...` 及
  `go test -race ./internal/gateway -run "TestControl|TestVehicleToken|TestViewing" -count=1`
  在 `golang:1.24` 容器通过。
- `PYTHONPATH=apps/vehicle-edge/src <隔离环境>/bin/python -m pytest -q apps/vehicle-edge/tests`：
  76 通过、26 subtests 通过、1 native Cyber 用例跳过；缺 OpenCV 后仅在隔离环境安装。
- `ctest --test-dir apps/vehicle-edge-cpp/build --output-on-failure`：7/7 通过，
  含包独立交付；前端 WebCrypto 到 C++ Ed25519 向量通过。
- `python3 tests/control-chain.py`：实际 Gateway/LiveKit/C++ IPC 链路通过，
  包括共享输入转换的前进/转向、倒车、停止、重放/篡改拒绝、看门狗、
  模拟权威交接和单车切换。首次运行遇反馈超时，补充最后反馈诊断并使篡改包
  时间戳在发送时保持新鲜，随后链路通过；未放宽命令/看门狗时限。
- `bash tests/data-chain.sh`：实际 C++ diagnostics/health/events/tasks ->
  Gateway HTTP -> 前端严格解析/导出回归通过。
- shell 语法、C++ clang-format、Git whitespace/conflict 检查通过。

未改变前述生产门槛：v1 无当前交接确认、Python 无当前观看需求调度，
C++ 不因本次合并自动具备真实六相机来源、挡位/模式仲裁或物理控制资格。
`CONTROL_HANDOVER_ACK_ENABLED=false` 和默认关闭的模拟车辆白名单保持不变。
未部署、推送或连接实车。
