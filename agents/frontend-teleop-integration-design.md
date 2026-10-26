# 运维平台统一入口与远程接管迁移设计

日期：2026-10-26  
状态：设计提案，未实施业务代码迁移  
目标入口：`frontend/`  
现有能力来源：`apps/operator-console/`

## 1. 目标与范围

`frontend/` 定位为整个运维平台的统一入口，而不是独立的远程驾驶页面。平台保留车队总览、车辆监控、接管工作台、告警事件、任务管理等信息架构，第一阶段只将已有远程接管能力接入真实链路。

本期交付：

- 平台级登录、身份展示和退出。
- 在平台内选择或输入真实车辆 ID，明确选择监看或控制模式。
- LiveKit 单路/多路视频、连接和断开、中央画面放大。
- 控制权申请、续租、释放，Ed25519 签名指令，高层/底层控制模式。
- 连接、权限、控制冲突、视频缺失和会话失效的真实状态反馈。
- 接管期间的导航保护、输入结束处理和资源回收。
- 可复现的构建、静态部署及旧入口回退路径。

本期不实现：

- 车队资产与在线状态服务、真实地图、车辆定位和完整遥测 HUD。
- 多车同时接管、多车实时监看、调度任务、告警闭环、录像与回放。
- 方向盘/手柄、键盘驾驶、自动驾驶模式切换、目标速度设置。
- 修改车辆控制协议、重做 Gateway 身份认证、车辆执行器或安全认证。
- 将原型直接用于真实车辆生产控制；远程紧停不等于独立的物理急停。

“平台保留功能入口”不代表这些模块已经接入后端。真实工作区与演示内容必须有明确边界。

## 2. 现状调研

### 2.1 `frontend/`：平台视觉与信息架构原型

| 区域 | 当前实现 | 迁移含义 |
|---|---|---|
| 技术栈 | React 18、TypeScript、Tailwind、Radix/shadcn 风格组件、esbuild | 沿用现有技术栈，不引入 Next.js/Vite 等另一套框架 |
| 应用入口 | `src/main.tsx` 挂载 `App`；`App.tsx` 使用 `HashRouter`，只有 `/` 路由 | 可增量增加接管路由，不要求静态服务器支持 history fallback |
| 平台布局 | `Home.tsx` 内包含侧栏、顶栏和五个功能区 | 先提取必要的应用外壳，避免重写全部页面 |
| 导航 | `activeSection` 控制条件渲染，车辆选择也是局部状态 | 当前不能通过独立 URL 恢复具体车辆工作台 |
| 车队/车辆监控 | 硬编码 `AV-*` 车辆、静态地图、相机图片、车辆状态 | 不能作为真实车辆目录或在线状态来源 |
| 接管工作台 | `TeleopWorkbench.tsx` 是仅监看的静态图片与 HUD，支持 CSS 全屏遮罩 | 可以复用视觉布局，不能复用其“已连接”判断 |
| 其他驾驶原型 | `Home.tsx` 仍定义 `RemoteDrive`、`RemoteControlPanel`、`RemoteDrivingCanvas` | 当前接管入口实际渲染 `TeleopWorkbench`，不能误将旧演示按钮当成真实控制功能 |
| 告警/任务 | 本地示例数组、筛选和展示，任务表单未接调度服务 | 本期保留为标记清晰的演示或未开放入口 |
| 身份与网络 | 顶栏 operator、时间、网络良好等为固定展示 | 必须改为认证状态；无数据不能显示“正常” |
| 构建 | `node scripts/build.mjs --production`，输出 `dist/` | 只打包、不执行 TypeScript 类型检查 |

具体问题：

1. `Home.tsx:207-212` 向 `TeleopWorkbench` 传入未在 props 中声明的 `debugMode`；实施时应删除无效传参或按真实需求定义接口，不能用宽泛类型掩盖。
2. `TeleopWorkbench` 根据 `gear` 切换的是前/后示例图片；现有真实相机协议不是“档位驱动切图”。
3. 当前 `networkQuality={4}`、`gear="D"` 以及“链路已连接”“LIVE”等展示不代表真实连接或车辆反馈。
4. `index.html` 标题仍为 `Web Creator`，并无条件包含 `/esbuild` 热更新连接；生产构建应去掉开发专用连接。
5. `frontend/package.json` 未声明 `typescript` 开发依赖，也没有类型检查或测试脚本；存在 `tsconfig.json` 并不代表类型检查已接入构建。
6. `FileDescription.txt` 提及的 `App.jsx`、`index.js`、`npm start` 与实际源码/脚本不一致；部署和开发命令应以源码为准。

依据：`frontend/package.json`、`frontend/scripts/build.mjs`、`frontend/src/App.tsx`、`frontend/src/pages/Home.tsx`、`frontend/src/pages/TeleopWorkbench.tsx`、`frontend/index.html`。

### 2.2 `apps/operator-console/`：待迁移的真实能力

现有页面不是 React 应用：`public/index.html` 内使用模块脚本和全局事件函数，另有两个 TypeScript 模块。

| 已有能力 | 来源 | 处理方式 |
|---|---|---|
| OIDC Authorization Code + PKCE、state 校验、身份查询 | `public/index.html` | 提取为平台认证服务和 AuthProvider |
| 手动输入车辆、连接/断开、observer/controller 模式 | `public/index.html` | 改为 React 表单与工作台状态 |
| LiveKit Room、轨道订阅/取消订阅、15 秒连接超时 | `public/index.html` | 封装为可销毁的单车连接服务 |
| Ed25519 密钥、申请/续租/释放、序号与签名 | `src/lib/secure-control-sender.ts` | 沿用协议与签名规则，补充类型和失败通知 |
| 按相机名称映射、单/多路布局、中央画面聚焦 | `src/lib/video-grid.ts` | 保留映射语义，移除全局 DOM 查询，改为组件 ref 生命周期 |
| 高层前进/后退/左转/右转/停止/紧停 | `public/index.html` | 保持动作语义和按住发送方式 |
| 底层转向与紧急制动 | `public/index.html` | 保留已有功能；不新增未经定义的车辆控制能力 |

迁移不能只是复制 HTML 或用 iframe 嵌入：平台需要统一身份、车辆上下文、导航保护和资源生命周期。

旧实现中需要随迁移一并处理的耦合问题：

- `SecureControlSender.acquireSession()` 的类型未描述 Gateway 实际返回的 `token` 和完整会话字段。
- 续租失败仅写 console，不能驱动界面立即退出可控制状态。
- 按住指令通过 100 ms 定时器发送；只依赖元素 `mouseup` 不足以覆盖指针离开、窗口失焦和页面隐藏。
- 异步签名和发布不能由定时器无限重叠，应限制待发送任务，避免旧动作积压。
- 全局单例变量与 DOM ID 不适合在 React 路由切换、卸载、并发连接时直接使用。
- 登出必须等待或明确处置会话释放，并断开 Room，不能只清空认证变量。
- 既有 CDN SDK 未锁定为项目依赖；新入口应通过包管理器引入并锁定兼容版本。

这些是迁移正确性的必要工作，不扩大为全仓库重构。

### 2.3 后端与车端边界

Gateway 已有认证、车辆 ACL、控制租约和 LiveKit token 接口。浏览器不持有 LiveKit 管理密钥，也不直接调用 Redis。

现有 Gateway **没有**车队列表、车辆档案、车辆位置/速度/电量查询、告警列表或任务调度接口。`POST /api/telemetry` 是车端上报链路，不是浏览器读取 HUD 的接口。不得据此设计一个已经存在的实时数据源。

视频会话方面，Gateway 已有 viewer acquire/release 和 ACTIVE/STANDBY 状态；但当前 `vehicle_node.py` 连接后启动视频发布，`video_publisher.py` 使用 ACTIVE profile，没有将 Gateway 视频会话状态轮询接入编码档位切换。因此“按需启停/自动低码率”不是已经打通的端到端能力。

此外，当前 `VideoSessionStore` 使用车辆级共享 session ID 作为 viewer 索引，不是独立的每次观看句柄。不能直接将该接口当成支持可靠多 viewer 生命周期的成熟协议。本期不依赖它实现多车监看或带宽优化，后续需要单独确认/修订契约。

部署方面，当前构建脚本仍构建 `apps/operator-console/`；Compose 未定义平台前端服务，Caddy 仅代理 Gateway、RTC 和 Casdoor。迁移后的平台静态托管需要显式接入，不能认为把文件放进 `frontend/` 就会自动上线。

依据：`apps/teleop-gateway/internal/gateway/app.go:89-119`、`control_session_api.go`、`video_session_api.go`、`video_session.go`、`apps/vehicle-edge/src/vehicle_edge/vehicle_node.py`、`video_publisher.py`、`infra/scripts/build-frontend.sh`、`docker-compose.yml`、`infra/local-dev/Caddyfile`。

## 3. 推荐方案与取舍

推荐：**以 `frontend/` 为唯一平台入口，原生 React 接入远程接管；短期保留旧控制台作为人工回退入口。**

| 方案 | 评价 |
|---|---|
| iframe 嵌入旧页面 | 上手快，但身份、导航保护、布局、错误反馈和销毁存在两套边界，不采用 |
| 重写整个运维平台及全部后端 | 超出“先实现远程接管”的范围，不采用 |
| 保留平台壳，迁移现有协议与连接能力 | 改动可分阶段交付，职责清晰，采用 |

不为本期引入微前端、全局事件总线、大型状态框架或通用插件系统。已有 Zustand 依赖不构成必须使用的理由；认证用 Context，单车工作台用 reducer/hook 与服务实例即可。

## 4. 信息架构与用户流程

### 4.1 页面及路由

沿用 HashRouter，建议路由：

| URL 示例 | 用途 |
|---|---|
| `/#/` | 平台首页；未接入模块明确标记“演示/待接入” |
| `/#/teleop` | 远程接管入口：输入真实车辆 ID、选择访问模式 |
| `/#/teleop/car-001` | 对应车辆工作台，不自动申请控制权或发送指令 |

`car-001` 仅为示例，不能作为生产车辆默认值。路由中只包含车辆标识，不包含任何凭证。

本期无需为其他演示模块全部新增路由；只提取足够支持真实工作台的 Layout 和导航。已有其他页面可作为一个演示区域继续使用，不做全面组件拆分。

首次落地可以将平台首页设为入口说明和模块卡片，而非继续展示似真的车队统计。选择一个未接入模块时应明确展示状态，不触发真实业务操作。

### 4.2 车辆上下文

- 真实工作台的车辆 ID 来自显式输入或真实路由参数，先 trim、校验非空，再按接口路径正确编码。
- 不把演示 `AV-012` 自动转换为真实 `car-001`，也不假定两者有映射关系。
- 当前没有车辆目录接口，因此首期手工输入是正式支持路径；未来才用真实目录替换。
- 在有真实数据源之前，不从演示车辆卡片直接发起真实接管。可以跳到接管入口，但必须重新确认真实车辆。
- 每个浏览器工作台实例只持有一辆车、一个 Room 和至多一个控制会话。

### 4.3 核心交互

1. 操作员通过平台 SSO 登录，Gateway `/api/auth/me` 校验身份后展示账号。
2. 进入“接管工作台”，输入真实车辆 ID，显式选择“仅监看”或“申请控制”；默认仅监看。
3. 点击连接后请求相应凭证并加入 LiveKit，显示正在连接/等待视频，不提前展示“可控制”。
4. 只有控制会话有效、Room 就绪、必要视频可用时才能激活驾驶输入。
5. 控制态下清晰展示车辆、操作者、会话有效性、指令模式、释放控制和紧停入口。
6. 点击断开时终止输入、尝试停止、释放租约、关闭 Room、清理轨道和密钥。
7. 切换车辆/模式或离开页面时，走同一关闭流程；有控制会话时先确认，取消则保持当前上下文。

第一阶段不提供同一 Room 内无缝 observer/controller 升降级：切换模式需先断开再重新连接。这样不依赖未验证的权限热更新，也避免同一 operator identity 的双 Room 替换行为。

## 5. 模块职责与代码组织

建议增量结构，路径为计划而非已存在文件：

```text
frontend/src/
  App.tsx
  app/
    PlatformLayout.tsx
    AuthProvider.tsx
  lib/
    runtime-config.ts
    gateway-client.ts
    oidc-client.ts
  features/teleop/
    types.ts
    teleop-session.ts
    secure-control-sender.ts
    use-teleop-session.ts
    TeleopPage.tsx
    components/
      ConnectionPanel.tsx
      VideoGrid.tsx
      ControlPanel.tsx
      SessionStatus.tsx
  pages/
    Home.tsx
    TeleopWorkbench.tsx
```

职责约束：

- `AuthProvider`：平台身份状态、登录回调、内存 token 和退出协调，不管理相机或控制定时器。
- `gateway-client`：统一授权头、实际响应类型、HTTP 状态和可展示错误；不承担车辆控制策略。
- `teleop-session`：一次连接尝试拥有的 Room、sender、事件绑定、关闭流程和状态变化；不依赖 DOM。
- `secure-control-sender`：密钥、协议序列化/签名、租约和单次发布；暴露续租/发布失败，不自行决定页面跳转。
- `use-teleop-session`：将服务状态映射到 React，管理挂载/卸载和操作入口。
- `VideoGrid`：仅管理容器 ref、轨道 attach/detach 和布局，不决定权限。
- `TeleopWorkbench`：保留适用的工作台视觉，替换静态相机与虚假连接 HUD；不保留第二套控制状态。

优先迁移逻辑并保留协议，不将旧 HTML 的全局 handler、DOM ID 和内联脚本直接搬入 React。旧控制台在回退期间保持可用；新模块为迁移后的维护主线，不要求同时重构两个入口形成共享包。

## 6. 认证与运行配置

### 6.1 认证生命周期

- 沿用 Authorization Code + PKCE S256 和随机 state 校验，拒绝 state/verifier 缺失或不匹配。
- access token、LiveKit token、控制私钥仅存在页面内存，不进入 URL、localStorage、日志或持久化状态。
- sessionStorage 仅保存短期 PKCE verifier、state 和站内返回路径；回调后清理。
- HashRouter 的业务路径不能直接作为带 fragment 的 OIDC redirect URI。建议使用固定 `${origin}${pathname}` 回调，在应用初始化时先处理 query 中的 code/state，再恢复站内 hash 路径。
- 返回路径限制在本平台站内路由，不接受任意外部跳转。
- token 交换后调用 `/api/auth/me`；按实际 `Name`、`Roles`、`Scopes`、`Organization` 字段适配，不假设后端返回小写字段。
- 刷新页面后不恢复控制权，不自动重放指令；没有内存 token 时重新登录。
- 当前没有已验证的 refresh-token 流程，本期不假定支持静默续登；认证失效先停控、关闭连接，再要求重新登录。
- 退出先关闭远程会话再清理平台身份；若关闭失败，明确提示，停止本地发送并清理敏感对象。身份提供方单点登出是后续独立需求。

### 6.2 配置

建议使用部署时生成的公开运行配置，包含 Gateway URL、LiveKit URL、OIDC authorize/token endpoint、client ID 和 redirect URI。client ID 是公开标识，不是 client secret。

生产端点来自可信部署配置；不沿用允许任意 query 覆盖认证/token/Gateway 地址的调试方式。开发覆盖如保留，必须显式限定为开发环境。

生产必须 HTTPS/WSS，验证浏览器支持 WebCrypto Ed25519。Gateway CORS 允许平台精确 origin；Casdoor 同时注册正确 redirect URI，并验证浏览器 token 交换所需的跨域配置。不能仅修改前端 URL 就认为 SSO 配置完成。

## 7. 现有接口契约与调用方式

| 接口 | 本期用途与注意事项 |
|---|---|
| `GET /api/auth/me` | Bearer 认证，获取经 Gateway 校验的身份 |
| `GET /api/token/operator?vid={id}&access=observer` | 获取只读房间 token；显式指定 observer，不使用后端默认模式 |
| `POST /api/vehicles/{id}/control/acquire` | 请求体 `{public_key_b64}`；响应 `{session, token, renew_after_ms}`，一次申请同时获得控制会话和控制端房间 token |
| `POST /api/control/{session_id}/renew` | 续租；读取响应会话有效期和建议续租间隔，失败关闭可控状态 |
| `POST /api/control/{session_id}/release` | 主动释放；关闭流程可将 404 视作已无会话，其余失败显式报告 |
| `GET /api/vehicles/{id}/control` | 可选查询控制状态；404 表示无活动会话，不表示车辆离线 |
| `POST /api/vehicles/{id}/video/acquire`、`POST /api/video/{session_id}/release` | 已有接口，但不是本期监看通路的强制依赖；共享 viewer 句柄问题和车端状态联动完成后再集成 |

控制申请的 `session` 至少应按实际响应包含 `session_id`、`vehicle_id`、`operator_id`、`expires_at_ms` 等字段；实现时以 Go 结构定义为准，不靠强制类型断言假装响应正确。

首期 observer 沿用旧控制台已使用的 token + Room 订阅链路，controller 使用 acquire 返回的 token。均不额外伪造新的 REST 控制接口；驾驶指令仍走 LiveKit DataPackets。

错误处理：

| 状态/情况 | 用户反馈和动作 |
|---|---|
| 401 | 登录失效；立即停控，关闭工作台连接，重新登录 |
| 403 | 当前账号无相应权限；不提供绕过操作 |
| acquire 409 | 已有控制租约；明确提示冲突，不自动强抢或静默降为可控 |
| 查询 404 | 按具体接口解释为无会话，不能统一当作网络异常 |
| 5xx、超时、网络断开 | 展示具体阶段和可重试信息；控制中则先禁止输入并关闭会话 |
| Room 已连接但无视频 | “等待车辆视频/未收到轨道”，不显示“视频正常”或虚构车辆在线 |

UI 权限只用于交互提示；最终仍由 Gateway 的角色、scope 和车辆 ACL 决定。没有权限列表接口时，不承诺前端能在请求前准确判断某辆车是否可控。

## 8. 会话状态机和资源生命周期

建议状态：

```text
idle -> authorizing -> connecting -> waitingVideo -> observing / controlling
                                  \-> error
observing / controlling -> closing -> idle
任一活动阶段失效 -> closing -> error 或 signedOut
```

状态中区分“已持有控制租约”和“允许发送驾驶输入”；等待视频时可能已有租约，但不能因此开启控制按钮。连接超时可沿用旧控制台的 15 秒，视频等待使用独立、明确的超时策略，不能无限占用租约。

关键不变量：

1. 未登录、未获控制租约、续租失效、Room 非就绪或必要视频不可用时，不发送驾驶动作。
2. 同一实例只有一个连接过程；重复点击禁用。使用连接代次标识隔离迟到回调。
3. 取消连接不能只取消 UI：fetch 即使已在服务端成功，也可能返回迟到租约；必须回收它。
4. 每个回调捕获自己的 Room/sender，不通过可变全局引用操作新连接。
5. 关闭流程幂等：先禁用新输入、取消重复发送，尽可能发送 stop，再释放租约、断开 Room、detach 轨道、解绑事件并移除密钥引用。
6. 单个清理步骤失败不能阻断其余清理；收集并展示释放失败等信息，不吞错或假报已释放。
7. 释放失败时仍停止本地发送；服务端租约过期和车端 watchdog 是兜底，不能被描述为释放已经成功。
8. `pagehide` 的 keepalive 请求只作为尽力释放；浏览器关闭不保证请求完成。
9. 路由导航、浏览器前进后退和组件卸载都必须走关闭路径；不能只在侧栏点击时清理。
10. 不在全屏切换时新建 Room、重新订阅或克隆一套视频树；同一个视频容器改变展示布局。

LiveKit 暂时重连时立即暂停输入并清除按住动作；不得在恢复后自动继续此前动作。首期采用保守策略：结束本次控制会话并要求重新连接，避免引入未验证的自动恢复逻辑。

## 9. 视频、HUD 和控制交互

### 9.1 视频

- 保留现有名称规则：`camera` 映射前视兼容槽，`camera-front` 为前视，`camera-left/center/right` 对应三路。
- 单路占主区域；三路按左/中/右排列，支持中间放大与恢复。
- 未识别轨道给出诊断，不随意覆盖其他相机；卸载时调用 detach。
- 不假定已有后视轨道；没有后视不能用图片伪装成倒车实时视频。
- 断流显示缺失状态，停止将旧帧标成 LIVE；不能只以 Room 已连接判断视频可用。
- 控制模式根据实际相机布局要求必要主视角可用；丢失必要视频时停控。冻结画面不能只靠 TrackUnsubscribed 发现，实施时应验证可用的帧进度/SDK 统计检测手段。
- 视频新鲜度阈值需结合真实编码帧率和联调结果确定，作为控制开放前的验收项，不在设计中虚构已经验证的阈值。

### 9.2 HUD

首期只显示可靠来源：车辆 ID、经校验的账号、请求模式、连接阶段、相机接收状态和控制会话有效性。

速度、电量、档位、位置、自动驾驶状态及端到端时延没有真实读取接口时显示“暂无数据”或隐藏。RTC 连接质量只能标为 RTC 质量，不能替代车辆网络类型、端到端控制时延或车辆在线判定。

移除真实工作区中的示例图片、“录像中”、固定满格网络及默认 D 档。发送紧停成功仅表示发布成功，不能显示“车辆已停车”；当前没有车辆执行确认协议。

### 9.3 指令

- 继续使用 `api/schemas/datachannel-control.schema.json` 定义的 version 1、session ID、递增 sequence、timestamp、command 和 Ed25519 signature。
- 签名规范沿用 `secure-control-sender.ts` 的字段顺序和分隔方式，车端无需适配新协议。
- 高层默认模式保留六种动作；底层模式保留原页面已有转向和紧急制动能力，参数范围遵循 schema。
- 保留按住约 100 ms 周期发送的行为；一次只保留有限待发送工作，不累计历史动作队列。
- 松开、pointer cancel、失焦、页面隐藏及切换指令模式时结束当前动作；有可用链路时发送 stop。
- emergency stop 优先于普通动作并清除重复动作；仍通过同一签名链路，不绕过会话校验。
- 指令发布失败需要反馈并退出可控状态，不只输出 console。
- 指令输入控件使用明确的 pointer 生命周期；本期不把原型中的 WASD 文案变成新增键盘驾驶功能。

## 10. 构建、部署和迁移兼容

实施时：

1. 在 `frontend` 声明并锁定 `livekit-client`、`typescript` 等实际需要的依赖；不安装未使用的 Casdoor SDK，PKCE 可沿用已有浏览器实现。
2. 增加显式类型检查命令，并使生产构建包含类型检查；esbuild 打包成功不能替代这一环节。
3. 保留现有 esbuild 流程，仅修复本期相关入口、生产 HTML 和配置注入。
4. 更新 `infra/scripts/build-frontend.sh`，主构建目标改为 `frontend/`，输出路径同步更新；保留旧控制台明确的独立构建命令供回退。
5. 为平台静态文件配置托管服务/镜像和 HTTPS 路由，接入当前 Compose 部署方式；不顺带扩展到 Kubernetes。
6. 同步平台 origin、Gateway CORS、Casdoor 回调白名单，以及需要的浏览器端跨域访问。
7. 演示图片与外部 CDN 不作为真实接管页面的运行依赖；生产依赖用锁文件固定。
8. 旧入口暂时保留但标为旧版；回退需人工先结束新入口会话，再打开旧版，不同时申请同车控制。

旧入口不是自动故障转移方案。新入口发生认证/控制错误时，不能自动切到旧版绕过错误。确认新入口验收和实际稳定性后再决定删除旧页面，删除不是本期前置条件。

## 11. 分阶段实施方案

| 阶段 | 主要改动 | 完成条件 |
|---|---|---|
| P0 平台与类型基线 | 最小 Layout/路由拆分、真实与演示边界、运行配置、锁文件和类型检查；修正工作台 props | 平台可构建，接管独立 URL 可访问，未接入模块不伪装成已上线 |
| P1 认证与只读监看 | PKCE、AuthProvider、Gateway client、单车 Room 服务、真实 VideoGrid | SSO 后可输入真实车辆并仅监看；单路/三路、断开/卸载正确，无控制指令发布 |
| P2 远程控制闭环 | sender 迁移、会话状态机、续租失败处理、控制面板、导航保护、视频可用性门控 | 申请/冲突/续租/释放可观测；签名兼容；各种离开和失效场景均停止输入 |
| P3 部署与切换 | 构建入口、静态托管、CORS/回调、文档、人工回退流程 | 部署后的平台完成端到端演练，旧入口可人工回退，生产无开发热更新连接 |

执行顺序为 P0 → P1 → P2 → P3。先将只读链路接通，再开放控制，避免边改平台壳边直接联调可执行驾驶指令。

P0/P1 不要求建设其他业务后端。资产目录、遥测读取、多 viewer 视频生命周期及车端按需编码作为后续独立方案，不阻塞首期手动选车的功能迁移。

## 12. 验收与验证计划

以下为实施后的验证要求，不表示本次文档工作已经执行了这些构建或联调。

### 12.1 自动化

现有 `frontend` 没有测试 runner。实施时优先使用最小测试配置覆盖纯状态机/协议逻辑，不为本期顺带搭建大型 E2E 平台。

必要用例：

- PKCE state 不匹配拒绝登录；回调后清理临时数据并恢复站内路由。
- observer 不调用控制 acquire、不发布控制 DataPackets。
- 控制申请响应包含可用 token 和会话有效期；409 不进入可控状态。
- 续租失败/过期/Room 断开立即关闭控制；重新连接不恢复旧动作。
- 连接取消后的迟到 token/租约不污染新连接，已获得的租约被回收。
- 释放失败仍执行断开和轨道清理；多次关闭不会重复触发业务副作用。
- 签名消息与车端现有高层/底层验证兼容；序号、范围和字段不变。
- 按住结束、紧停、失焦及卸载清除周期任务；异步发送不会积压旧动作。
- 单路/三路轨道映射、中央聚焦、轨道移除与全屏不重复连接。

计划命令：

| 范围 | 命令 | 使用条件 |
|---|---|---|
| 新平台类型检查 | `cd frontend && npm run typecheck` | P0 新增该脚本后 |
| 新平台构建 | `cd frontend && npm run build` | 每次功能迁移 |
| 新平台单元测试 | `cd frontend && npm test` | 实施时添加最小测试脚本后 |
| Gateway 回归 | `cd apps/teleop-gateway && go test ./...` | 接口契约或部署联调需要时；若修改 Gateway 则必须运行 |
| 车端协议回归 | `pytest apps/vehicle-edge/tests/test_control_protocol.py` | 签名/指令迁移验证 |
| 旧入口独立构建 | `cd apps/operator-console && npm run build` | 切换主构建入口、保留人工回退时 |

这些新增脚本目前尚不存在，不能在实施报告中写为已经通过。

### 12.2 人工端到端

使用受控模拟车辆或经人工批准的测试台架，不以真实行驶车辆作为首次验证环境：

- 从统一平台完成登录、选车、监看、显式申请控制、释放和退出。
- 两个不同操作员竞争同车时第二个得到冲突反馈，第一会话不受干扰。
- observer 可以看视频但不能操作，ACL 拒绝不能绕过。
- 验证高层动作、底层原有按钮及紧停签名由车端正确接收；不把前端成功提示当成执行确认。
- 模拟 RTC 断开、续租失败、视频轨道丢失/冻结，确认不再持续发送旧指令。
- 测试侧栏跳转、车辆切换、模式切换、浏览器前进后退、刷新、关闭标签页、窗口失焦。
- 观察租约和 watchdog 的兜底行为；区分“已尝试释放”和“服务端确认释放”。
- 部署后确认无 token/私钥进入 URL、持久化存储、日志和静态产物。
- 其他演示模块不会连接真实车辆，也不会展示未实现功能已成功。

## 13. 风险与实施前置条件

| 项目 | 处理决定 |
|---|---|
| 无车辆目录和遥测读取接口 | 首期手工输入真实 ID，无来源的 HUD 留空，不臆造 API |
| 视频会话服务与车端编码未联动 | 本期沿用现有订阅方式，不承诺按需编码或带宽节省 |
| viewer 会话不是每次观看独立句柄 | 不直接推广多 viewer 生命周期；单独修订协议后再接入 |
| 同账号多标签页/双入口 | 不承诺同车多连接；提示单实例使用，并验证 LiveKit identity 行为 |
| Ed25519/HTTPS 浏览器兼容 | 控制开放前做能力检测，缺失时明确拒绝控制 |
| 视频冻结检测与新鲜度阈值 | 在受控环境验证检测方式及阈值，通过后才开放控制 |
| 真正车辆状态和执行确认缺失 | 前端不得显示“已停车/已切档/已回自动”等未确认结论 |
| 生产域名、SSO redirect/CORS | 部署时提供可信配置并联调，不写死开发或个人环境 |
| 浏览器退出无法保证释放 | keepalive 尽力执行，服务端 TTL 与车端 watchdog 继续兜底 |

## 14. 首个实施批次建议

先交付 **P0 + P1：统一平台壳、SSO、真实车辆输入、只读视频工作台**。该批次验证平台接入方式、认证配置、相机轨道兼容和资源销毁，不开放驾驶输入。

在只读链路验收后实施 P2，将已有签名控制完整迁入同一个工作台；P3 完成部署入口切换。最终效果是“一个运维平台入口，其中远程接管已接真实系统，其他模块明确待接入”，而不是两套驾驶页面并行拼接。
