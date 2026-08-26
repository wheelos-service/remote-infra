"""Vehicle OAuth client credentials and short-lived access token management."""

from __future__ import annotations

import asyncio
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Protocol

import aiohttp
import yaml


class DeviceCredentialProvider(Protocol):
    def load(self) -> "DeviceCredentials": ...


@dataclass(frozen=True)
class DeviceCredentials:
    vehicle_id: str
    client_id: str
    client_secret: str
    token_url: str
    audience: Optional[str] = None
    scope: Optional[str] = None


class FileDeviceCredentialProvider:
    """Reads client credentials from a root-owned, mode-0600 YAML file."""

    def __init__(self, path: str = "/etc/teleop/device.yaml") -> None:
        self.path = Path(path)

    def load(self) -> DeviceCredentials:
        metadata = self.path.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise RuntimeError("device credential path must be a regular file")
        if stat.S_IMODE(metadata.st_mode) != 0o600:
            raise RuntimeError("device credential file must use mode 0600")
        if metadata.st_uid != 0:
            raise RuntimeError("device credential file must be owned by root")
        try:
            data = yaml.safe_load(self.path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError) as exc:
            raise RuntimeError("device credential file must contain valid YAML") from exc
        if not isinstance(data, dict):
            raise RuntimeError("device credential file must contain a mapping")
        required = ("vehicle_id", "client_id", "client_secret", "token_url")
        if not all(isinstance(data.get(field), str) and data[field] for field in required):
            raise RuntimeError("device credential file is missing required values")
        return DeviceCredentials(
            vehicle_id=data["vehicle_id"],
            client_id=data["client_id"],
            client_secret=data["client_secret"],
            token_url=data["token_url"],
            audience=data.get("audience"),
            scope=data.get("scope"),
        )


class VehicleTokenManager:
    def __init__(self, credentials: DeviceCredentials, refresh_before_seconds: int = 300) -> None:
        if refresh_before_seconds <= 0:
            raise ValueError("refresh_before_seconds must be positive")
        self.credentials = credentials
        self.refresh_before_seconds = refresh_before_seconds
        self._access_token: Optional[str] = None
        self._expires_at = 0.0

    @property
    def access_token(self) -> str:
        if self._access_token is None:
            raise RuntimeError("vehicle access token is not available")
        return self._access_token

    async def refresh(self, session: aiohttp.ClientSession) -> str:
        payload: dict[str, str] = {
            "grant_type": "client_credentials",
            "client_id": self.credentials.client_id,
            "client_secret": self.credentials.client_secret,
        }
        if self.credentials.audience:
            payload["audience"] = self.credentials.audience
        if self.credentials.scope:
            payload["scope"] = self.credentials.scope
        async with session.post(self.credentials.token_url, data=payload, timeout=5) as response:
            if response.status != 200:
                raise RuntimeError(f"vehicle token request failed: {response.status}")
            body: dict[str, Any] = await response.json()
        token = body.get("access_token")
        expires_in = body.get("expires_in")
        if not isinstance(token, str) or not token or not isinstance(expires_in, (int, float)) or expires_in <= self.refresh_before_seconds:
            raise RuntimeError("token endpoint returned an invalid or too-short-lived token")
        self._access_token = token
        self._expires_at = time.monotonic() + float(expires_in)
        return token

    async def refresh_loop(self, session: aiohttp.ClientSession, on_refresh) -> None:
        while True:
            delay = max(1, self._expires_at - time.monotonic() - self.refresh_before_seconds)
            await asyncio.sleep(delay)
            try:
                await on_refresh(await self.refresh(session))
            except asyncio.CancelledError:
                raise
            except Exception:
                # Retain the current valid token and retry before it expires.
                remaining = self._expires_at - time.monotonic()
                await asyncio.sleep(30 if remaining > 30 else max(1, remaining))