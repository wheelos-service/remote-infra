#!/usr/bin/env bash
set -euo pipefail

echo "Building frontend (React/TypeScript)..."
if [ ! -d "$(dirname "$0")/../../packages/teleop-shared/node_modules" ]; then
  npm ci --prefix "$(dirname "$0")/../../packages/teleop-shared"
fi
cd "$(dirname "$0")/../../frontend"

if [ ! -d node_modules ]; then
  npm ci
fi
npm run build
echo "Frontend build complete: frontend/dist"
