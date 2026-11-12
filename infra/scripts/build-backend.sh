#!/usr/bin/env bash
set -euo pipefail

echo "Building backend (dockerized Go)..."
cd "$(dirname "$0")/../../teleop-gateway"
output_dir="${BACKEND_OUTPUT_DIR:-$PWD}"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"

docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/app:ro -v "$output_dir":/output -w /app \
  -e GOCACHE=/tmp/go-build -e GOPATH=/tmp/go \
  -e GOPROXY="${GOPROXY:-https://proxy.golang.org,direct}" golang:1.24 \
  sh -c 'CGO_ENABLED=0 go build -mod=readonly -trimpath -o /output/teleop-backend ./cmd/teleop-gateway'

echo "Built teleop-backend at $output_dir/teleop-backend"
