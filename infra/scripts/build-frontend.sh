#!/usr/bin/env bash
set -euo pipefail

echo "Building frontend (React/TypeScript)..."
npm ci --prefix "$(dirname "$0")/../../packages/teleop-shared" --no-audit
cd "$(dirname "$0")/../../frontend"

npm ci --no-audit
npm run build
echo "Frontend build complete: frontend/dist"
