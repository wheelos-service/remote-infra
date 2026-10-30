#!/usr/bin/env bash
# Current simulation setup. Trailing CLI arguments override these defaults.
# Camera indices default to the selected layout; pass --camera-indices to override.
# The auth token below is the existing development identity, not a production credential.
set -euo pipefail
cd "$(dirname "$0")"
exec bash ./run-apollo.sh run \
  --gateway http://118.145.117.118:8080 \
  --vehicle-id car-001 \
  --livekit-url ws://118.145.117.118:7880 \
  --auth-token 'car-001|fleet-a|vehicle' \
  --cyber --cyber-control \
  --camera-layout six \
  --camera-width 1920 --camera-height 1080 --camera-fps 30 \
  --video-width 640 --video-height 360 \
  --cyber-max-forward-throttle-pct 80 \
  --cyber-max-reverse-throttle-pct 40 \
  --cyber-max-steering-pct 40 \
  --cyber-max-speed-mps 10 \
  --cyber-stop-brake-pct 10 \
  --cyber-emergency-brake-pct 100 \
  --cyber-chassis-timeout-s 0.5 \
  --cyber-shift-speed-mps 0.05 \
  --cyber-shift-timeout-s 2 \
  --cyber-throttle-rise-pct-s 20 \
  --cyber-steering-rate-pct-s 80 \
  "$@"
