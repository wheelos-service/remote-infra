#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="${DATA_SDK_BUILD_DIR:-$root/apps/vehicle-edge-cpp/build}"
cache="${DATA_CHAIN_GO_CACHE:-$build/data-go-cache}"
work="$(mktemp -d /tmp/remote-infra-data-chain-XXXXXX)"
trap 'rm -f "$work/data-gateway.test" "$work/product.json"; rmdir "$work"' EXIT

cmake -S "$root/apps/vehicle-edge-cpp" -B "$build" >/dev/null
cmake --build "$build" --target data_chain_client data_test --parallel 2 >/dev/null
ctest --test-dir "$build" -R '^data_test$' --output-on-failure
if command -v go >/dev/null; then
  (cd "$root/apps/teleop-gateway" &&
    CGO_ENABLED=0 go test -c ./internal/gateway -o "$work/data-gateway.test")
else
  mkdir -p "$cache"
  docker run --rm --user "$(id -u):$(id -g)" \
    -e CGO_ENABLED=0 -e GOCACHE=/cache/build -e GOMODCACHE=/cache/mod \
    -v "$root/apps/teleop-gateway:/src" -v "$cache:/cache" -v "$work:/out" \
    -w /src golang:1.24 \
    go test -c ./internal/gateway -o /out/data-gateway.test
fi
DATA_PRODUCT_FIXTURE="$work/product.json" DATA_SDK_CLIENT="$build/data_chain_client" "$work/data-gateway.test" \
  -test.run '^TestDataSDKChain$' -test.v -test.timeout=90s
(cd "$root/frontend" && node scripts/test-data-contract.mjs "$work/product.json")
