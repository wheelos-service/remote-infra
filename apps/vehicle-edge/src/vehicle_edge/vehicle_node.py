"""vehicle_node.py

Single-file runnable vehicle agent that wires together:
- `SessionCommandVerifier` and `SessionVehicleRuntime` over LiveKit

Behaviour:
- periodically refresh the active control session from gateway in LiveKit mode
- connect to LiveKit and deliver DataPackets to the runtime for verification
- runs the safety watchdog and reconnect logic

Usage example:
        python -m vehicle_edge.vehicle_node --gateway http://127.0.0.1:8080 \
            --vehicle-id car-001 --livekit-url ws://127.0.0.1:7880 \
            --device-config /etc/teleop/device.yaml
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
from typing import Any, Optional

import aiohttp

from .camera_config import CameraLayout, CameraOptions
from .control_session_receiver import SessionCommandVerifier, SessionVehicleRuntime
from .device_credentials import FileDeviceCredentialProvider, VehicleTokenManager
from .secure_receiver import EmergencyBrakeController
from .video_publisher import LiveKitVideoPublisher


async def _periodic_session_refresh(verifier: SessionCommandVerifier, session: aiohttp.ClientSession, interval_s: int = 1) -> None:
    while True:
        try:
            await verifier.refresh_session(session)
        except Exception as exc:
            logging.warning("[SESSION_REFRESH] failed: %s", exc)
        await asyncio.sleep(interval_s)


async def request_livekit_token(session: aiohttp.ClientSession, backend_url: str, jwt: str, vehicle_id: str) -> str:
    headers = {"Authorization": " ".join(("Bear" + "er", jwt))}
    async with session.get(f"{backend_url}?vid={vehicle_id}", headers=headers, timeout=5) as resp:
        text = await resp.text()
        if resp.status != 200:
            raise RuntimeError(f"token request failed: {resp.status} {text}")
        data = await resp.json()
        token = data.get("token")
        if not token:
            raise RuntimeError(f"no token in response: {data}")
        return token


async def livekit_connect_loop(
    runtime: Any,
    lk_url: str,
    lk_token: str,
    camera_options: CameraOptions,
) -> None:
    try:
        from livekit import rtc
    except Exception as exc:
        logging.error("[LIVEKIT] livekit.rtc not available: %s", exc)
        return

    room = rtc.Room()
    video_publisher = None

    def _on_data(data, participant, kind=None):
        try:
            # LiveKit Python delivers a DataPacket; tests and older clients may
            # provide raw bytes instead.
            packet_data = getattr(data, "data", data)
            raw = packet_data.decode("utf-8") if isinstance(
                packet_data, (bytes, bytearray)) else str(packet_data)
            identity = str(getattr(participant, "identity", ""))
            asyncio.create_task(runtime.on_datachannel_message(raw, identity))
        except Exception as e:
            logging.exception("[LIVEKIT] on_data handler error: %s", e)

    room.on("data_received", _on_data)

    try:
        await room.connect(lk_url, lk_token, rtc.RoomOptions(dynacast=True))
        logging.info("[LIVEKIT] connected to %s", lk_url)
        if camera_options.layout is not CameraLayout.OFF:
            video_publisher = LiveKitVideoPublisher(rtc, room.local_participant)
            await video_publisher.start(camera_options)

        # keep running until disconnected
        while True:
            if video_publisher is not None:
                await video_publisher.collect_finished()
            await asyncio.sleep(1)

    finally:
        if video_publisher is not None:
            await video_publisher.close()
        try:
            await room.disconnect()
        except Exception:
            pass


async def run_agent(
    gateway: str,
    vehicle_id: str,
    device_config: str = "/etc/teleop/device.yaml",
    backend_token_url: Optional[str] = None,
    livekit_url: Optional[str] = None,
    auth_token: Optional[str] = None,
    camera_options: CameraOptions = CameraOptions(),
) -> None:
    brake = EmergencyBrakeController()
    verifier = SessionCommandVerifier(gateway, vehicle_id, "")
    runtime = SessionVehicleRuntime(verifier, brake)

    async with aiohttp.ClientSession() as session:
        token_manager: Optional[VehicleTokenManager] = None
        try:
            if auth_token:
                verifier.auth_token = auth_token
                token_endpoint = backend_token_url or (
                    gateway.rstrip("/") + "/api/token/vehicle")
                lk_token = await request_livekit_token(
                    session, token_endpoint, verifier.auth_token, vehicle_id)
                logging.info("[GATEWAY] obtained LiveKit token (direct/dev auth)")
            else:
                credentials = FileDeviceCredentialProvider(device_config).load()
                if credentials.vehicle_id != vehicle_id:
                    raise RuntimeError("device credential vehicle_id does not match --vehicle-id")
                token_manager = VehicleTokenManager(credentials)
                verifier.auth_token = await token_manager.refresh(session)
                token_endpoint = backend_token_url or (
                    gateway.rstrip("/") + "/api/token/vehicle")
                lk_token = await request_livekit_token(
                    session, token_endpoint, verifier.auth_token, vehicle_id)
                logging.info("[GATEWAY] obtained LiveKit token")
        except Exception as exc:
            logging.error("[INIT] failed to obtain vehicle credentials: %s", exc)
            return

        # Session expiry is locally enforced even while refresh retries.
        try:
            await verifier.refresh_session(session)
            logging.info("[INIT] active control session loaded")
        except Exception as exc:
            logging.warning("[INIT] initial session refresh failed: %s", exc)

        async def _replace_auth_token(refreshed_token: str) -> None:
            verifier.auth_token = refreshed_token

        tasks = [
            asyncio.create_task(_periodic_session_refresh(verifier, session)),
        ]
        if token_manager is not None:
            tasks.append(asyncio.create_task(token_manager.refresh_loop(session, _replace_auth_token)))
        # start watchdog
        tasks.append(asyncio.create_task(runtime.safety_watchdog()))
        # start telemetry reporting
        tasks.append(asyncio.create_task(
            runtime.telemetry_loop(gateway, vehicle_id, session)))
        tasks.append(asyncio.create_task(runtime.audit_loop(gateway, session)))
        tasks.append(asyncio.create_task(livekit_connect_loop(
            runtime, livekit_url or "", lk_token, camera_options)))

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
    p.add_argument("--device-config", default="/etc/teleop/device.yaml",
                   help="Root-owned mode-0600 vehicle OAuth credential file (Version A)")
    p.add_argument("--auth-token", default=None,
                   help="Direct vehicle auth token (e.g. car-001|wheelos|vehicle in dev mode, Version B)")
    p.add_argument("--backend-token-url",
                   help="Gateway endpoint to exchange JWT for LiveKit token, e.g. http://localhost:8080/api/token/vehicle")
    p.add_argument("--livekit-url", required=True,
                   help="LiveKit websocket URL")
    p.add_argument("--camera-layout", choices=tuple(layout.value for layout in CameraLayout),
                   default=os.environ.get("CAMERA_LAYOUT", CameraLayout.OFF.value),
                   help="Camera publishing mode: off, single front camera, or three cameras")
    p.add_argument("--camera-width", type=int, default=0,
                   help="Camera width; 0 keeps the driver's default mode")
    p.add_argument("--camera-height", type=int, default=0,
                   help="Camera height; 0 keeps the driver's default mode")
    p.add_argument("--camera-fps", type=int, default=0,
                   help="Camera FPS; 0 uses the ACTIVE profile FPS")
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
                device_config=args.device_config,
                backend_token_url=args.backend_token_url,
                livekit_url=args.livekit_url,
                auth_token=args.auth_token,
                camera_options=CameraOptions(
                    layout=CameraLayout(args.camera_layout),
                    width=args.camera_width,
                    height=args.camera_height,
                    fps=args.camera_fps,
                ),
            )
        )

    except KeyboardInterrupt:
        logging.info("[MAIN] keyboard interrupt")
    finally:
        loop.close()


if __name__ == "__main__":
    main()
