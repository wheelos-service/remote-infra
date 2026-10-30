# 运维平台前端

`frontend/` 是运维平台入口。远程工作台支持最多四个独立的 LiveKit 只读车辆监看面板；
可显式启用 v2 **模拟控制测试**，实车驾驶输入和车辆任务命令仍未开放。

## 模拟控制测试

默认 `simulationControl: false`。在公开运行配置中设为 true，或 localhost 使用
`?dev=1&control=simulation`，即可在选定操作目标后打开模拟控制面板。
前提是 Gateway 仅对废弃/模拟车辆 ID 配置 `SIMULATED_CONTROL_VEHICLES_JSON`，
且对应 C++ SDK 设定 `control_mode=simulation`。WebCrypto 要求 localhost 或 HTTPS。
前端开关不授予控制权：服务端白名单、ACL 和单操作员单车仲裁始终生效。

申请后等待车端反馈 READY；按住模拟前进按钮发令，松开回到中立 setpoint。
失焦/隐藏、断线/重连、续期/反馈失败停止发令且不自动恢复。
必须释放并等待**模拟交接**完成，才能切换下一辆车。
APPLIED 仅表示模拟器接受，不能证明实车执行或物理交接。
`?preview=1` 始终不发送请求或指令。

自动跨端验收：在仓库根执行 `python3 tests/control-chain.py`；
构建前提和协议见 [SDK 指南](../apps/vehicle-edge-cpp/README.md#testable-v2-control-loop)。

## 构建

```bash
npm ci
npm run typecheck
npm run build
```

生产构建输出到 `dist/`。开发预览使用 `npm run dev`。

## 公开运行配置

默认 Gateway、LiveKit、Casdoor 地址和 Casdoor client ID 沿用旧 `apps/operator-console/` 的配置。部署环境可在 `index.html` 加载 `main.js` 之前注入公开配置，例如：

```html
<script>
  window.__LIVEKIT_INFRA_CONFIG__ = {
    gatewayUrl: 'https://gateway.example.com',
    livekitUrl: 'wss://rtc.example.com',
    authorizeUrl: 'https://sso.example.com/login/oauth/authorize',
    tokenUrl: 'https://sso.example.com/api/login/oauth/access_token',
    clientId: 'public-operator-client-id'
  }
</script>
```

这些字段只允许公开端点和 OIDC client ID；不要放置 client secret、LiveKit API secret、设备凭据或访问令牌。Gateway 必须允许平台 origin 的 CORS，Casdoor 必须登记与平台 origin/path 完全匹配的 redirect URI，生产环境使用 HTTPS/WSS。

Access token 只保存在当前页面内存中。刷新页面需要重新登录；浏览器不会恢复之前的车辆连接。

## 车辆实时遥测

正常模式下，“车队总览”和“车辆监控”通过已登录账号的访问令牌读取 Gateway 的授权车辆目录
(`/api/vehicles`)，每 2 秒顺序轮询一次；目录失败时保留上次快照供参考，但显示离线并报告错误。
车辆详情显示源样本新鲜度、浏览器接收时长、服务端/源时间戳和时钟异常，不会把未知样本标为正常。
车辆操作占用状态只反映会话占用，不代表当前车辆输入动作。坐标按遥测 frame 显示为局部米制坐标，
不会擅自投影为地理地图。查看车队或详情不会连接 LiveKit 或发送控制指令。

`?preview=1` 启用固定预览场景。车辆、诊断、告警、任务及历史预览通过与实时接口相同的 Zod schema
校验，并明确标识为非实时；预览模式跳过 OAuth 回调校验、Gateway 请求、观看租约和 LiveKit 连接。
预览数据不能满足真实车辆的驾驶就绪条件。

通过 `?preview=1&scenario=reverse` 切换固定数据场景；支持 `default`、`parking`、
`reverse`、`stale`、`missing`、`clock`、`error`、`recovered`、`history` 和
`mission-unknown`。同一场景用于车辆摘要与业务详情，分别保留过期、未知、故障恢复、
历史缺口及任务结果未知语义；所有场景仍禁止真实网络和指令。`default` 保留原双车样例。
未知场景名显式报错，不静默回退。跨端验证入口为根目录
`bash tests/platform-contract.sh`，依赖和验证范围见 `tests/README.md`。

真实只读监看需操作者显式添加车辆面板；每个面板先申请独立 viewing 租约，再创建独立 LiveKit
Room，最多同时四辆车。关闭一个面板仅清理它自己的 Room 和租约。离开工作台或退出账号会清理全部面板；
导航离开前会提示。占用信息只来自授权目录；请求失败或数据过期时显示未知，不代表车辆当前输入动作。
每次连接尝试使用独立 UUID v4 请求 ID，同一页面挂载使用同一 client instance ID；不同标签页不会复用控制身份。
租约响应严格校验车辆、会话和有效期限，剩余时间扣除完整 HTTP 往返时延；续期串行执行，
请求在 5 秒内超时。续期失败或租约到期立即停止监看并释放租约，连接失败、取消、账号切换和
卸载也会用原始登录令牌释放。取消后迟到的申请成功响应同样释放，不会创建 Room。
释放失败会显示错误或在卸载时输出不含凭据的控制台错误；关闭页面等无法保证 HTTP 完成的情况
依赖停止续期后的 30 秒 TTL 回收，不保证卸载释放请求送达。申请超时不自动重试，结果不确定时
也由 TTL 回收。仅接受身份严格匹配 `vehicle-{vehicle_id}` 的车辆视频。
C++ 已有可选原生 SDK 与显式合成相机闭环，真实相机接入和部署验收尚未完成；
租约或信令连接成功不代表视频已就绪，不会开放控制或驾驶指令。

目录请求禁用浏览器缓存并在 8 秒后超时重试。年龄以单调时钟的请求开始时间计，
保守地包含完整 HTTP 往返时延；回调年龄加上快照/发布的最大存储与传输年龄。
在线状态按服务端车辆接收时间继续老化，目录失败或超过有效期的操作占用状态显示未知。

### 诊断、告警、Mission 与历史

车辆详情、告警及任务页接入 `GET /api/vehicles/{vehicle_id}/data`，每 2 秒串行轮询，
请求和响应体总计最多 8 秒。账号/车辆切换取消旧请求，不展示其他身份的缓存。
接口可达和 Monitor 源数据新鲜度分别显示；源未知/过期/未来/截断均不作为当前健康结论。
`?preview=1` 使用同一严格契约的固定数据，所有变更按钮关闭且不发起请求。

- Monitor 面板展示各检查项、HMI、其他组件及紧急停车要求，仅作为状态，不是控制命令。
- 告警页展示 Monitor raised/changed/recovered；控制角色且有车辆 control ACL 时，
  可确认“已知悉”，但不会关闭故障或伪造设备恢复。
- 任务页区分云端落库、设备接收、dispatch fence、unknown 对账及终态。
  只允许为 `mission_query` 车辆创建携带原请求身份的只读账本查询；
  SDK 仍独立校验能力/地图/期限。查询成功不等于原运动任务完成。
- POST 超时/断网显示“结果未知”，本页面保留原始载荷供同身份重试；
  轮询确认相同请求已落库后解除重试状态。清除本地重试不取消云端任务；
  离开前保存待核实 ID，浏览器不持久保存请求或凭据。
- 容量卡展示云端事件/任务与设备 outbox/inbox/故障键保留量、待传/待对账量；
  达到 80% 显示告警。未收到或老旧的设备诊断不能推断无积压。
- 导出按有界游标获取全部保留事件或任务，所有页通过验证后才生成 NDJSON；
  不删除记录或去重身份。结果与人工确认逐页变化，导出不是 SQLite 一致性备份。

#### 兼容遥测读区

车辆详情保留的兼容读区对当前选中的一辆授权车辆轮询
`GET /api/vehicles/{vehicle_id}/operations`，间隔 10 秒，超时 8 秒，使用当前会话的 Bearer
令牌、请求取消和 `no-store`。请求错误、无数据或未实现的持久化来源会显示不可用/未知，不回退到实时模拟值；
该兼容读区不提供写操作；告警确认与只读查询由上方 `/data` 面板提供。

兼容诊断仅描述已采集底盘和定位遥测的接收/年龄及相关问题，不能代表完整车端 `SystemStatus` 或整体健康。
历史接口最多返回 300 条最新样本；前端明确标为有界抽样而非完整回放，并按 `stream_id` 与 `sequence`
标记流切换、缺口或序号异常。地图只显示局部米制坐标，不作经纬度解释或地理投影。驾驶、地理投影和
Mission 命令能力保持 false。

## 本地只读联调

仅查看平台/接管页面布局（不登录、不调用 Gateway/LiveKit）：

```text
http://<前端主机>:8000/?preview=1
```

此预览模式可从车辆列表选择车辆并打开工作台预览，但显示的是占位画面；不会尝试真实接管。

在本机使用 Gateway 的开发认证模式时，可运行前端开发服务器并访问：

```text
http://localhost:8000/?dev=1&backend=http://localhost:8080&livekit=ws://localhost:7880
```

进入“只读监看”页后可使用“本地开发登录”提示输入开发令牌，并通过 Gateway `/api/auth/me` 校验。该入口只在 `localhost`、`127.0.0.1` 或 `::1` 且显式带 `dev=1` 时出现；令牌不会写入 URL 或浏览器存储。

预览模式的车辆与业务记录均为固定界面样例，不代表已注册车辆、实时告警、任务或健康结果。正常模式从当前账号授权目录选择车辆，服务端 ACL、车辆是否运行以及视频是否发布仍需分别确认。

当前平台工作台为只读监看。原 `apps/operator-console/` 作为独立旧入口保留，其开发控制流程见 `docs/local-dev.md`；执行控制联调仅限隔离的模拟器/测试台，首次验证不得连接真实行驶车辆。

前端不实现远程控制切车或驾驶权转移，不把 HTTP 释放受理视为车辆确认，也不推断目标车已可控。后端控制释放确认在物理 handover 策略验证前保持关闭；面板关闭只结束该浏览器观看租约与 Room。

工作台可将授权列表中的任意一辆车设为唯一“操作目标”，与多车监看面板独立；
切换这个目标不会申请控制租约或更换任何 Room。界面分别显示操作目标与当前工作台
控制车辆（当前驾驶未开放）。后续控制协调器必须绑定唯一会话，而不是跟随下拉框或
最近收到的车辆状态；从 A 控制切换 B 仍须先释放 A 并取得权威交接确认。
