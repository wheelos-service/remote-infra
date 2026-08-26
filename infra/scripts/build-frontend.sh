#!/usr/bin/env bash
set -euo pipefail

echo "Building operator-console (npm/TypeScript)..."
cd "$(dirname "$0")/../../apps/operator-console" || true

if [ -f package.json ]; then
  if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
    npm ci || npm install
  else
    npm install
  fi
  npm run build
  echo "Frontend build complete: apps/operator-console/dist"
else
  echo "No package.json found in apps/operator-console; skipping frontend build"
fi
