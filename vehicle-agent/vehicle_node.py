"""vehicle_node.py

Single-file runnable vehicle agent that wires together:
- `CommandVerifier` (secure_receiver.py)
- `VehicleAgentRuntime` (secure_receiver.py)

Behaviour:
- periodically refresh operator public key from gateway
- connect to a WebSocket/DataChannel-like source and deliver incoming
  text messages to the runtime for verification and control application
- runs the safety watchdog and reconnect logic

Usage example:
  python vehicle-agent/vehicle_node.py --gateway http://127.0.0.1:8080 \
      --vehicle-id car-001 --token "car-001|fleet-a|vehicle" --ws ws://127.0.0.1:9000/ws
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
from typing import Optional

import aiohttp

# 尝试导入 OpenCV
try:
    import cv2
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False

from secure_receiver import (
    CommandVerifier,
    EmergencyBrakeController,
    VehicleAgentRuntime,
    OperatorKeyRegistration,
)


async def _periodic_key_refresh(verifier: CommandVerifier, session: aiohttp.ClientSession, interval_s: int = 30) -> None:
    while True:
        try:
            await verifier.refresh_key(session)
            logging.info("[KEY_REFRESH] loaded key_id=%s",
                         verifier.current_key.key_id if verifier.current_key else "<none>")
        except Exception as exc:
            logging.warning("[KEY_REFRESH] failed: %s", exc)
        await asyncio.sleep(interval_s)


async def _ws_receive_loop(runtime: VehicleAgentRuntime, ws_url: str, session: aiohttp.ClientSession) -> None:
    backoff = 0.2
    while True:
        try:
            async with session.ws_connect(ws_url, timeout=10) as ws:
                logging.info("[WS] connected to %s", ws_url)
                backoff = 0.2
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        await runtime.on_datachannel_message(msg.data)
                    elif msg.type == aiohttp.WSMsgType.ERROR:
                        logging.error("[WS] error: %s", msg)
                        break
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logging.warning("[WS] connection failed: %s", exc)
        logging.info("[WS] reconnecting after %.1fs", backoff)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 5.0)


async def casdoor_login(session: aiohttp.ClientSession, casdoor_url: str, app: str, org: str, vehicle_id: str, device_secret: str) -> str:
    payload = {
        "type": "code",
        "application": app,
        "organization": org,
        "username": vehicle_id,
        "password": device_secret,
    }
    async with session.post(casdoor_url, json=payload, timeout=5) as resp:
        text = await resp.text()
        if resp.status != 200:
            raise RuntimeError(f"casdoor login failed: {resp.status} {text}")
        data = await resp.json()
        if data.get("status") != "ok":
            raise RuntimeError(f"casdoor rejected: {data}")
        return data.get("data")


async def request_livekit_token(session: aiohttp.ClientSession, backend_url: str, jwt: str, vehicle_id: str) -> str:
    headers = {"Authorization": f"Bearer {jwt}"}
    async with session.get(f"{backend_url}?vid={vehicle_id}", headers=headers, timeout=5) as resp:
        text = await resp.text()
        if resp.status != 200:
            raise RuntimeError(f"token request failed: {resp.status} {text}")
        data = await resp.json()
        token = data.get("token")
        if not token:
            raise RuntimeError(f"no token in response: {data}")
        return token


async def livekit_connect_loop(runtime: VehicleAgentRuntime, lk_url: str, lk_token: str, publish_video: bool = False, camera_id: int = 0) -> None:
    try:
        from livekit import rtc
    except Exception as exc:
        logging.error("[LIVEKIT] livekit.rtc not available: %s", exc)
        return

    room = rtc.Room()

    def _on_data(data_packet):
        try:
            # data_packet 是 DataPacket 对象，包含 participant 和 data 属性
            raw_data = data_packet.data
            # data 可能是 bytes 或 str
            raw = raw_data.decode("utf-8") if isinstance(
                raw_data, (bytes, bytearray)) else str(raw_data)
            logging.info("[LIVEKIT] received data from %s: %s",
                        data_packet.participant.identity if hasattr(data_packet, 'participant') and hasattr(data_packet.participant, 'identity') else 'unknown',
                        raw[:100] if len(raw) > 100 else raw)  # 只打印前100字符
            asyncio.create_task(runtime.on_datachannel_message(raw))
        except Exception as e:
            logging.exception("[LIVEKIT] on_data handler error: %s", e)

    room.on("data_received", _on_data)

    # 摄像头捕获任务
    camera_task = None

    try:
        await room.connect(lk_url, lk_token)
        logging.info("[LIVEKIT] connected to %s", lk_url)

        if publish_video and hasattr(rtc, "VideoSource"):
            try:
                # 检查 OpenCV 是否可用
                if not CV2_AVAILABLE:
                    logging.error("[LIVEKIT] OpenCV not available, cannot capture from camera")
                else:
                    # 创建 VideoSource
                    src = rtc.VideoSource(640, 480)
                    track = rtc.LocalVideoTrack.create_video_track("camera", src)
                    options = rtc.TrackPublishOptions()
                    options.source = rtc.TrackSource.SOURCE_CAMERA
                    options.video_encoding.max_bitrate = 2_000_000
                    options.video_encoding.max_framerate = 20
                    await room.local_participant.publish_track(track, options)
                    logging.info("[LIVEKIT] published video track")

                    # 启动摄像头捕获任务
                    camera_task = asyncio.create_task(_camera_capture_loop(src, camera_id))
            except Exception:
                logging.exception(
                    "[LIVEKIT] failed to publish video (continuing)")

        # keep running until disconnected
        while True:
            await asyncio.sleep(1)

    finally:
        if camera_task:
            camera_task.cancel()
            try:
                await camera_task
            except asyncio.CancelledError:
                pass
        try:
            await room.disconnect()
        except Exception:
            pass


async def _camera_capture_loop(video_source: "rtc.VideoSource", camera_id: int, fps: int = 20) -> None:
    """从摄像头捕获帧并推送到 LiveKit"""
    from livekit import rtc
    import cv2

    WIDTH, HEIGHT = 640, 480

    cap = cv2.VideoCapture(camera_id)
    if not cap.isOpened():
        logging.error("[CAMERA] 无法打开摄像头 %s", camera_id)
        return

    try:
        # 设置摄像头参数
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, HEIGHT)
        cap.set(cv2.CAP_PROP_FPS, fps)

        logging.info("[CAMERA] 开始从摄像头 %s 捕获，fps=%s", camera_id, fps)

        frame_time = 1.0 / fps
        next_frame_time = 0

        while True:
            ret, frame = cap.read()
            if not ret:
                logging.warning("[CAMERA] 读取帧失败")
                await asyncio.sleep(0.1)
                continue

            # BGR 转 RGBA (LiveKit 需要 RGBA 格式)
            frame_rgba = cv2.cvtColor(frame, cv2.COLOR_BGR2RGBA)

            # 创建 VideoFrame 并推送
            # 使用 bytearray 来传递数据，这是 LiveKit SDK 推荐的方式
            frame_buffer = bytearray(frame_rgba.tobytes())
            video_frame = rtc.VideoFrame(
                WIDTH, HEIGHT, rtc.VideoBufferType.RGBA, frame_buffer
            )
            video_source.capture_frame(video_frame)

            # 精确的帧率控制 (使用 perf_counter 更准确)
            from time import perf_counter
            now = perf_counter()
            if next_frame_time == 0:
                next_frame_time = now
            next_frame_time += frame_time
            sleep_time = max(0, next_frame_time - now)
            await asyncio.sleep(sleep_time)

    except asyncio.CancelledError:
        logging.info("[CAMERA] 摄像头捕获已停止")
    finally:
        cap.release()
        logging.info("[CAMERA] 摄像头已释放")


async def run_agent(
    gateway: str,
    vehicle_id: str,
    token: str,
    ws_url: Optional[str],
    key_refresh_s: int = 30,
    mode: str = "ws",
    casdoor_url: Optional[str] = None,
    casdoor_app: Optional[str] = None,
    casdoor_org: Optional[str] = None,
    device_secret: Optional[str] = None,
    backend_token_url: Optional[str] = None,
    livekit_url: Optional[str] = None,
    publish_video: bool = False,
    camera_id: int = 0,
    load_key_file: Optional[str] = None,
) -> None:
    verifier = CommandVerifier(gateway, vehicle_id, token)
    brake = EmergencyBrakeController()
    runtime = VehicleAgentRuntime(verifier, brake)

    async with aiohttp.ClientSession() as session:
        # If a local registration file is provided, load it directly (convenience for demos)
        if load_key_file:
            try:
                with open(load_key_file, "r") as f:
                    data = json.load(f)
                reg = OperatorKeyRegistration(
                    vehicle_id=data["vehicle_id"],
                    operator_id=data.get("operator_id", "op-demo"),
                    key_id=data["key_id"],
                    public_key_b64=data["public_key_b64"],
                    expires_at_ms=int(
                        data.get("expires_at_ms", 9999999999999)),
                    registered_at_ms=int(data.get("registered_at_ms", 0)),
                )
                verifier.load_registration(reg)
                logging.info(
                    "[INIT] loaded local registration key_id=%s", reg.key_id)
            except Exception as exc:
                logging.warning(
                    "[INIT] failed to load local key file: %s", exc)

        # If running in livekit mode, optionally obtain JWT/token via Casdoor + backend
        if mode == "livekit":
            if casdoor_url and casdoor_app and casdoor_org and device_secret and backend_token_url:
                try:
                    jwt = await casdoor_login(session, casdoor_url, casdoor_app, casdoor_org, vehicle_id, device_secret)
                    token = jwt  # override API token with fresh JWT
                    verifier.auth_token = jwt  # update verifier auth token
                    logging.info("[CASDOOR] obtained JWT")
                    lk_token = await request_livekit_token(session, backend_token_url, jwt, vehicle_id)
                    logging.info("[GATEWAY] obtained LiveKit token")
                except Exception as exc:
                    logging.error(
                        "[INIT] failed to obtain LiveKit token: %s", exc)
                    return
            elif livekit_url and token:
                lk_token = token
            else:
                logging.error(
                    "[INIT] insufficient parameters for livekit mode")
                return

            # If a local registration file is provided, load it directly (convenience for demos)
            if load_key_file:
                try:
                    with open(load_key_file, "r") as f:
                        data = json.load(f)
                    reg = OperatorKeyRegistration(
                        vehicle_id=data["vehicle_id"],
                        operator_id=data.get("operator_id", "op-demo"),
                        key_id=data["key_id"],
                        public_key_b64=data["public_key_b64"],
                        expires_at_ms=int(
                            data.get("expires_at_ms", 9999999999999)),
                        registered_at_ms=int(data.get("registered_at_ms", 0)),
                    )
                    verifier.load_registration(reg)
                    logging.info(
                        "[INIT] loaded local registration key_id=%s", reg.key_id)
                except Exception as exc:
                    logging.warning(
                        "[INIT] failed to load local key file: %s", exc)

            # Try initial key load from gateway (best-effort)
            try:
                await verifier.refresh_key(session)
                logging.info("[INIT] initial key_id=%s",
                             verifier.current_key.key_id if verifier.current_key else "<none>")
            except Exception as exc:
                logging.warning("[INIT] initial key refresh failed: %s", exc)

        tasks = []
        # start periodic key refresher
        tasks.append(asyncio.create_task(
            _periodic_key_refresh(verifier, session, key_refresh_s)))
        # start watchdog
        tasks.append(asyncio.create_task(runtime.safety_watchdog()))
        # start telemetry reporting
        tasks.append(asyncio.create_task(
            runtime.telemetry_loop(gateway, token, vehicle_id, session)))
        # start receive loop depending on mode
        if mode == "ws":
            if not ws_url:
                logging.error("--ws is required for ws mode")
                return
            tasks.append(asyncio.create_task(
                _ws_receive_loop(runtime, ws_url, session)))
        else:
            # livekit mode
            tasks.append(asyncio.create_task(livekit_connect_loop(
                runtime, livekit_url or ws_url or "", lk_token, publish_video, camera_id)))

        # run until cancelled
        try:
            await asyncio.gather(*tasks)
        except asyncio.CancelledError:
            logging.info("[AGENT] shutdown requested")
        finally:
            runtime.running = False
            for t in tasks:
                t.cancel()


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Vehicle agent node")
    p.add_argument("--gateway", required=True,
                   help="Gateway base URL (http://host:port)")
    p.add_argument("--vehicle-id", required=True, help="Vehicle identifier")
    p.add_argument("--token", required=False,
                   help="Auth token for gateway (Bearer). In livekit mode this can be the LiveKit token if provided directly")
    p.add_argument("--ws", required=False,
                   help="WebSocket URL to receive DataChannel-like messages (required in ws mode)")
    p.add_argument("--mode", choices=("ws", "livekit"), default="ws",
                   help="Receive mode: 'ws' for external websocket, 'livekit' to connect to LiveKit")
    p.add_argument("--casdoor-url", help="Casdoor M2M login URL")
    p.add_argument("--casdoor-app", help="Casdoor application name")
    p.add_argument("--casdoor-org", help="Casdoor organization name")
    p.add_argument("--device-secret",
                   help="Device secret for Casdoor M2M login")
    p.add_argument("--backend-token-url",
                   help="Gateway endpoint to exchange JWT for LiveKit token, e.g. http://localhost:8080/api/token/vehicle")
    p.add_argument("--livekit-url",
                   help="LiveKit websocket URL (used in livekit mode)")
    p.add_argument("--publish-video", action="store_true",
                   help="If set in livekit mode, attempt to publish a local video track")
    p.add_argument("--camera-id", type=int, default=0,
                   help="Camera device ID for video capture (default: 0)")
    p.add_argument("--key-refresh-s", type=int, default=30,
                   help="Key refresh interval seconds")
    p.add_argument("--load-key-file",
                   help="Path to JSON OperatorKeyRegistration to load locally (demo)")
    return p.parse_args()


def main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    args = _parse_args()

    loop = asyncio.get_event_loop()

    stop_event: Optional[asyncio.Event] = asyncio.Event()

    def _shutdown() -> None:
        logging.info("[SIGNAL] received stop, cancelling tasks")
        for task in asyncio.all_tasks(loop):
            task.cancel()
        if stop_event is not None:
            stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _shutdown)

    try:
        loop.run_until_complete(
            run_agent(
                args.gateway,
                args.vehicle_id,
                args.token or "",
                args.ws,
                args.key_refresh_s,
                mode=args.mode,
                casdoor_url=args.casdoor_url,
                casdoor_app=args.casdoor_app,
                casdoor_org=args.casdoor_org,
                device_secret=args.device_secret,
                backend_token_url=args.backend_token_url,
                livekit_url=args.livekit_url,
                publish_video=bool(args.publish_video),
                camera_id=args.camera_id,
                load_key_file=args.load_key_file,
            )
        )

    except KeyboardInterrupt:
        logging.info("[MAIN] keyboard interrupt")
    finally:
        loop.close()


if __name__ == "__main__":
    main()
