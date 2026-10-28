#!/usr/bin/env bash
# Apollo-native build. All generated sources, outputs and caches stay under vehicle-edge.
set -euo pipefail
edge_dir="$(cd "$(dirname "$0")" && pwd)"
apollo_root="${APOLLO_ROOT_DIR:-$(cd "$edge_dir/../../.." && pwd)}"
command="${1:-run}"
if (( $# )); then shift; fi
case "$command" in
  run) target=vehicle_node; action=run ;;
  probe) target=probe_feedback; action=run ;;
  test) target=cyber_integration_test; action=test ;;
  build) target=vehicle_node; action=build ;;
  *) echo 'Usage: run-apollo.sh {run|probe|test|build} [arguments...]' >&2; exit 2 ;;
esac
workspace="$(python3 "$edge_dir/prepare_apollo.py" --apollo-root "$apollo_root")"
export CYBER_PATH="${CYBER_PATH:-$apollo_root/cyber}"
export CYBER_IP="${CYBER_IP:-127.0.0.1}"
export CYBER_DOMAIN_ID="${CYBER_DOMAIN_ID:-80}"
export VEHICLE_CYBER_BACKEND=apollo
# Apollo's setup uses the Python protobuf implementation; its Bazel C++
# extension can be compiled against different host Python headers.
export PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python
# Prevent ambient WheelOS/Apollo Python paths from selecting an unrelated .so.
unset PYTHONPATH
export PYTHONNOUSERSITE=1
mkdir -p "$edge_dir/.apollo-local/log"
export GLOG_log_dir="$edge_dir/.apollo-local/log"
cd "$workspace"
bazel_args=("--jobs=${VEHICLE_BUILD_JOBS:-4}" --flaky_test_attempts=1)
if [[ "$action" == run ]]; then
  exec bazel --output_user_root="$edge_dir/.apollo-local/bazel" "$action" \
    "${bazel_args[@]}" "//vehicle_edge_local:$target" -- "$@"
else
  exec bazel --output_user_root="$edge_dir/.apollo-local/bazel" "$action" \
    "${bazel_args[@]}" "//vehicle_edge_local:$target" "$@"
fi
