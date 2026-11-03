# Remote Three-Process Validation

> 当前 `frontend/` 是唯一平台源码目录，原版布局内已绑定动态八车 Mock、
> 本地地图、告警/任务与 HUD 数据。默认访问 `/`，用 `?map=目录名` 选择已转换地图，
> 详见 `frontend/README.md`。不新增工具栏，不连接真实 Gateway/LiveKit，不开放运动任务。
> 下文实时接口与模拟控制仍为保留模块参考；第一层旧预览工具栏步骤不再适用于当前入口。

## Current React + Go + C++ workflow

当前入口是 `frontend/`、`apps/teleop-gateway/`、`apps/vehicle-edge-cpp/`。
下方原 Python/standalone console 步骤仅为 legacy v1 参考，不可与当前 v2
控制/交接流程混用。系统按“多车监控、按需视频、单车独占控制”分层：
当前支持多车只读监控和显式模拟控制，**不开放实车驾驶或运动任务派发**。

### 前端功能与验收矩阵

| 功能 | 当前能力 / 测试重点 |
| --- | --- |
| 身份与 ACL | 未登录、过期、observe/control 分离、跨账号/租户隔离；切换后不保留旧身份数据 |
| 车队与遥测 | 授权目录、在线/离线、占用；速度/挡位/模式/电量/定位；分别验证缺失、过期、未来时间、重启换流 |
| 健康 Monitor | 检查项/HMI/紧急停车要求与源年龄；接口在线不等于车端在线或健康，缺失/截断不推断恢复 |
| 告警 | raised/changed/recovered、人工知悉、导出；人工确认不改变设备故障状态，断网不能伪报成功 |
| 任务 | 云端落库、设备接收、对账、unknown、终态及受限只读查询；查询成功不是运动完成 |
| 历史与容量 | 有界历史、序列缺口、流切换、事件/任务及设备积压；无数据不等于无积压 |
| 地图 | 动态 Mock 在原版地图容器中展示车道几何/多车航向/选车；通过 URL 选择地图，真实车辆绑定与投影未接入 |
| 多车视频 | 每车独立观看租约/Room，最多四面板；第五个受限，关闭 A 不影响 B；掉帧遮罩、前后视角、退出清理 |
| 模拟控制 | READY 后发令、签名/序列/年龄、看门狗、失焦/断线停发、不自动重启、跨标签页互斥、释放后模拟交接 |
| 实车驾驶 | 未开放；合成视频、模拟 APPLIED、HTTP 202 均不是执行器/物理交接证据 |

### 第一层：本地地图 + 动态八车 Mock

```bash
cd frontend
npm run prepare:maps -- --source /mnt/synology/map \
  --map xiaomo_port_inside_0.9.0 --map ruantong_hry_origin
npm run dev
```

访问 `http://localhost:8000/`，用 `?map=ruantong_hry_origin` 更换本地地图。
局域网使用 `HOST=10.0.39.103 PORT=8000 npm run dev`。详细八车场景见
[`frontend/README.md`](../frontend/README.md#实际地图与动态八车监控-mock)。
先验收原版五个主导航、地图 URL 切换、选车联动、故障/离线状态、
sim-006 在 20 秒恢复及 sim-008 unknown。开发者工具 Network 应只有前端、
同源地图静态请求与原版外部示例图片，不应出现 `/api/`、OAuth 或 WebSocket 请求；
任务保存/下发禁用，视频明确为示例。
这个层级只证明前端展示，不证明服务端或设备接入。地图资产不提交 Git，
转换/发布需具备地图使用权限，禁止直接对外共享 `/mnt/synology/map`。

### 第二层：真实 HTTP 数据链，再接视频与模拟控制

```text
监控：合成观察 / Cyber -> C++ Data SDK -> Gateway -> Redis/SQLite -> React
视频：React viewing 租约 -> Gateway media-demand -> C++ worker -> LiveKit -> React
控制：React 签名 -> LiveKit -> C++ 验证/模拟 setpoint -> 反馈
                         ^ Gateway 控制授权和交接栅栏
```

服务端使用**独立测试配置和资源**，先登记模拟车辆，配置
`VEHICLE_REGISTRY_JSON`、`VEHICLE_SUBJECT_MAP_JSON` 和操作员
`VEHICLE_ACL_JSON`，将 `CLIENT_ORIGIN` 与前端 origin 精确对齐。
不要直接覆盖现有 `.env` 或重启共享部署。受控测试环境启动示例：

```bash
docker compose --env-file /path/to/isolated-test.env -p teleop-mock \
  -f docker-compose.yml -f docker-compose.no-domain.yml \
  up -d --build redis livekit-config livekit teleop-backend
curl --fail http://localhost:8080/healthz
curl --fail http://localhost:8080/readyz
docker compose --env-file /path/to/isolated-test.env -p teleop-mock \
  -f docker-compose.yml -f docker-compose.no-domain.yml \
  logs -f --tail=100 teleop-backend livekit
```

此覆盖暴露 HTTP/WS，仅限隔离网络；确认 8080/7880/7881/UDP 端口无其他部署占用，
远程使用 HTTPS/WSS 和正确 ICE/防火墙配置，不能以生产地址替代隔离测试服务。
Redis 不暴露公网，SQLite 单 Gateway 持久存储，不能删库/清 Redis 来解除测试栅栏。

车端从 `apps/vehicle-edge-cpp/config/device.example.json` 配置独立设备身份，
使用 root-owned、0600 普通文件；生产采用设备 OAuth，不能将浏览器 dev token
直接用于 C++ SDK。端点必须从各端实际可达；浏览器和远端设备不能使用 Compose 内部主机名。
同机多车需独立凭据、车辆 ID、缓存/数据库及 Cyber domain/通道，不得多实例冒充同一底盘。

1. 先仅接监控：匹配设备的 `POST /api/vehicles/{id}/state` 返回 204；
   profile/Monitor/events/diagnostics 通过 `/data/...` 独立上传。停掉 A 后 B 继续更新。
2. 前端启动 `cd frontend && npm run dev`，访问
   `http://localhost:8000/?dev=1&backend=http://localhost:8080&livekit=ws://localhost:7880`。
   本地 dev 认证时在“只读监看”页使用“本地开发登录”，再返回总览检查 `/api/vehicles` 与 `/data`。
   OIDC 环境使用正式登录和精确的 redirect URI/CORS；凭据不进入 URL 或日志。
3. 再接视频：在 C++ 安装的 Teleop 示例显式启用 `media_enabled=true`、
   `camera_source=simulation`，设置匹配的 worker/LiveKit 端点。逐车添加四个面板，
   验证观看租约、media-demand、worker、轨道、解码帧；移除面板/退出后回收。
4. 最后接模拟控制：仅将废弃模拟 ID 加入 `SIMULATED_CONTROL_VEHICLES_JSON`，
   保持 `CONTROL_HANDOVER_ACK_ENABLED=false`；设备设 `control_mode=simulation`，
   本机前端加 `&control=simulation`。等待 READY 后测试输入，释放并等待模拟交接后再切车。
   实际构建/受保护配置和运行命令见
   [`C++ SDK 模拟器`](../apps/vehicle-edge-cpp/README.md#manual-browser-simulator)。

Teleop 独立示例只提供合成视频/控制，不上传 Data 运营数据；
持续手工监控需要运行实际 DataService/设备接入程序，不能把第一层页面 Mock 当作设备发布器。
现有自动数据链可在无需生产凭据的隔离环境验证实际 C++ HTTP/持久化行为。

### 分层自动检查

```bash
# 以下从仓库根执行；C++/Docker/Go/Python 依赖详见 tests/README.md
npm --prefix frontend test
npm --prefix frontend run build
bash tests/platform-contract.sh
bash tests/data-chain.sh
python3 tests/control-chain.py
# Gateway 单测从 apps/teleop-gateway 执行 go test ./...
```

分别验证前端状态/地图转换、构建、跨端契约、真实 Data SDK HTTP 链和 v2
模拟控制链；不能替代实际浏览器、相机硬件、网络负载或实车安全验收。
大车队性能另按 8/50/200 台逐级测量目录响应、渲染耗时和内存，不宣称本次八车演示已完成容量认证。

### 三端排障顺序

| 现象 | 优先检查 |
| --- | --- |
| 没车辆 | registry、当前账号 observe ACL、`GET /api/vehicles` |
| 车辆离线 | 车端 OAuth/身份映射、上传结果、服务端最后接收时间 |
| 在线但过期 | 源时间戳、回调年龄、服务器/浏览器年龄，不只看上传心跳 |
| 有状态没视频 | viewing -> media-demand -> worker -> Room -> 正确车辆轨道 -> 解码新帧 |
| 地图位置偏移 | 地图版本、frame、单位、原点/投影；不要混用 editor 局部点和 base_map 坐标 |
| 控制不能申请 | ACL、模拟白名单、操作者/车辆互斥及 pending fence |
| 释放后不能切车 | 202 仅受理，核对匹配 session/revision 的模拟交接；不能删栅栏绕过 |

通过 vehicle_id、stream_id/sequence、request/session ID、revision 和时间关联三端；
同步时钟，禁止记录 token、client secret、签名私钥或完整控制载荷。

## Legacy v1 deployment reference

The server, vehicle, and operator client can be deployed and restarted independently.

## 1. Server

Run this on the server host. Redis and LiveKit stay private to the Compose network; expose
only the Gateway and LiveKit ports required by remote clients.

Before starting the server, point these DNS records at the server's public IP:

```text
api.example.com -> <server-public-ip>
rtc.example.com -> <server-public-ip>
```

On the server host:

```bash
cp .env.example .env
```

Set at least these values in `.env`:

```dotenv
LIVEKIT_API_KEY=teleop_prod_key
LIVEKIT_API_SECRET=<long-random-secret>
AUTH_MODE=oidc
OIDC_ISSUER=https://casdoor.example.com/
OIDC_AUDIENCE=teleop-api
OIDC_JWKS_URL=https://casdoor.example.com/.well-known/jwks.json
CLIENT_ORIGIN=http://127.0.0.1:8000
API_DOMAIN=api.example.com
RTC_DOMAIN=rtc.example.com
VEHICLE_ACL_JSON=[{"user_id":"operator-001","tenant_id":"fleet-a","vehicle_id":"car-001","permissions":["observe","control"]}]
```

Start all server services, including the TLS reverse proxy:

```bash
docker compose --profile cloud up -d --build
docker compose ps
curl https://api.example.com/healthz
curl https://api.example.com/readyz
```

The server firewall must allow these ports:

```text
80/tcp                         # ACME HTTP challenge
443/tcp                        # API HTTPS and LiveKit WSS
7881/tcp                       # LiveKit RTC/TCP fallback
50000-50100/udp                # LiveKit WebRTC media
```

The Caddy proxy maps `https://api.example.com` to the Gateway and
`wss://rtc.example.com` to LiveKit. The Gateway container uses
`LIVEKIT_URL=http://livekit:7880` internally; local vehicle and browser processes must use
the externally reachable `wss://rtc.example.com` address.

Do not expose Redis or the Gateway's container hostname to the public network.

## No-Domain Temporary Validation

If the server has no DNS name yet, use its public IP for temporary development validation.
This mode is HTTP/WS only and must not be used as a production deployment. It publishes
Gateway and LiveKit directly, so the server firewall must allow `8080/tcp`, `7880/tcp`,
`7881/tcp`, and `50000-50100/udp`.

On the server:

```bash
docker compose -f docker-compose.yml -f docker-compose.no-domain.yml up -d --build
curl http://<server-ip>:8080/healthz
curl http://<server-ip>:8080/readyz
```

For a development token setup, use `AUTH_MODE=dev` and open the client with `dev=1`:

```text
http://127.0.0.1:8000/?dev=1&backend=http://<server-ip>:8080&livekit=ws://<server-ip>:7880
```

The client will prompt for a development token in the existing format:

```text
operator-001|fleet-a|observer,controller
```

Start the local vehicle with the same IP endpoints:

```bash
PYTHONPATH=apps/vehicle-edge/src python3 -m vehicle_edge.vehicle_node \
  --gateway http://<server-ip>:8080 \
  --vehicle-id car-001 \
  --device-config /etc/teleop/device.yaml \
  --livekit-url ws://<server-ip>:7880 \
  --camera-layout single
```

This direct-IP mode has no browser-trusted TLS certificate and provides no encrypted
transport. Switch to the cloud profile and real HTTPS/WSS certificates before exposing the
system beyond a controlled test network.

For production, set `AUTH_MODE=oidc`, configure the Casdoor issuer, audience, JWKS URL, and
vehicle ACL. Do not use the development token parser on an internet-facing deployment.

## 2. Vehicle

Install dependencies on the vehicle, provision the credential file as root-owned mode 0600,
and start the vehicle process independently from the server:

```bash
cd apps/vehicle-edge
python3 -m pip install -r requirements.txt
sudo install -o root -g root -m 0600 device.yaml /etc/teleop/device.yaml
PYTHONPATH=src python3 -m vehicle_edge.vehicle_node \
  --gateway https://api.example.com \
  --vehicle-id car-001 \
  --device-config /etc/teleop/device.yaml \
  --livekit-url wss://rtc.example.com \
  --camera-layout single
```

The vehicle needs outbound HTTPS/WSS access to the server. It does not need Redis, Casdoor
JWKS, or the Gateway's private network address.

For a container deployment, pass the same arguments after the image name:

```bash
docker run --rm --network host \
  -v /etc/teleop/device.yaml:/etc/teleop/device.yaml:ro \
  wheelos-vehicle-edge \
  --gateway https://api.example.com \
  --vehicle-id car-001 \
  --device-config /etc/teleop/device.yaml \
  --livekit-url wss://rtc.example.com \
  --camera-layout single
```

## 3. Operator client

Run the static client on the operator workstation. This process does not need Redis or the
vehicle credential:

```bash
cd apps/operator-console
npm run build
python3 -m http.server 8000 --directory dist
```

Open the page with the externally reachable endpoints. Do not use `http://livekit:7880`
or `http://teleop-backend:8080` from the local machine:

```text
http://127.0.0.1:8000/?backend=https://api.example.com&livekit=wss://rtc.example.com&casdoor=https://casdoor.example.com
```

In production, serve the client itself over HTTPS and configure the Casdoor OIDC application
for the client origin.

## 4. Independent verification order

1. Server: `/healthz` and `/readyz` return 200.
2. Vehicle: token refresh succeeds, then the vehicle joins the `teleop-<vehicle_id>` room.
3. Client: operator authentication succeeds and the vehicle appears through the Gateway ACL.
4. Observer: `video/acquire` returns `mode: ACTIVE`.
5. Controller: acquire control with an in-memory Ed25519 public key; the control session and
   video session must both be active.
6. Release control and verify that observer video remains active. Release the last viewer and
   verify grace period, then `STANDBY`.
7. Stop LiveKit or the vehicle process and verify the vehicle watchdog enters its safe state.

## 5. Local automated checks

```bash
cd apps/teleop-gateway && go test ./...
cd apps/vehicle-edge && PYTHONPATH=src python3 -m unittest discover -s tests -p 'test*.py' -v
python3 tests/e2e_secure_receiver.py
python3 tests/e2e_control_session_receiver.py
```

The VideoSession tests use an in-memory Redis server and do not require an external Redis
process. The control lease integration tests require a reachable Redis instance and can be
run with `REDIS_URL=redis://127.0.0.1:6379/0`.
