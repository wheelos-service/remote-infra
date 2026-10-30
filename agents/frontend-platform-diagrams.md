# 自动驾驶运营平台架构与模块图

日期：2026-10-30

状态：目标设计图，不代表端到端验收；服务端租约和单操作者栅栏已实现，车辆物理交接仍须独立批准和验证。

技术选型：Go 服务端、React/TypeScript 客户端、C++17/Cyber 车端后台。
下列 Edge 媒体已有原生 SDK/合成相机闭环，真实相机和控制模块仍为后续门槛。
已落地独立遥测、观看租约、多车只读面板及有界 SQLite 业务记录；
原生媒体和各阶段实际进度见实施计划，不将目标图视为验收证据。

### SDK + Cyber 数据通路（本轮细化）

```mermaid
flowchart LR
    Cyber["Cyber readers<br/>Chassis / Localization / Mission / Monitor"]
    Adapter["薄 protobuf adapter"]
    State["公共 State SDK<br/>最新缓存 / 单位 / 时间 / 缺失"]
    Data["Data SDK<br/>HTTPS 业务上报"]
    Auth["Auth SDK<br/>设备 OAuth / token 刷新"]
    Gateway["Go Gateway<br/>ACL / 最新值 / 业务持久化"]
    Demand["Teleop SDK<br/>需求/token / generation / worker"]
    Gst["camera_gst<br/>共享采集 / 硬编"]
    Encoded["可选 camera_gst adapter<br/>GstSample / 有界 AU 入口"]
    IPC["Teleop 编码 IPC<br/>128 KiB / 序号 / PTS / IDR gate"]
    Media["LiveKit worker<br/>EncodedVideoSource 已实现"]
    SFU["LiveKit SFU"]
    UI["操作员工作台<br/>多车观察 / 唯一目标 / 最多一车控制"]
    Cyber --> Adapter --> State --> Data --> Gateway
    Auth -.-> Data
    Auth -.-> Demand
    Gateway -->|"设备自查媒体需求"| Demand
    Demand -->|"媒体授权 gate；不启停共享相机"| Encoded
    Gst -.->|"h264parse 后、RTP 前的 AU"| Encoded
    Encoded --> IPC --> Media --> SFU --> UI
    Media -->|"关键帧 / 码率 / 帧率反馈"| IPC --> Encoded
    Encoded -.->|"驱动接线 / 硬件反馈待验收"| Gst
    State -->|"v2 只读反馈"| Media
    Auth -.-> Media
    UI -->|"业务查询 / 观看租约"| Gateway
    UI -.->|"控制：另需原生执行与交接验收"| SFU
```

编码视频 adapter、IPC 和 LiveKit 编码源已实现，并用离线 H.264 AU 验证实际 RTC 解码；
不代表已挂接 Apollo 的真实 camera_gst 分支。共享相机的采集不能因无人远程观看而停止。
纯远程驾驶只安装 Auth + Teleop，公共状态/配置/HTTP 随 Auth 包交付；
Data SDK 是可选运营扩展，不在 Teleop 的依赖链中。交付方案见
[双 SDK 计划](../.agents/teleop-sdk-plan.md)。

设计依据：[框架、模块与目录](frontend-platform-architecture.md)、
[数据接入与实施计划](frontend-data-integration-plan.md)。

图中模块是逻辑边界，Gateway 首期保持单体。Mermaid 可在 GitHub Markdown 中渲染。
总体图箭头表示主要数据方向；模块图箭头表示调用/依赖方向，虚线表示反馈或跨边界同步。

## 1. 总体架构与双链路

```mermaid
flowchart TB
    subgraph Browser["frontend 统一平台"]
        Business["车队 / 车辆详情<br/>诊断 / 告警 / 任务 / 历史"]
        Workspace["多车只读监看<br/>单车驾驶焦点"]
    end

    subgraph Cloud["云端"]
        Auth["身份认证与车辆 ACL"]
        subgraph Gateway["Go Gateway 单体"]
            Data["遥测接入与车队读模型<br/>资产目录 / 状态订阅"]
            Sessions["观看租约与控制仲裁<br/>占用摘要 / 释放确认"]
            Demand["媒体需求协调<br/>有效租约聚合"]
            Services["业务模块<br/>告警 / 任务 / 历史索引"]
        end
        Redis[("持久化 Redis<br/>最新状态 / 租约 / 交接栅栏")]
        DB[("SQLite：单 Gateway<br/>有界业务记录")]
        RTC["LiveKit SFU<br/>每车独立 Room"]
    end

    subgraph VehicleA["车辆 A：独立身份与运行实例"]
        CyberA["Apollo / WheelOS<br/>Chassis / Localization / Monitor / Mission"]
        StateA["Edge A<br/>标准化状态与最新缓存"]
        UploadA["常在线遥测 / 事件"]
        SessionA["需求与控制会话同步"]
        MediaA["按需 RTC / 相机发布"]
        ControlA["签名验证 / 会话校验<br/>既有控制防护"]
        ActuationA["既有车辆控制接入<br/>执行结果需独立反馈"]
    end
    OtherEdges["车辆 B ... N<br/>同样的独立 Edge / Cyber / Room"]

    Auth -.-> Data
    Auth -.-> Sessions
    Business -->|"REST 查询 / 授权流订阅"| Data
    Business -->|"业务查询与操作"| Services
    Workspace -->|"观看与控制申请 / 续租 / 释放"| Sessions
    Sessions --> Demand
    Sessions -->|"占用变化"| Data
    Data <--> Redis
    Sessions <--> Redis
    Services <--> DB
    Data --> Services
    CyberA --> StateA
    StateA --> UploadA
    UploadA -->|"HTTPS：无人观看仍上报"| Data
    SessionA -->|"HTTPS：查询需求与控制版本"| Demand
    SessionA -->|"HTTPS：同步授权 / 撤销确认"| Sessions
    Demand -.->|"有期限的媒体需求"| SessionA
    SessionA --> MediaA
    SessionA --> ControlA
    StateA -->|"vehicle.state"| MediaA
    MediaA -->|"视频 + DataChannel 状态"| RTC
    RTC -->|"视频 + 实时状态反馈"| Workspace
    Workspace -->|"DataChannel 签名指令<br/>仅当前驾驶车辆"| RTC
    RTC -->|"vehicle.control"| ControlA
    ControlA --> ActuationA
    OtherEdges -->|"独立遥测"| Data
    OtherEdges <-->|"独立 RTC 会话"| RTC
```

**边界：**常在线遥测不依赖 RTC；驾驶指令不经过业务遥测接口；无人观看且无控制需求时关闭 RTC 和视频。
Mission 任务业务下发属于独立业务通道，不能借用驾驶 DataChannel；其详细接口在任务模块阶段细化。

## 2. 前端模块与多车资源所有权

```mermaid
flowchart TB
    subgraph App["app/"]
        Shell["PlatformLayout / routes<br/>AuthProvider / 导航保护"]
    end
    subgraph Pages["pages/"]
        Fleet["FleetPage / VehiclePage"]
        TeleopPage["TeleopWorkbench"]
        BizPages["AlertsPage / TasksPage / 历史"]
    end
    subgraph Features["features/"]
        Vehicles["vehicles/<br/>目录 / 能力 / 遥测 / 控制占用读模型"]
        BizFeatures["alerts/ tasks/ history/<br/>业务服务与页面状态"]
        subgraph Teleop["teleop/：唯一驾驶上下文"]
            Switch["switch-machine<br/>A 释放后再申请 B"]
            Coordinator["control-coordinator<br/>控制租约 / 就绪门控"]
            Sender["secure-control-sender<br/>单一发送器 / 会话密钥"]
        end
        subgraph Monitoring["monitoring/：每车独立实例"]
            Registry["room-registry<br/>资源预算 / 引用管理"]
            RoomA["vehicle-room A<br/>观看租约 / 轨道 / RTC 状态"]
            RoomB["vehicle-room B ... N<br/>各自观看租约与 generation"]
        end
    end
    subgraph Lib["lib/"]
        Contracts["contracts/<br/>类型 / 运行时校验 / 版本适配"]
        API["api/client + stream<br/>授权请求 / 游标 / 重新同步"]
        SDK["LiveKit SDK<br/>每车 Room 实例"]
    end

    Shell --> Fleet
    Shell --> TeleopPage
    Shell --> BizPages
    Fleet --> Vehicles
    BizPages --> BizFeatures
    TeleopPage --> Vehicles
    TeleopPage --> Switch
    TeleopPage --> Registry
    Switch --> Coordinator
    Coordinator --> Sender
    Coordinator --> Registry
    Registry --> RoomA
    Registry --> RoomB
    Sender -->|"只绑定当前驾驶 Room"| Registry
    Vehicles --> API
    BizFeatures --> API
    Coordinator --> API
    RoomA --> API
    RoomB --> API
    RoomA --> SDK
    RoomB --> SDK
    Vehicles --> Contracts
    Coordinator --> Contracts
    RoomA --> Contracts
    RoomB --> Contracts
```

**资源归属：**读模型按 `vehicle_id` 存储；每车连接按 `vehicle_id + generation` 隔离。
Room、sender、私钥由生命周期服务持有，不写入持久化 store。多车可看，驾驶焦点唯一。

## 3. Gateway 模块与权威事实

```mermaid
flowchart TB
    Routes["app.go<br/>组装依赖 / 路由"]
    Access["oidc_auth / vehicle_acl / vehicle_identity<br/>操作员与设备身份 / 权限过滤"]

    subgraph ReadSide["目录与读模型"]
        Registry["vehicle_registry<br/>登记车辆 / 能力 / 实例代次"]
        State["vehicle_state<br/>遥测校验 / 最新状态 / 源质量"]
        Query["fleet_query / fleet_stream<br/>授权快照 / 增量 / 控制占用摘要"]
    end

    subgraph SessionAuthority["会话权威"]
        Video["video_session<br/>每个观看者的独立租约"]
        Control["control_lease / control_session<br/>车辆互斥 / 操作者约束提案"]
        Handover["control_handover<br/>RELEASING / revision / 应用确认"]
        Demand["rtc_demand<br/>有效观看或控制需求聚合"]
        Tokens["livekit_token<br/>每车 / 每连接身份 / 最小权限"]
    end

    Audit["audit<br/>结构化操作与结果"]
    Redis[("Redis<br/>状态 / 活动租约 / 原子仲裁")]
    Durable[("持久记录<br/>交接恢复 / 业务数据")]
    EdgeSync["设备 HTTPS 同步接口<br/>当前实例校验"]

    Routes --> Access
    Access --> Registry
    Access --> State
    Access --> Query
    Access --> Video
    Access --> Control
    Access --> EdgeSync
    State --> Registry
    State --> Redis
    Query --> Registry
    Query --> Redis
    Video --> Redis
    Control --> Redis
    Control --> Handover
    Handover --> Durable
    Control --> Tokens
    Video --> Tokens
    Demand --> Video
    Demand --> Control
    EdgeSync --> Demand
    EdgeSync --> Handover
    Video -.->|"观看变化"| Query
    Control -.->|"占用变化"| Query
    Handover -.->|"交接结果"| Query
    Control --> Audit
    Video --> Audit
    Handover --> Audit
```

**权威区别：**租约决定谁有授权；Edge 反馈决定是否应用撤销；车辆状态和交接条件决定能否完成交接。
普通车队列表仅接收授权摘要，不读取完整控制会话或密钥材料。

## 4. Edge 模块与独立任务

```mermaid
flowchart TB
    Node["main.cc<br/>单车实例 / 任务组装 / 关闭顺序"]
    Credentials["config.cc / http_client.cc<br/>设备身份与凭据刷新"]

    subgraph DataPath["只读采集与双链路状态"]
        Cyber["cyber_adapter.cc<br/>原生消息接入"]
        Normalize["cyber_adapter / state_cache<br/>字段存在性 / 单位 / 质量 / 时间"]
        Cache["state_cache.cc<br/>各主题最新值 / 独立时间"]
        Telemetry["http_client.cc<br/>常在线 / latest-wins / 有界背压"]
        Events["后续 event_uploader.cc<br/>关键转换 / 持久队列 / 确认去重"]
        Publisher["后续 RTC 状态适配<br/>vehicle.state 快照"]
    end

    subgraph SessionPath["授权与按需生命周期"]
        Demand["后续 rtc_demand_client.cc<br/>独立 HTTPS 轮询 / 有效期"]
        Sync["后续 control_session_sync.cc<br/>授权 / 撤销 revision / 应用确认"]
        Coordinator["后续 rtc_coordinator.cc<br/>串行启停 / generation / 清理"]
        Transport["后续 livekit_transport.cc<br/>单车至多一个 RTC 连接"]
        Video["后续 video_publisher.cc<br/>OFF / 采集 / 编码 / 发布"]
        Camera["后续相机适配<br/>仅管理自有相机资源"]
        Receiver["后续 control_session_receiver.cc<br/>签名 / sender / session / 时效校验"]
        Runtime["后续既有控制防护迁移<br/>watchdog / 执行接入"]
    end

    Gateway["Gateway HTTPS"]
    LiveKit["LiveKit：本车 Room"]

    Node --> Credentials
    Node --> Cyber
    Node --> Telemetry
    Node --> Events
    Node --> Demand
    Node --> Sync
    Node --> Coordinator
    Cyber --> Normalize
    Normalize --> Cache
    Cache --> Telemetry
    Cache --> Events
    Cache --> Publisher
    Telemetry --> Gateway
    Events --> Gateway
    Demand --> Gateway
    Sync --> Gateway
    Demand --> Coordinator
    Sync --> Receiver
    Receiver --> Runtime
    Runtime -.->|"应用撤销证据"| Sync
    Runtime -.->|"发布状态，不等于执行确认"| Publisher
    Coordinator --> Transport
    Coordinator --> Video
    Coordinator --> Publisher
    Video --> Camera
    Video --> Transport
    Publisher --> Transport
    Transport <--> LiveKit
    Transport -->|"vehicle.control"| Receiver
    Transport -.->|"断线 / 失效通知"| Runtime
```

**故障隔离：**遥测与 RTC 独立背压；视频失败不阻塞状态上报；RTC 重连不恢复旧驾驶动作。
OFF 关闭采集、编码、发布和 RTC，但业务遥测与需求同步继续运行。

## 5. 按需 RTC / 视频生命周期

```mermaid
stateDiagram-v2
    [*] --> OFF
    OFF --> STARTING: 出现有效观看或控制需求
    STARTING --> ACTIVE: RTC 与已配置媒体就绪
    STARTING --> ERROR: 启动失败
    STARTING --> STOPPING: 需求取消或过期
    ACTIVE --> GRACE: 最后一个有效需求消失
    ACTIVE --> ERROR: RTC 或媒体故障
    GRACE --> ACTIVE: 新的有效需求
    GRACE --> STOPPING: 宽限期结束
    GRACE --> ERROR: RTC 或媒体故障
    ERROR --> STARTING: 需求有效且有界退避完成
    ERROR --> STOPPING: 无有效需求
    STOPPING --> OFF: 清理完成
    STOPPING --> ERROR: 清理失败并显式报告
    note right of OFF
        无 RTC 和视频媒体任务
        HTTPS 遥测继续
    end note
    note right of ACTIVE
        媒体就绪不是驾驶授权
        控制另受租约和反馈门控
    end note
    note right of STOPPING
        已武装控制先执行既有失效处理
        清理后才允许新 generation 启动
    end note
```

发生清理错误时不得盲目再启动一组任务；先确认旧资源已回收，再允许重试。
宽限期仍可能发送视频，允许配置为零；房间存在与否不是有效需求。

## 6. A 车释放后切换到 B 车

```mermaid
sequenceDiagram
    actor Operator as 操作员
    participant UI as 工作台切换协调器
    participant GW as Gateway 控制仲裁
    participant EA as Edge A
    participant EB as Edge B

    Note over UI,EA: 当前仅控制 A；B 可以提前只读监看
    Operator->>UI: 请求从 A 切换到 B 并确认
    UI->>UI: 进入 RELEASING_A，关闭持续输入
    Note over UI,EA: 按既有已验证流程结束驾驶，不自动换挡或恢复自动驾驶
    UI->>GW: 幂等 release A
    GW->>GW: 保留交接占用，产生撤销 revision
    GW-->>UI: 正在释放，不等于车端完成
    EA->>GW: 独立 HTTPS 同步控制授权
    GW-->>EA: A 撤销 revision
    EA->>EA: 应用撤销，清理旧动作和会话
    EA->>GW: 当前实例的 applied_revision 与交接证据
    alt 撤销已应用且交接条件确认
        GW->>GW: 完成 A 释放，解除交接占用
        UI->>GW: 查询释放操作结果
        GW-->>UI: A 已完成释放
        UI->>UI: 销毁 A sender 和密钥，按选择保留只读
        UI-->>Operator: B 只读就绪，可独立申请控制
        Operator->>UI: 显式申请控制 B
        UI->>GW: acquire B，绑定客户端实例与新公钥
        alt B 可用且操作者无其他占用
            GW->>GW: 原子取得 B 控制授权
            GW-->>UI: B 会话与受限 token
            EB->>GW: 同步 B 当前控制授权
            GW-->>EB: 新授权与预期 sender identity
            UI->>UI: 重建 controller 连接并等待就绪
            Note over UI,EB: 视频、RTC 反馈、租约及车端条件都有效
            Operator->>UI: 显式开始操作 B
            Note over UI,EB: 指令经 LiveKit DataChannel，不延续 A 的输入
        else B 已被占用或仲裁失败
            GW-->>UI: 冲突或明确错误
            UI-->>Operator: 保持 B 只读，不恢复 A 控制
        end
    else A 确认缺失或交接条件未知
        GW-->>UI: 结果未确认，继续阻止新控制
        UI-->>Operator: 可观察和恢复协调，不允许驾驶 B
    end
```

该图表达的是拟增加的交接栅栏。当前 HTTP release 及 `vehicle.state` 不能直接提供完整确认；
具体车辆交接条件必须先定义并验证。异常恢复不能因租约 TTL 到期或 Gateway 重启被绕过。
