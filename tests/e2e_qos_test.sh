#!/bin/bash
set -e

echo "Starting LiveKit and Redis using docker-compose..."
docker compose up -d livekit redis

echo "Building and starting Go gateway..."
# support either original layout (backend/) or moved layout (server/backend/)
if [ -d server/backend ]; then
  echo "Detected server/backend layout; using server/backend"
  cd server/backend
elif [ -d backend ]; then
  cd backend
else
  echo "Error: backend directory not found" >&2
  exit 1
fi
# Build natively if go is installed, else use docker
if command -v go >/dev/null 2>&1; then
    go build -o teleop-backend
else
    docker run --rm -v $PWD:/app -w /app -e GOPROXY=https://goproxy.cn,direct golang:1.24 go build -o teleop-backend
fi
export LIVEKIT_API_KEY="teleop_prod_key"
export LIVEKIT_API_SECRET="teleop_prod_secret"
export LIVEKIT_URL="http://localhost:7880"
./teleop-backend &
BACKEND_PID=$!
cd ..

echo "Waiting for services to be ready..."
sleep 5

echo "Applying tc netem (Network Emulation)..."
# Set up iproute2 if missing (e.g. some CI environments)
if ! command -v tc &> /dev/null; then
    sudo apt-get update && sudo apt-get install -y iproute2
fi
sudo tc qdisc add dev lo root netem delay 100ms 20ms loss 5% || echo "tc already added or no permission"

echo "Running E2E QoS Python Test..."
set +e
python3 tests/e2e_qos_test.py
TEST_RET=$?
set -e

echo "Cleaning up..."
sudo tc qdisc del dev lo root || true
kill $BACKEND_PID
docker compose stop livekit redis

if [ $TEST_RET -ne 0 ]; then
  echo "E2E QoS Test FAILED!"
  exit 1
else
  echo "E2E QoS Test PASSED!"
  exit 0
fi
