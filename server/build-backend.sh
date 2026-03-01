#!/usr/bin/env bash
set -euo pipefail

echo "Building backend (dockerized Go)..."
cd "$(dirname "$0")/.."/backend

docker run --rm -v "$PWD":/app -w /app -e GOPROXY=https://goproxy.cn,direct golang:1.24 \
  sh -c 'go mod tidy && go build -o teleop-backend'

echo "Built teleop-backend at backend/teleop-backend"
