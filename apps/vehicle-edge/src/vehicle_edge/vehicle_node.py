"""Vehicle agent configuration, task orchestration and lifecycle."""

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
from .cyber_bridge import CyberBridge, CyberOptions
from .device_credentials import FileDeviceCredentialProvider, VehicleTokenManager
from .livekit_transport import LiveKitTransport
from .secure_receiver import EmergencyBrakeController
from .state_publisher import StatePublisher
from .video_publisher import LiveKitVideoPublisher


async def _periodic_session_refresh(runtime: SessionVehicleRuntime, session: aiohttp.ClientSession, interval_s: int = 1) -> None:
    while True:
        try:
            await runtime.refresh_session(session)
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


async def _serve_room(
    participant: Any,
    camera_options: CameraOptions,
    state_publisher: Optional[StatePublisher],
    transport: LiveKitTransport,
) -> None:
    video_publisher = None
    tasks = []

    try:
        if state_publisher is not None:
            tasks.append(asyncio.create_task(state_publisher.run(transport.send)))
        if camera_options.layout is not CameraLayout.OFF:
            from livekit import rtc

            video_publisher = LiveKitVideoPublisher(rtc, participant)
            await video_publisher.start(camera_options)

        async def collect_video():
            while True:
                if video_publisher is not None:
                    await video_publisher.collect_finished()
                await asyncio.sleep(1)

        tasks.append(asyncio.create_task(collect_video()))
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if video_publisher is not None:
            await video_publisher.close()


async def run_agent(
    gateway: str,
    vehicle_id: str,
    device_config: str = "/etc/teleop/device.yaml",
    backend_token_url: Optional[str] = None,
    livekit_url: Optional[str] = None,
    auth_token: Optional[str] = None,
    camera_options: CameraOptions = CameraOptions(),
    cyber_options: CyberOptions = CyberOptions(),
) -> None:
    if cyber_options.control_enabled and not cyber_options.enabled:
        raise ValueError("Cyber control requires Cyber monitoring to be enabled")
    cyber_bridge = CyberBridge(cyber_options) if cyber_options.enabled else None
    brake = cyber_bridge if cyber_bridge is not None else EmergencyBrakeController()
    verifier = SessionCommandVerifier(gateway, vehicle_id, "")
    runtime = SessionVehicleRuntime(
        verifier, brake, control_enabled=cyber_bridge is None or cyber_options.control_enabled)
    runtime.connected = False

    async with aiohttp.ClientSession() as session:
        token_manager: Optional[VehicleTokenManager] = None
        try:
            if auth_token:
                verifier.auth_token = auth_token
            else:
                credentials = FileDeviceCredentialProvider(device_config).load()
                if credentials.vehicle_id != vehicle_id:
                    raise RuntimeError("device credential vehicle_id does not match --vehicle-id")
                token_manager = VehicleTokenManager(credentials)
                verifier.auth_token = await token_manager.refresh(session)
        except Exception as exc:
            logging.error("[INIT] failed to obtain vehicle credentials: %s", exc)
            return

        # Session expiry is locally enforced even while refresh retries.
        try:
            await runtime.refresh_session(session)
            logging.info("[INIT] active control session loaded")
        except Exception as exc:
            logging.warning("[INIT] initial session refresh failed: %s", exc)

        async def _replace_auth_token(refreshed_token: str) -> None:
            verifier.auth_token = refreshed_token

        async def token_provider() -> str:
            return await request_livekit_token(
                session, backend_token_url or gateway.rstrip("/") + "/api/token/vehicle",
                verifier.auth_token, vehicle_id)

        transport = LiveKitTransport(
            livekit_url or "", token_provider, runtime.on_datachannel_message,
            runtime.transport_lost, runtime.transport_ready)
        state_publisher = (
            StatePublisher(cyber_bridge, runtime.control_status, vehicle_id)
            if cyber_bridge is not None else None)

        async def serve(participant: Any) -> None:
            await _serve_room(participant, camera_options, state_publisher, transport)

        if cyber_bridge is not None:
            cyber_bridge.start()
        tasks = [
            asyncio.create_task(_periodic_session_refresh(runtime, session)),
        ]
        if token_manager is not None:
            tasks.append(asyncio.create_task(token_manager.refresh_loop(session, _replace_auth_token)))
        # start watchdog
        tasks.append(asyncio.create_task(runtime.safety_watchdog()))
        # start telemetry reporting
        tasks.append(asyncio.create_task(
            runtime.telemetry_loop(gateway, vehicle_id, session)))
        tasks.append(asyncio.create_task(runtime.audit_loop(gateway, session)))
        tasks.append(asyncio.create_task(transport.run(serve)))

        # run until cancelled
        try:
            await asyncio.gather(*tasks)
        except asyncio.CancelledError:
            logging.info("[AGENT] shutdown requested")
        finally:
            runtime.running = False
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if cyber_bridge is not None:
                cyber_bridge.close()


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
    p.add_argument("--cyber", action="store_true",
                   help="Subscribe to WheelOS localization/chassis and publish vehicle.state")
    p.add_argument("--cyber-control", action="store_true",
                   help="Enable verified control_cmd publishing (requires --cyber)")
    p.add_argument("--cyber-node-name", default="teleop_vehicle")
    p.add_argument("--cyber-localization-channel", default="/apollo/localization/pose")
    p.add_argument("--cyber-chassis-channel", default="/apollo/canbus/chassis")
    p.add_argument("--cyber-control-channel", default="/apollo/control")
    args = p.parse_args()
    if args.cyber_control and not args.cyber:
        p.error("--cyber-control requires --cyber")
    return args


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
                cyber_options=CyberOptions(
                    enabled=args.cyber,
                    control_enabled=args.cyber_control,
                    node_name=args.cyber_node_name,
                    localization_channel=args.cyber_localization_channel,
                    chassis_channel=args.cyber_chassis_channel,
                    control_channel=args.cyber_control_channel,
                ),
            )
        )

    except KeyboardInterrupt:
        logging.info("[MAIN] keyboard interrupt")
    finally:
        loop.close()


if __name__ == "__main__":
    main()
