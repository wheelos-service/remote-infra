#!/usr/bin/env bash
set -euo pipefail

echo "Building backend (dockerized Go)..."
cd "$(dirname "$0")/../../apps/teleop-gateway"

docker run --rm -v "$PWD":/app -w /app -e GOPROXY=https://goproxy.cn,direct golang:1.24 \
  sh -c 'go build -mod=readonly -o teleop-backend ./cmd/teleop-gateway'

echo "Built teleop-backend at apps/teleop-gateway/teleop-backend"
