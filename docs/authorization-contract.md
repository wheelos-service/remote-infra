# Gateway 授权契约与迁移矩阵

> **状态区分**：本文“当前”描述现有 Gateway 路由及处理器行为；“目标”是待实现的授权契约，不表示 Casbin、PostgreSQL 或 Casdoor 已通过集成验证。目标总体原则和实施阶段见[认证与授权建设方案](authentication-plan.md)。

## Managed 试点增量

本文下列旧行为/迁移矩阵以默认 **static 模式**为基准，不能用于解释新模式的授权。
显式选择 managed 后，可信 `(issuer, sub)` 通过 PostgreSQL 绑定到内部主体，
Gateway 从成员及 Casbin 固定模板解析业务角色和车辆范围；JWT 角色不能直接
成为业务管理/控制权。两种授权源不能混用，数据库错误不能回退旧 ACL。

试点仅提供认证后的 `/api/admin/context`、组织内 people/vehicles 列表与登记、
assignments 分配；首次平台引导使用受保护的 `auth-admin`，不是 HTTP 注册接口。
身份创建绑定限制为平台运维，组织管理员不能任意认领既有主体。
有效可信组织成员（包括已有成员和未分配角色者）由现有 Casbin 引擎统一获得
本组织全部有效车辆的 `vehicle.read`、`camera.live.view` 和安全的 `task.read`
基线，自动涵盖新增车辆；用户、组织、成员或车辆失效及跨组织请求仍拒绝。
此语义明确取代旧 `none` 不可读行为，不批量改写已有策略或范围。
`none/selected/all` 是操作车辆范围，而非读取范围；`org_admin` 和 `viewer`
均不获得模拟控制或任务执行权限，查看者即使 all 也不能控制。
`remote_operator` 仅在显式操作范围内申请白名单 v2 模拟控制，Lease/Fencing 仍独立强制。
完整目标 action、自动邀请和生产在线撤销仍不是试点承诺。

所有管理写入使用维护/全局排空前置条件，不把已写入策略等同于在线会话撤销；
真实操作及诊断边界见[管理试点说明](auth-management.md)。该增量不改变下面
static 模式的兼容迁移要求，也不代表全量目标已经实现。

## 1. 范围与裁决顺序

授权不能由一项 claim、一个角色或一次登录单独决定。目标请求顺序为：

1. 验证受信任 issuer、签名、audience、有效期及 Access Token 契约。
2. 解析 `(issuer, sub)` 到内部 `user_id`，或解析独立机器主体到已绑定的 `vehicle_id`；身份类型不可由路径、请求体或组织 claim 决定。
3. 确认主体、成员/车辆及组织处于有效状态，并解析本次资源的权威组织。
4. 检查 API 委托 Scope，然后以明确的 action、resource、domain 和车辆范围执行 Gateway PEP / Casbin 决策。
5. 控制操作还须由 Redis Control Lease 原子裁决；设备继续校验控制上下文、revision、签名、序号、期限和本地安全条件。

任何依赖错误、策略版本过期或资源归属不确定均默认拒绝。成功登录、Scope、房间令牌或 Casbin allow 都不能代替后续层级。

## 2. 当前身份和授权边界

当前生产 OIDC 验证器校验配置 issuer、audience、JWKS 签名、有效期、subject 和非空 Scope；它将 `sub` 放入 `UserClaims.Name`，把 `tenant` / `organization` claim 合并为 `Organization`，并把 Scope 映射为旧角色。Gateway 没有保留独立 issuer 字段，也没有以业务数据库查找成员、车辆归属或角色；Casdoor 的组织 claim 不是 WheelOS 组织事实来源。

旧的 `canControl` 接受 `controller`、`supervisor`、`operator`、`admin`；`canObserve` 接受 `observer` 或任一可控制角色。静态车辆 ACL 以 subject、vehicle_id 和可选 tenant_id 匹配；`control` 同时满足 `observe`。tenant_id 为空的 ACL 不约束组织。车辆身份映射以 subject 为键；映射未配置时存在旧 subject/vehicle_id 回退路径。以上均是兼容行为，不是目标权限模型。

截至本文核对的路由，管理 API 尚未提供人员邀请、成员绑定、组织/车辆注册或角色范围分配。不能把管理界面或 Casdoor 账号创建成功视为业务成员或已授权车辆。

### 2.1 已注册业务路由矩阵

下表中“目标 action/resource”是**设计名称**，不是已实现 Casbin action。路径及“当前检查”按 Gateway 路由/处理器核对；表中没有省略可执行的 API 路由。

| 当前路由 | 当前身份 / 检查 | 目标 action 与 resource/domain |
| --- | --- | --- |
| `GET /api/auth/me` | Bearer；返回旧 `UserClaims`（Name、Roles、Scopes、Organization） | `identity.self.read`；仅当前主体可读自身业务身份、成员和绑定状态；未绑定仅可进入受控邀请绑定流程 |
| `/api/token/operator` | Bearer；`access=observer/controller` 与旧角色、对应车辆 ACL；签发 LiveKit 操作员房间令牌 | `camera.live.view`（observe）或 `control.data.publish`（controller）作用于经解析的车辆；令牌只用于传输，不授予成员、资源或 Lease 权限 |
| `/api/token/vehicle` | Bearer；旧 vehicle role / `teleop:vehicle`、subject 映射及兼容回退，允许请求 `vid` 时比对 | `vehicle.room.connect`；机器主体必须唯一绑定一辆车并与目标车一致；只允许该车所需的发布/订阅能力 |
| `GET /api/vehicles/{vehicle_id}/device-auth-check` | Bearer；只允许解析到路径所指车辆的机器身份且该车辆已注册时返回 `204`；拒绝其他身份时不泄露所请求车辆是否存在 | `vehicle.identity.check`；仅用于已绑定机器主体自检本车身份和注册状态，不返回凭据或扩大业务授权 |
| `GET /api/vehicles` | Bearer；旧 observe role；逐车应用静态 ACL 后组装结果（当前无分页） | `vehicle.list` + 每车 `vehicle.state.read`；先按成员、组织及车辆范围过滤，再分页、排序、计数和聚合 |
| `GET /api/vehicles/{vehicle_id}/state`、`GET /api/vehicles/{vehicle_id}/operations`、`GET /api/vehicles/{vehicle_id}/data` | Bearer；旧 observe role + 该车 observe ACL；查车辆注册表 / OperationsStore | `vehicle.state.read`、`vehicle.operations.read`、`vehicle.data.read`；资源先解析所属 org，再执行成员、角色、范围检查 |
| `POST /api/vehicles/{vehicle_id}/state` | Bearer；vehicle subject 必须匹配路径和 payload；车辆须已注册 | `vehicle.telemetry.write`；仅被绑定的机器主体写自身车资源 |
| `POST /api/vehicles/{vehicle_id}/control/acquire` | Bearer；旧 control-capable role + control ACL；之后申请 Redis Lease | 人员 `remote_control.request` + 指定车辆范围；再由 Lease 决定控制互斥。org_admin 默认没有该 action |
| `GET /api/vehicles/{vehicle_id}/control` | Bearer；车辆自身或有 observe 角色及该车 observe ACL | `control.session.read`；车辆仅读自身；人员按车辆 observe 范围读取 |
| `POST /api/control/{session_id}/renew`、`POST /api/control/{session_id}/release` | Bearer；会话查找后要求 operator subject、tenant 与当前 claims 相符，并检查 control role/ACL；release 启动交接而非确认物理交接 | `control.lease.renew` / `control.lease.release`；session 必须绑定创建者、vehicle、org 和授权版本。撤销后的 release 仅保留受限安全收尾路径，不可续租或创建新 Lease |
| `GET /api/vehicles/{vehicle_id}/control/context`、`GET /api/vehicles/{vehicle_id}/control/handover` | Bearer；车辆自身；handover GET 也允许有 observe 角色及车辆 ACL 的人员 | `control.context.read` / `control.handover.read`；设备限本车，人员限已授权车辆 |
| `POST /api/vehicles/{vehicle_id}/control/simulation-ack`、`POST /api/vehicles/{vehicle_id}/control/handover/ack` | Bearer；车辆自身；模拟 ACK 还要求显式车辆白名单；原生 ACK 还要求部署开关，校验 session/revision/撤销字段 | `control.handover.ack`：仅绑定设备对本车、当前 pending session/revision 的确认；是安全收尾，不得据此获得新控制权限。原生确认仍需部署侧策略/台架验证 |
| `POST /api/vehicles/{vehicle_id}/video/acquire`、`GET /api/vehicles/{vehicle_id}/video`、`POST /api/video/{session_id}/release` | Bearer；acquire 要求 observe role + ACL；GET 对人员同样检查，但旧 vehicle role 可不经本车绑定检查；release 当前仅验证 Bearer 后按 session id 释放 | `camera.live.view`、`camera.session.read`、`camera.session.release`；设备读自身；人员需车辆范围。释放必须核验 session 所有者/车辆；仅凭已认证 token 不足 |
| `POST /api/vehicles/{vehicle_id}/viewing/acquire`、`POST /api/vehicles/{vehicle_id}/viewing/{viewing_session_id}/renew`、`POST /api/vehicles/{vehicle_id}/viewing/{viewing_session_id}/release` | Bearer；acquire/renew/release 要求 observe role + ACL，并以调用者 owner、vehicle_id 和 session_id 检查租约 | `camera.viewing.acquire/renew/release`；续租需当前授权，释放可保留仅限该会话所有者的最小安全收尾规则 |
| `GET /api/vehicles/{vehicle_id}/media-demand` | Bearer；仅匹配该车的车辆身份 | `vehicle.media_demand.read`；机器主体限本车 |
| `POST /api/vehicles/{vehicle_id}/data/health`、`.../data/profile`、`.../data/diagnostics`、`.../data/events`、`.../data/task-results`；`GET .../data/tasks/next` | Bearer；车辆 subject 映射必须匹配路径；写入要求注册车辆及严格数据契约 | `vehicle.health/profile/diagnostics/event/task_result.write`、`vehicle.task.read`；机器主体仅操作本车。诊断数据读取另由人员 `vehicle.diagnostics.read` 和车辆范围控制 |
| `GET /api/vehicles/{vehicle_id}/data/records` | Bearer；当前与 `/data` 读取共用 observe 检查 | `vehicle.records.read`；仅允许授权成员读取该组织/车辆的数据 |
| `POST /api/vehicles/{vehicle_id}/data/tasks` | Bearer；旧 control role + control ACL；当前只接受 query 或显式白名单模拟任务，不执行物理 mutation | `vehicle.task.create`，按独立任务权限及车辆范围；不得从旧 control 隐式导入维护、驾驶执行或任意任务能力 |
| `POST /api/vehicles/{vehicle_id}/data/events/{event_id}/acknowledge` | Bearer；旧 control role + control ACL | `vehicle.event.acknowledge`；明确授予的组织内车辆 action，不应以泛化“控制”权限替代 |
| `POST /api/vehicles/{vehicle_id}/mission-status` | Bearer；车辆身份必须匹配路径，车辆已注册 | `vehicle.mission_status.write`；设备仅可报告本车状态 |
| `POST /api/telemetry`、`POST /api/audit/events` | Bearer；旧 vehicle role；telemetry payload vehicle_id 必须等于 claims.Name；audit 事件限白名单 | `vehicle.telemetry_metric.write`、`vehicle.safety_audit.write`；基于绑定机器身份和本车资源；不允许客户端指定其他车辆或组织 |

资源分辨规则（目标）：

- 人员的 domain 来自本次显式组织上下文及权威成员记录。校验成员有效后，单车 `vehicle_id` 必须从业务注册表解析真实 `org_id`；请求中的 org 只能作为上下文并需相等，不得覆盖资源归属。
- 组织级 action（邀请、成员管理、车辆登记）使用明确的组织资源；不得伪造 `vehicle_id`。首次平台管理员/平台引导权限与普通组织域分离。
- 车辆的 `(issuer, sub)` / client 身份绑定到一个不可变 `vehicle_id`；请求路径、payload、绑定和资源归属必须一致。机器身份不使用人员角色或组织管理员权限。
- session / operation ID 先查其权威记录，再校验绑定的 subject、车辆、组织和生命周期；不允许仅凭猜中 ID 操作。
- 列表在数据查询层执行组织及车辆范围过滤，之后才分页、计数、排序或聚合。现有内存列表虽在返回前过滤，但不是数据库级、分页安全契约。

### 2.2 非业务路由与明确的匿名入口

| 路由 | 当前边界 | 目标边界 |
| --- | --- | --- |
| `GET /healthz`、`GET /readyz` | 无 Bearer；readiness 检查 Redis 与运营存储并返回依赖状态 | 编排探针，不授予业务数据访问；由部署网络限制外部可达性，响应不泄露连接信息 |
| `/metrics` | 无 Bearer；Prometheus handler | 运维端点而非租户 API；部署侧只向监控网络开放，避免公开业务标签/指标 |
| `/api/webhook/livekit` | 无 Gateway Bearer；校验 LiveKit webhook 签名 | 仅接受配置 LiveKit 密钥验证的 webhook；不能因为路径公开而跳过签名 |
| CORS `OPTIONS` | 允许配置来源的预检，不执行业务 handler；CORS 不是授权机制 | 保持预检与资源授权分离；实际业务请求仍必须认证并授权 |

因此，所有表列出的业务 API 当前都有 Bearer 中间件；公开探针、metrics、签名 webhook 和预检有意走不同边界，不能将“全路径都需用户 Bearer”当成契约。部署仍须限制探针和 metrics 的网络暴露。新管理 API 必须认证、校验平台/组织管理员可管理的 domain，并使用同一 PEP；目前没有任何匿名注册、邀请接受后自动授予、或首个登录者成为管理员的入口。

当前需在迁移中显式封堵的兼容边界：

1. `/api/video/{session_id}/release` 当前处理器未验证 session 所有者或车辆授权；目标必须补充对象级检查。不得把单纯 Bearer 校验记录为资源授权。
2. `GET /api/vehicles/{vehicle_id}/video` 当前对带旧 vehicle role 的 token 不要求其绑定车辆等于路径车辆；目标必须强制设备身份与路径相等。
3. 旧 ACL 的空 `tenant_id` 不限制组织；迁移前需为每条授权解析并确认 org，不能将其解释为跨组织通配。
4. 当前组织和角色主要来自 token/静态 ACL，没有业务资源归属查验。切换数据库前必须先建立权威资源映射和默认拒绝；不能只把现有 ACL 包装成 Casbin allow。
5. `/api/vehicles` 当前没有分页；未来加入分页时必须先过滤权限范围，以免 count、页边界或聚合泄漏范围外车辆。

## 3. 人员邀请、车辆接入与权限分配（目标）

期望管理员体验是一次平台初始化后，日常仅“邀请人员、登记车辆、分配角色与范围”。底层仍要分别完成身份绑定、成员生效、机器凭据安全交付、自检和策略提交；任一步失败都不能显示“已授权”。

### 3.1 生命周期状态契约

每个生命周期有持久、可诊断的阶段状态；状态变化审计 actor、domain、resource、action、结果、时间、策略版本和 `request_id`。状态字段不可含密码、access/refresh token、client secret、私钥或签名材料。

| 对象 | 建议状态序列 | 只有何时算可用 |
| --- | --- | --- |
| 人员邀请 | `pending` → `accepted` → `identity_bound` → `member_active`；旁路终态/恢复态：`expired`、`revoked`、`conflict`、`failed` | Casdoor 登录主体以可信 `(issuer, sub)` 绑定；被邀请组织成员明确激活。仅创建账号或接受邀请不自动授予组织权限 |
| 车辆接入 | `registered` → `provisioning_pending` → `provisioning_running` → `credential_delivery_pending` → `installed` → `identity_verified` → `ready`；异常：`result_unknown`、`retryable_failed`、`disabled`、`revoking` | 外部 subject 已核验并唯一绑定该车；凭据经受控交付安装；车辆认证自检通过。发放成功响应不代表安装或数据通道就绪 |
| 权限分配 | `requested` → `validated` → `committed` → `effective`；异常：`rejected`、`sync_pending`、`stale`、`failed` | 有效成员、组织内有效车辆和允许授予边界均通过检查，策略与授权版本已持久化且 Gateway 已确认读取相同版本 |
| 撤销/转移 | `requested` → `committed` → `revocation_pending` → `sessions_cleared` / `device_ack_pending` → `complete`；异常：`retrying`、`timed_out`、`failed` | HTTP 新请求不再获准、有效会话按策略清退、必要安全交接完成；这三类完成状态分别报告，不以删除 Redis 栅栏替代设备确认 |

异步操作须有持久稳定的 `operation_id`。同一业务操作的查询、轮询、重试和恢复沿用它；每次 HTTP 往返都有独立 `request_id`，用于日志和错误响应关联。二者不可互换：不能用 request_id 充当跨重试幂等键，也不能因新的 request_id 创建重复邀请或车辆客户端。对外状态至少给出 `operation_id`、资源 ID、stage、state、稳定 `error_code`（有错时）、`retryable`、`updated_at` 和必要的安全收敛标志；重试必须是服务端定义的幂等阶段动作。

车辆发放遇 Casdoor 超时等未知结果先对账，不盲目重复创建；secret 只交付一次并保存在受控密钥存储，业务表仅存引用。任何普通状态、日志、审计或诊断响应都不得返回 secret 或 token。

### 3.2 诊断读取权限与内容

- 人员可查看自己的登录/绑定/邀请阶段和可加入组织，不得通过诊断查询他人身份或跨组织详情。
- `org_admin` 只看本组织邀请、成员、车辆和授权操作状态；看不到 secret、原始 Token、其他组织是否存在或其主体细节。
- 平台运维权限可查看跨组织的最少必要阶段、依赖错误类别和 operation 状态；敏感配置只呈现是否配置、版本/更新时间及 secret 引用状态，不显示值。
- 车辆机器身份仅可查询自身接入、自检、控制 handover 必要状态；不能读取成员名单、策略详情或其他车辆诊断。
- 诊断响应允许返回稳定错误码、粗粒度阶段、是否可重试、脱敏依赖类别和 `request_id` / `operation_id`；不得回显 JWT、OAuth 响应体、client secret、私钥、JWKS 内容、管理凭据、内部堆栈、连接串或跨租户存在性。
- 车辆健康/网络/媒体/相机/Cyber/控制诊断是不同健康维度。认证通过不得标记“视频就绪”或“可驾驶”；车端物理控制仍需现有 Lease、revision 和安全确认契约。

## 4. 旧 Scope / 角色迁移矩阵

旧 Scope 是 API 委托信号和角色推导输入；新 action 是业务授权名。迁移工具必须显式选择一个旧来源，提供 dry-run、逐条解释和人工确认，不合并授权文件与旧 JSON，也不在运行时以旧配置覆盖数据库。

| 旧值 / 当前语义 | 候选目标 | 必须保留的兼容性与限制 |
| --- | --- | --- |
| `teleop:observe` → `observer`；可查看车辆列表、状态、操作数据、视频和观测协调 API | 按已实现 API 最小映射至 `vehicle.state.read`、`vehicle.operations.read`、`camera.live.view` 等独立 action | 不能因角色名相似自动授予所有诊断/运营数据；组织成员与 vehicle scope 都须重新验证 |
| `teleop:control` → `controller`；旧 `control` ACL 同时允许 observe | 仅在明确审批的车辆范围授予 `remote_control.request`，同时保留其旧 observe 能力的显式 action | control→observe 的旧隐含语义要显式展开；不得导入成员管理、维护执行、通用任务或所有车辆许可 |
| `teleop:supervise` → `supervisor`，当前也被 `canControl` 接受 | 必须逐主体核定是否拆分成只读监督、控制请求或其他已存在 action | 不把“supervise”名称自动解释成 `org_admin`，也不因旧角色一次性获得组织管理权 |
| JWT `role=controller` / `operator` / `supervisor` | 候选 `remote_operator` 的明确车辆范围及逐 action 映射 | 仅适用于有效人员绑定；每项旧资源 ACL 转为该组织内 all/selected 范围，不扩大范围 |
| JWT `role=observer` | 候选 `viewer` 的车辆只读/视频 action | 不能获得控制、成员管理、任务写入或告警确认 |
| JWT `role=admin` 当前可通过 `canControl` 控制 | 必须人工确认具体控制权及车辆范围；组织管理权需另行授予并验证管理边界 | **绝不自动迁移为 `org_admin`**；也不因旧字符串 `admin` 自动保留全局控制 |
| `teleop:vehicle` / `role=vehicle` | 车辆机器身份及有限设备 API 类别 Scope | 先核实 issuer、subject、client_id 与单车绑定；不得映射到任何人员角色。subject!=client_id 不可假定 |
| token `tenant` / `organization`、ACL `tenant_id` | 业务组织外键与成员/资源归属 | 只能辅助迁移核对，不是组织事实来源；空 tenant ACL 必须人工指定 domain，否则拒绝迁移 |

若旧授权无法无损表达，迁移结果标记为需确认/拒绝，而不是为了“成功导入”扩大许可。新规则先影子比对，差异由负责人处理；撤销状态不能在回滚时复活。

## 5. 错误、关联 ID 与审计

稳定错误码是 API 合约；响应文本、Go 错误字符串和内部依赖细节不是。401 表示缺少/无效身份，403 表示业务拒绝（或按隐私策略使用 404 隐藏资源），409 表示 Lease/状态冲突，503 表示已识别关键依赖或策略不可用。客户端只根据稳定 code 决策，不解析人类可读文本。

### 当前已实现边界

- 生产服务请求使用服务端生成的 `X-Request-ID`，不信任来访的同名 header。认证、device-check 和 vehicle-token 错误返回 `X-Error-Code`；请求 `Accept: application/json` 时响应 `{error, code, request_id}`，默认仍为旧文本响应。
- 当前错误码包括：`AUTH_BEARER_REQUIRED`、`AUTH_INVALID_TOKEN`、`AUTH_SERVICE_UNAVAILABLE`、`VEHICLE_REGISTRY_UNAVAILABLE`、`VEHICLE_IDENTITY_MISMATCH`、`VEHICLE_NOT_REGISTERED`、`VEHICLE_IDENTITY_REQUIRED`、`VEHICLE_IDENTITY_UNBOUND`、`VEHICLE_IDENTITY_SERVICE_UNAVAILABLE`、`MEDIA_TOKEN_ISSUANCE_FAILED`、`METHOD_NOT_ALLOWED`。
- `/api/auth/me` 的成功响应保持旧格式并设置 `no-store`；JSON 业务审计事件可从服务端上下文获取 `request_id`。
- 认证拒绝会以 `gateway_authentication_rejected` 事件按 `request_id` 记录脱敏原因类别：token 格式、签名密钥/JWKS 请求或获取/HTTP/解析错误、签名或 claims 校验失败、issuer、audience、时间、缺少 subject 或 Scope。客户端仍只得到通用 `AUTH_INVALID_TOKEN`，不暴露拒绝细节。
- 仅获授权的运维人员可在服务端日志中按 `request_id` 关联该诊断事件。事件不得记录原始 token、claims、请求 URL 或 IdP/provider 错误文本；不得将这些内部诊断字段返回给普通 API 客户端。

上述错误码和 JSON envelope 目前只覆盖认证/设备诊断等已接入边界，不代表所有业务错误已统一为 JSON，也不代表已有管理员生命周期诊断、持久策略版本或异步 `operation_id` 状态。

### 目标全局错误码（建议；不是当前实现）

| 类别 | 推荐 code 示例 | 建议处理 |
| --- | --- | --- |
| 认证/主体 | `AUTH_REQUIRED`、`AUTH_INVALID`、`AUTH_UNAVAILABLE`、`SUBJECT_UNBOUND`、`SUBJECT_DISABLED` | 401 或受控邀请状态；不回显令牌和 subject 查找细节 |
| 组织/资源 | `ORG_CONTEXT_REQUIRED`、`MEMBERSHIP_INACTIVE`、`RESOURCE_NOT_FOUND`、`RESOURCE_SCOPE_DENIED` | 403/404；不泄露其他租户存在性 |
| 策略 | `POLICY_DENIED`、`POLICY_UNAVAILABLE`、`POLICY_STALE`、`GRANT_OUT_OF_BOUNDS` | 默认拒绝；区分普通无权限和策略依赖故障 |
| 邀请/发放 | `INVITATION_EXPIRED`、`INVITATION_CONFLICT`、`PROVISIONING_PENDING`、`PROVISIONING_RESULT_UNKNOWN`、`CREDENTIAL_DELIVERY_PENDING`、`DEVICE_NOT_VERIFIED` | 返回 operation 状态和是否可重试；未知外部结果先对账 |
| 控制/收尾 | `CONTROL_CONFLICT`、`CONTROL_HANDOVER_PENDING`、`SAFETY_ACK_PENDING` | 409 或 accepted/pending；不得以一般授权失败阻断严格限定的安全释放/设备 ACK |
| 依赖/请求 | `DEPENDENCY_UNAVAILABLE`、`VALIDATION_FAILED`、`METHOD_NOT_ALLOWED` | 503 / 400 / 405；响应只含稳定 code、request_id 和安全文本 |

全局建议响应 envelope：`{ "error": "<safe message>", "code": "<stable code>", "request_id": "<server id>" }`；异步操作响应另外携带 `operation_id` 和生命周期状态。`request_id` 用于单个请求跨层日志；`operation_id` 跨多次请求关联业务过程。拒绝响应、日志和审计不得含 Bearer Token、Cookie、secret、完整 OAuth body 或未脱敏的跨租户资源信息。授权审计应记录 actor 类型/内部 ID、org、resource、action、决策、授权版本、request_id、operation_id（适用时）及结果；不记录凭据。

## 6. 目标角色和 action 分配边界

角色是 Gateway 管理的固定业务能力集合；组织管理员只能在被授权的管理范围内分配固定角色和 `all` / `selected` 车辆范围，不能改 Model、直授任意 action、创建角色继承、自我提权或管理平台角色。

| 目标角色 | 默认目标能力 | 明确不隐含 |
| --- | --- | --- |
| `org_admin` | 本组织邀请、成员生命周期、车辆登记/禁用、授权分配及管理所需查询 | 控制、跨组织人员禁用、secret 明文读取 |
| `remote_operator` | 指定车辆状态/视频读取；按明确控制资格请求 Lease | 成员/车辆管理、凭据发放、未批准任务/物理维护执行 |
| `viewer` | 指定车辆只读状态、操作/诊断（按最小 action）、视频 | 控制、任务创建、告警确认、管理 |
| `maintainer` | 授权车辆健康、诊断和显式开放的维护 action | 控制、成员/车辆管理、未定义维护操作 |
| `dispatcher` | 已实现且单独定义的车辆/任务读取或调度 action | 默认控制资格、尚未实现的调度/执行接口 |

`org_admin` 不是旧 JWT `admin` 的别名。P0/P1 仍需用实际选择的 Go Casbin + PostgreSQL Adapter 验证 domain 隔离、角色与车辆范围 AND 关系、事务/错误行为和默认拒绝；不能仅凭模型草图宣称通过。

## 7. 验收门槛和并行集成依赖

以下是实现目标契约的验收清单；本文档本身未运行测试，也不代表门槛已满足。

1. 未认证、过期/错误 issuer/audience、缺少 Scope、未知 subject 对所有业务路由均默认拒绝；已明确的匿名探针、签名 webhook、CORS 预检与业务 API 分别按 §2.2 验证。
2. 用户跨组织调用、伪造 org 上下文、selected 范围越权、空 tenant 旧 ACL 和无绑定/禁用主体均拒绝；同一人多组织角色隔离。
3. 车辆 token 不能冒用另一 vehicle_id；GET/POST、路径/body、LiveKit 房间和设备绑定均使用同一权威车辆身份。
4. `/api/video/{session_id}/release` 有所有者/资源检查；旧 vehicle role 不能读取其他车视频状态；所有 session ID 端点先查绑定对象。
5. 列表过滤先于分页、count、aggregate；未知策略版本、Adapter 错误、数据库中断和多实例陈旧策略均 fail closed。
6. viewer 和 org_admin 不能申请控制；`remote_operator` 也必须有车辆范围且通过 Lease；control→observe 兼容和安全释放/设备确认分别测试。
7. 待接受邀请、待绑定身份、外部 provisioning 结果未知、待交付/安装、策略待同步、撤销未收敛均显示准确状态，不能显示接入/授权完成。
8. request_id 在每个请求唯一且由服务端生成；operation_id 跨异步重试稳定；审计和诊断不泄密、不跨租户。
9. 角色/Scope 导入 dry-run 覆盖 observe、control 隐含 observe、supervise、vehicle、admin、空 tenant ACL；不自动将旧 admin 升级为 org_admin 或扩大车辆范围。回滚不得恢复已撤销权限或控制栅栏。
10. LiveKit participant/旧 token 的撤销与重连语义、Redis Lease 并发撤销和设备 ACK 必须在实际部署组合中验收；权限撤销、媒体关闭、车辆确认是不同完成条件。

与本契约并行的 Casbin/PostgreSQL 包、C++ JSON 诊断和 Gateway 请求诊断仍需集成验证。本次文档不读取其他工作者的新实现，也不声称这些组件已经组合工作。尤其 P0 的外部 Casdoor issuer/audience/Scope、真实机器主体 claim、Management API 最小权限、邀请/客户端创建/轮换/吊销能力及 LiveKit 撤销行为，必须在目标部署的隔离环境和实际版本核实；没有测试记录前只保留受控人工 provisioning 过渡，不能说“Casdoor/Go Adapter 已测试”或“全自动 onboarding 已完成”。

## Lifecycle mutation contracts

The [account lifecycle contract](account-lifecycle.md#lifecycle-apis) defines the
new scoped lifecycle routes, expected-version and idempotency rules, cancellation
and provider-revocation states. Removal must not restore prior selected grants on
rejoin. Revoked bindings remain denied across provider failure and restart.

The implementation and disposable acceptance evidence dated 2026-11-05 are recorded in [plan.md](../plan.md#implementation-evidence), including replacement rotation, platform-only transfer, authenticated observation, and the real RTC drain interval. Earlier planning/validation caveats in this document are historical; production rollout still requires the documented maintenance and pilot procedure.
