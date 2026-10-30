#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
fixtures="$(mktemp -d)"
trap 'rm -f "$fixtures/corpus.json" "$fixtures/validated.json"; rmdir "$fixtures"' EXIT

if command -v go >/dev/null 2>&1; then
  (cd "$root/apps/teleop-gateway" &&
    PLATFORM_CONTRACT_FIXTURE="$fixtures/corpus.json" go test ./internal/gateway \
      -run '^TestPlatformMockContracts$' -count=1)
else
  # Optional persistent cache avoids downloading dependencies on repeated runs.
  cache_args=()
  if [[ -n "${PLATFORM_GO_CACHE_DIR:-}" ]]; then
    cache_args=(-v "$PLATFORM_GO_CACHE_DIR:/cache" -e GOCACHE=/cache/build -e GOPATH=/cache/go)
  fi
  docker run --rm --user "$(id -u):$(id -g)" \
    -e GOCACHE=/tmp/go-build -e GOPATH=/tmp/go \
    "${cache_args[@]}" -e GOPROXY=https://goproxy.cn,direct \
    -e PLATFORM_CONTRACT_FIXTURE=/fixtures/corpus.json \
    -v "$root:/workspace:ro" -v "$fixtures:/fixtures" \
    -w /workspace/apps/teleop-gateway golang:1.24 \
    go test ./internal/gateway -run '^TestPlatformMockContracts$' -count=1
fi

cd "$root/frontend"
node scripts/test-platform-contract.mjs "$fixtures/corpus.json" "$fixtures/validated.json"
"${PLATFORM_PYTHON:-python3}" "$root/tests/validate_platform_contract.py" "$fixtures/validated.json"
