"""Single LiveKit connection with bounded command dispatch and reconnect."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Awaitable, Callable

CONTROL_TOPIC = "vehicle.control"


class LiveKitTransport:
    def __init__(
        self,
        url: str,
        token_provider: Callable[[], Awaitable[str]],
        on_command: Callable[[str, str], Awaitable[None]],
        on_lost: Callable[[str], Awaitable[None]],
        on_ready: Callable[[], None],
    ) -> None:
        self.url = url
        self.token_provider = token_provider
        self.on_command = on_command
        self.on_lost = on_lost
        self.on_ready = on_ready
        self._participant: Any = None
        self._connected_at: float | None = None

    async def send(self, payload: bytes, topic: str) -> None:
        if self._participant is None:
            raise ConnectionError("LiveKit is disconnected")
        try:
            await self._participant.publish_data(payload, reliable=False, topic=topic)
        except Exception as exc:
            raise ConnectionError("LiveKit data publication failed") from exc

    async def run(self, serve: Callable[[Any], Awaitable[None]]) -> None:
        from livekit import rtc

        backoff = 0.2
        while True:
            self._connected_at = None
            try:
                await self._connect(rtc, serve)
            except Exception:
                logging.warning("[LIVEKIT] connection interrupted; retrying")
            if self._connected_at is not None and time.monotonic() - self._connected_at > 5:
                backoff = 0.2
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 5)

    async def _connect(self, rtc: Any, serve: Callable[[Any], Awaitable[None]]) -> None:
        room = rtc.Room()
        lost = asyncio.Event()
        commands: asyncio.Queue[tuple[str, str]] = asyncio.Queue(maxsize=1)
        tasks: list[asyncio.Task] = []
        accepting = False

        def on_data(data, participant=None, kind=None):
            if not accepting or lost.is_set():
                return
            topic = getattr(data, "topic", "") or ""
            if topic not in ("", CONTROL_TOPIC):
                return
            sender = participant or getattr(data, "participant", None)
            identity = str(getattr(sender, "identity", ""))
            if not identity.startswith("operator-"):
                return
            raw = getattr(data, "data", data)
            if not isinstance(raw, (bytes, bytearray, str)) or len(raw) > 4096:
                return
            try:
                message = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
            except UnicodeDecodeError:
                return
            if commands.full():
                commands.get_nowait()
            commands.put_nowait((message, identity))

        async def dispatch():
            while True:
                message, identity = await commands.get()
                if not lost.is_set():
                    await self.on_command(message, identity)

        room.on("data_received", on_data)
        room.on("disconnected", lambda *args: lost.set())
        room.on("reconnecting", lambda *args: lost.set())
        try:
            token = await self.token_provider()
            await asyncio.wait_for(
                room.connect(self.url, token, rtc.RoomOptions(dynacast=True)), 15)
            if not lost.is_set():
                accepting = True
                self._connected_at = time.monotonic()
                self._participant = room.local_participant
                self.on_ready()
                logging.info("[LIVEKIT] connected")
                tasks = [
                    asyncio.create_task(dispatch()),
                    asyncio.create_task(serve(room.local_participant)),
                    asyncio.create_task(lost.wait()),
                ]
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    await task
        finally:
            accepting = False
            self._participant = None
            # Stop control before awaiting media/network cleanup.
            await self.on_lost("LiveKit connection lost")
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            try:
                await asyncio.wait_for(room.disconnect(), 3)
            except Exception:
                logging.warning("[LIVEKIT] disconnect cleanup failed")
