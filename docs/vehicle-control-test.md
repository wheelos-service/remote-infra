# Vehicle setup for the 1.1.3 public control test

The public Gateway automatically admits all active enrolled vehicles. A compatible onboard runtime supplies its receiver heartbeat and camera capture timestamps as soon as it connects. Start with the dashboard checks in section 3. Use the onboard checks in sections 1 and 2 if either signal is missing.

The site details below are for **zhongce-car-01**. When checking another vehicle, use its own enrolled ID. The LAN reference at `10.0.39.101` is enrolled separately as `Test-101`.

| Public deployment setting | Expected value |
| --- | --- |
| Enrolled vehicle ID | `v-033c35b0-vehicle-cc9689fc9dd9-9ac145532b7f41c6` |
| Gateway and dashboard | `https://console.example.com:9443` |
| Login issuer | `https://login.example.com:9443` |
| LiveKit signaling | `wss://console.example.com:9443` |

## 1. Check the existing identity and connection

Run the checks **inside the Apollo runtime environment**, using the account that runs Teleop. Follow `teleop.dag` to its component configuration and read `runtime_config_path`. The reference installation uses `/etc/teleop/device.json`. The following check prints only matches and file status. Substitute the active runtime path on this vehicle if it differs.

```sh
python3 - <<'PY'
import json
import os
from pathlib import Path

runtime = json.loads(Path("/etc/teleop/device.json").read_text())
identity = json.loads(Path(runtime["credentials_file"]).read_text())
worker = Path(runtime.get("media_worker_path") or ".")
print("Public vehicle ID matches:", identity.get("vehicle_id") == "v-033c35b0-vehicle-cc9689fc9dd9-9ac145532b7f41c6")
print("Gateway matches:", identity.get("gateway_url", "").rstrip("/") == "https://console.example.com:9443")
print("Issuer matches:", identity.get("issuer", "").rstrip("/") == "https://login.example.com:9443")
print("LiveKit matches:", runtime.get("livekit_url", "").rstrip("/") == "wss://console.example.com:9443")
print("Configured media worker is executable:", worker.is_file() and os.access(worker, os.X_OK))
PY
curl -fsS --max-time 5 https://console.example.com:9443/readyz
curl -fsS --max-time 5 https://login.example.com:9443/.well-known/openid-configuration |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["issuer"])'
```

Expect an HTTP success from the Gateway and the exact login issuer in the table. If TLS fails, check site DNS and the public CA certificate trusted *inside the runtime*. If the identity or Gateway differs, locate the active credential file for this enrollment before continuing. Keep the existing device key and credentials on this vehicle. [Vehicle enrollment and TLS](add-vehicle.md)

## 2. Configure and start the onboard receiver

At a maintenance stop, save the current runtime configuration and deployed binary paths so they can be restored together. In the active `device.json`, set or verify these fields. Preserve this vehicle's camera devices, longitudinal control mode, speed limit, and Guardian/Canbus calibration.

| Field | Required for this test |
| --- | --- |
| `control_mode` and `control_channel` | `"cyber"` and `"/apollo/teleop/control"` |
| `media_enabled` and `livekit_url` | `true` and `"wss://console.example.com:9443"` |
| `camera_source` and `camera_layout` | `"h264_annexb"` and `"three"` for the three physical cameras |
| `camera_capture_config` | Absolute path to this vehicle's left, center, and right camera configuration |
| `media_worker_path` | Absolute path to the installed, executable SDK-Kit media worker for this vehicle's architecture |

Check the installed Apollo and SDK-Kit releases as a pair. The Apollo Teleop component must poll the instance-specific `control/context/native-v3-percent/` endpoint. Its capture component and SDK-Kit worker must carry the capture timestamp through to the displayed video frame. Record both source revisions when building locally. For an Apollo source deployment with GStreamer capture, run the following as the build user with the matching source and dependencies installed.

```sh
cd /apollo
git rev-parse HEAD
git -C data/sdk-kit rev-parse HEAD
git grep -F 'control/context/native-v3-percent/' -- modules/teleop/src/control/teleop_client.cc
bazel build --config=dev --lockfile_mode=off --define=teleop_camera_gst=true \
  //modules/teleop:libteleop_component.so //modules/teleop:vehicle_media_worker
bazel run --config=dev --lockfile_mode=off //modules/teleop:vehicle_media_worker -- --sdk-smoke
```

Install the component at the library path named in the active `teleop.dag` and the worker at `media_worker_path`, with its matching runtime libraries. Restart Teleop through the vehicle's existing launcher to load the new configuration and binaries. For a source installation managed directly with Cyber, start the stopped runtime from `/apollo` with `cyber_launch start modules/teleop/launch/teleop.launch`. Confirm that Guardian and Canbus are publishing current status. To roll back an onboard change, restore the saved configuration and matching binaries at a maintenance stop, then restart the same launcher.

Deploy the component to the library path in the active Teleop DAG and the matching worker to `media_worker_path`. Use the vehicle's existing launcher to restart Teleop once and confirm that Guardian and Canbus are reporting. The onboard receiver starts polling the Gateway even before an operator requests control. [Receiver contract](../teleop-gateway/internal/gateway/control_context.go)

## 3. Verify in the dashboard before the control test

Reload the public dashboard and reopen **远程驾驶** for the selected vehicle with a `remote_operator` account scoped to it. Reopening retries a clock request previously denied by an older Gateway.

| Observation | What to check |
| --- | --- |
| **源视频新鲜度尚未验证，仅可监看** persists | In the browser Network panel, inspect the GET ending in `/control/bench-clock`. The selected vehicle and organization should receive HTTP 200 with a positive `epoch`. A 401 points to sign-in. For a 403, verify active enrollment, the selected organization, operator scope, and whether the target is configured as a simulator. |
| **等待车端 native-v3 接收器心跳** | The clock response should show `receiver_ttl_ms` repeatedly above zero. If it stays at zero while telemetry advances, check the running Apollo component, its `control_mode`, enrolled ID, and Gateway URL. The unversioned context request does not register a native-v3 heartbeat. |
| Receiver online, **申请控制权** still disabled | Keep the driving tab visible. Check that each of the three front feeds has verified capture timestamps below one second of age continuously for one second. If one feed has zero verified samples, check its capture timestamp and the matching SDK-Kit worker. If all three pass, read any lease or handover blocker shown in the panel. |

For the live-actuator test, have the onboard operator confirm local override and emergency stop are available before requesting control. At the end, select **释放并等待车辆交接** and confirm Guardian and chassis have returned to the intended local mode. Record the operator session, time, and handback result. [Dashboard control panel](../frontend/src/pages/DrivingControlPanel.tsx) · [Control and handback diagnostics](remote-control-timestamps.md)
