# Target Browser Verification of Source Video Capture Time

## Purpose

Define the authoritative contract and browser verification logic for validating
**source-side video capture freshness** before allowing remote driving (`ARMED`
/ `control-ready`). Until trustworthy source capture time is verified end to
end, driving control must remain gated or read-only.

## Current Baseline (Static Verification)

- **Browser (`frontend/src/lib/camera-feed.ts`)**: `bindCameraFeed` tracks
  frame progression and, when available, local receive-to-callback residence.
  Observation may fall back to `timeupdate`. These checks do not prove source
  freshness. The workbench therefore permits observation only, even for
  simulation; other API clients are not protected by this frontend gate.
- **Vehicle edge (`apollo-base` `v1` + `data/sdk-kit` `v2`)**: `EncodedFrame::capture_time_us` is defined
  in `data/sdk-kit/livekit/include/vehicle_edge/encoded_video.h` and forwarded
  to `metadata->user_timestamp_us` in `data/sdk-kit/livekit/media_backend.cc`
  when positive (`frame_metadata_features->user_timestamp = true`).
  `modules/teleop/src/camera_gst/camera_gst_adapter.cc` (`SubmitSample`) populates
  `capture_time_us` with Unix microseconds at `appsink` read, not sensor exposure;
  `SimulationFrame` (synthetic RGBA) does not populate `capture_time_us`.

## Target Browser Verification Protocol

Before enabling source-age gating in production driving mode, verify the real
vehicle -> LiveKit SFU -> target desktop browser (Chrome/Edge) media path:

1. **Populate source capture timestamp on the vehicle**:
   - Record monotonic/Unix capture time at camera `appsink` read (or hardware
     frame capture) into `EncodedFrame::capture_time_us`.
2. **Inspect `requestVideoFrameCallback(now, metadata)` in the target browser**:
   - Confirm `typeof video.requestVideoFrameCallback === 'function'` is true.
     Browsers lacking `requestVideoFrameCallback` must never fall back to
     `timeupdate` for driving control; force read-only observation.
   - Check whether `metadata.captureTime` is present and updating across direct,
     TCP, and TURN relay paths, and after `RoomEvent.Reconnected` / Room
     rebuild.
   - Measure clock offset and drift between the vehicle capture clock and the
     browser domain (`performance.timeOrigin + metadata.captureTime`). Never
     subtract uncalibrated wall clocks directly; use RTT-bounded offset
     estimation or verified NTP/PTP synchronization with explicit uncertainty
     bounds.
3. **Fallback when `metadata.captureTime` is missing or stripped by SFU**:
   - Inject source capture timestamps in-band (e.g., H.264 SEI
     `user_data_unregistered` parsed per frame) **or** have the vehicle report
     per-camera `capture_to_publish_age_ms` / frame mapping over `vehicle.state`
     combined with periodic RTT/clock-offset calibration.

## Layered Freshness Acceptance Gate (Driving Mode)

All 3 front cameras (`left`, `center`, `right`) must pass every layer below for
a continuous stability window (`T_stable`) before entering or staying in
control-ready state:

1. **API Gate**: `requestVideoFrameCallback` must be present (no `timeupdate`
   fallback).
2. **Frame Progression Gate**: `metadata.rtpTimestamp` (when present) or
   `metadata.presentedFrames` must strictly advance between callbacks so static
   compositor repaints are rejected.
3. **Local Pipeline Residence Gate**: `now - metadata.receiveTime` and render
   residence (`presentationTime - receiveTime`) must stay bounded to catch
   decoder/jitter-buffer stalls.
4. **Source Capture Age Gate**: Calibrated `age_ms = now_mapped -
   capture_time_mapped` must stay within `T_ctrl_block`, and frame rate must
   stay at or above `N_fps_min`. If source capture time is unavailable or
   uncalibrated, force read-only observation (`observeOnly`).
