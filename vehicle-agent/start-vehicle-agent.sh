#!/bin/bash
set -e

echo "=== 启动 Vehicle Agent (带摄像头) ==="

# 检查摄像头
if [ ! -e "/dev/video0" ]; then
  echo "❌ 未找到摄像头 /dev/video0"
  exit 1
fi
echo "✓ 摄像头设备存在"

# 获取 LiveKit token
echo "正在从 backend 获取 LiveKit token..."
TOKEN=$(curl -s 'http://localhost:8080/api/token/vehicle?vid=car-001' \
  -H 'Authorization: Bearer car-001|fleet-a|vehicle' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

if [ -z "$TOKEN" ]; then
  echo "❌ 获取 token 失败"
  exit 1
fi
echo "✓ Token 已获取"

# 进入脚本所在目录
cd "$(dirname "$0")"

# 启动 vehicle agent
echo "正在启动 vehicle agent..."
PYTHONPATH=. python3 vehicle_node.py \
  --gateway http://localhost:8080 \
  --vehicle-id car-001 \
  --token "$TOKEN" \
  --mode livekit \
  --livekit-url "http://localhost:7880" \
  --publish-video \
  --camera-id 0
