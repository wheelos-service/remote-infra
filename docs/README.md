# livekit-infra — 运行与运维指南（摘要）

本文件为快速上手与 SLO / Runbook 摘要。更详细步骤见仓库其他文档或联系 SRE 团队。

## 快速启动（开发环境）
1. 复制并填充 `.env`（仅开发/测试）：
   ```bash
   cp .env.example .env
   # 编辑 .env，设置 LIVEKIT_API_SECRET（不要提交到仓库）
   ```
2. 启动所需服务：
   ```bash
   docker-compose up -d
   ```
3. 检查服务状态：
   ```bash
   docker-compose ps
   docker-compose logs -f teleop-backend
   ```

## 本地构建 Backend（可选）
如果本机安装了 Go：
```bash
cd backend
go mod tidy
go build -v ./...
./teleop-backend
```

如果使用 Docker 构建（推荐 CI 执行）：
```bash
docker-compose build teleop-backend
docker-compose up -d teleop-backend
```

## Python 工具依赖
```bash
python -m pip install -r requirements.txt
```

## SLO（示例）
- 控制路径端到端 P99 latency < 150ms
- 控制通路可用性 >= 99.9%
- 重连成功率（同一网络）> 99% 且恢复时长 < 5s

## 紧急 Runbook 摘要
1. 当后台收到车辆 `participant.left` 或 heartbeat 超时：
   - 将该车辆状态标记为 `失联`，立刻通知值班操作员。
   - 触发备用安全通道（MQTT/直接 CAN-bus 命令）下发急停指令。
2. 如果检测到控制命令签名校验失败：
   - 立即拒绝命令并记录事件（含原始 DataChannel 报文）。
   - 将车辆置入限制模式（只允许本地安全动作），并发起钥匙轮换流程。
3. Key rotation/泄露流程：
   - 立刻撤销受影响 key，生成新 key，更新 LiveKit + 后端配置并重启相关服务（按顺序：后端 → livekit → operator 客户端）。

## 需尽快完成的项
- DataChannel 消息签名 + replay-window（车端与操作端）
- Webhook 切换到 mTLS / 密钥轮换
- 网络/主机调优（sysctl、DSCP 标记、NIC affinity）
- CI: 构建与网络仿真测试（tc/netem）

## 目录说明（高层）
- `backend/` — Token service 与 webhook handler
- `livekit/` — LiveKit 配置
- `caddy/` — 入口网关配置
- `operator-dashboard/` — 前端驾驶舱（占位）
- `vehicle-agent/` — 车端 agent（占位）
- `infra/` — k8s / terraform / systemd 等
- `tests/` — 网络仿真与 e2e 测试

如需我进一步把 Runbook 扩展成可执行脚本（例如自动化 key-rotate、emergency-stop API），请指示。
