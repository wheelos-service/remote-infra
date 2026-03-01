# Stage-1 指令级安全加固

本阶段实现三项核心防线：

1. **Ed25519 指令签名**（防篡改）
2. **seq + ts 防重放**（Replay 防护）
3. **Watchdog + Emergency Brake**（Dead Man's Switch）

## 1) Go 网关接口

已在 `backend/main.go` 增加接口：

- `POST /api/keys/register`
  - 用途：前端注册临时 Ed25519 公钥
  - 入参 JSON:
    - `vehicle_id`
    - `operator_id`
    - `key_id`
    - `public_key_b64`
    - `expires_at_ms` (可选)
- `GET /api/keys/current?vid=<vehicle_id>`
  - 用途：车端拉取当前有效公钥

> 当前实现为内存注册表，生产建议替换为 Redis/DB 并做多副本同步。

## 2) JS 发送端

文件：`operator-dashboard/secure_control_sender.js`

流程：

1. 浏览器生成临时 Ed25519 keypair
2. 调 `POST /api/keys/register` 注册公钥
3. 每条控制指令携带：`seq`、`ts`、`key_id`、`vehicle_id`
4. 按固定格式签名：

```
vehicle_id|key_id|cmd|val|seq|ts
```

5. DataChannel 下发 JSON（含 `sig` 和 `alg=Ed25519`）

## 3) Python 车端验证

文件：`vehicle-agent/secure_receiver.py`

验证逻辑：

- key_id 必须与网关下发的当前 key 一致
- `abs(now_ms - ts) <= 100ms`，否则丢弃
- `seq` 必须严格递增，否则丢弃（防重放）
- 使用 Ed25519 公钥验证签名，不通过即丢弃并告警

## 4) Watchdog 与紧急制动

`VehicleAgentRuntime.safety_watchdog()` 每 50ms 检查一次：

- 若超过 300ms 没有合法指令：
  - 触发 `EmergencyBrakeController.emergency_brake()`
  - 切断原控制态（进入 emergency）

并提供 `reconnect_loop()` 的指数退避重连示例。

## 4.1) 可执行 e2e 用例（新增）

文件：`vehicle-agent/tests/e2e_secure_receiver.py`

覆盖三类关键安全用例：

- 伪造签名（attacker key）-> 必须拒绝
- 重放攻击（重复 seq）-> 必须拒绝
- 300ms 超时无合法指令 -> 必须触发 `EMERGENCY_BRAKE`

运行：

```bash
python vehicle-agent/tests/e2e_secure_receiver.py
```

## 5) 运行依赖

`requirements.txt` 已加入：

- `aiohttp`
- `pynacl`

安装：

```bash
python -m pip install -r requirements.txt
```

## 6) 生产化建议

- 公钥注册与查询落到 Redis/DB，并加 TTL、审计日志与轮换策略
- 前端临时私钥放在安全上下文中，不做持久化
- 车端需接入真实制动硬件接口（CAN/ECU）实现真正急停
- 所有时钟统一 NTP/PTP，确保 100ms 时间窗可用
