#!/usr/bin/env bash
set -euo pipefail

echo "Building operator-ui (npm/TypeScript)..."
cd "$(dirname "$0")/.."/operator-ui

if [ -f package.json ]; then
  npm ci
  npm run build
  echo "Frontend build complete: operator-ui/dist"
else
  echo "No package.json found in operator-ui; skipping frontend build"
fi
