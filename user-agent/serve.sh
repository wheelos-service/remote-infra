#!/usr/bin/env bash
set -euo pipefail

# Simple static server for the user-agent (Python http.server)
PORT=${1:-8000}
echo "Serving user-agent on http://127.0.0.1:${PORT}"
python3 -m http.server ${PORT}
