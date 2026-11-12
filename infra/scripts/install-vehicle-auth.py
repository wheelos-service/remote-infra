#!/usr/bin/env python3
"""Retired mixed-config installer; use SDK vehicle_bootstrap instead."""

import json
import os
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request


class InstallationError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise InstallationError("redirect refused; check the configured endpoint")


def endpoint(value, allow_local=False):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.username or parsed.password or parsed.query or parsed.fragment
            or not parsed.hostname):
        raise InstallationError("endpoint must not contain credentials, query or fragment")
    if parsed.scheme != "https" and not (
        allow_local and parsed.scheme == "http"
        and parsed.hostname in ("127.0.0.1", "::1", "localhost")
    ):
        raise InstallationError("HTTPS is required (loopback HTTP needs explicit test opt-in)")
    return value.rstrip("/")


def protected_read(path):
    flags = os.O_RDONLY | os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except OSError:
        raise InstallationError("cannot open protected input file") from None
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or info.st_size > 65536):
            raise InstallationError("input must be an owner-only regular file, at most 64 KiB")
        return stream.read(65537)


def protected_write(path, config):
    # O_EXCL also rejects symlinks. Never overwrite an installed credential.
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except OSError:
        raise InstallationError("cannot create configuration; existing files are never overwritten") from None
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(config, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except OSError:
        raise InstallationError("configuration write failed; inspect the protected file before retrying") from None


def request(url, *, method="GET", token=None, body=None, form=False, expected=200):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    payload = None
    if body is not None:
        payload = (urllib.parse.urlencode(body) if form else json.dumps(body)).encode()
        headers["Content-Type"] = (
            "application/x-www-form-urlencoded" if form else "application/json"
        )
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as response:
            if response.status != expected:
                raise InstallationError("unexpected endpoint status")
            raw = response.read(65537)
            if len(raw) > 65536:
                raise InstallationError("endpoint response exceeded size limit")
            if expected == 204:
                return {}
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise InstallationError("endpoint returned an invalid object")
            return value
    except urllib.error.HTTPError as error:
        # Provider bodies can contain credentials. Never display them.
        correlation = error.headers.get("X-Request-ID", "")
        correlation = correlation if (
            0 < len(correlation) <= 128
            and all(char.isascii() and (char.isalnum() or char in "._-") for char in correlation)
        ) else ""
        raise InstallationError(
            f"endpoint rejected request (HTTP {error.code}, request_id={correlation or 'unavailable'})"
        ) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise InstallationError("endpoint transport failed; result may be unknown, do not blindly redeem again") from None
    except (ValueError, UnicodeError):
        raise InstallationError("endpoint returned invalid JSON") from None


def validate_config(value, vehicle_id, gateway, allow_local):
    if not isinstance(value, dict) or value.get("vehicle_id") != vehicle_id:
        raise InstallationError("configuration vehicle identity does not match the requested vehicle")
    required = ("vehicle_id", "gateway_url", "token_url", "client_id", "client_secret")
    for key in required:
        field = value.get(key)
        if (not isinstance(field, str) or not field or len(field) > 4096
                or any(ord(char) < 32 or ord(char) > 126 for char in field)):
            raise InstallationError("configuration is missing a valid required field")
    if endpoint(value["gateway_url"], allow_local) != gateway:
        raise InstallationError("configuration Gateway does not match the trusted installation endpoint")
    endpoint(value["token_url"], allow_local)
    result = {key: value[key] for key in required}
    result["control_mode"] = "disabled"
    result["task_mode"] = "disabled"
    result["media_enabled"] = False
    if allow_local:
        result["allow_insecure_localhost"] = True
    return result


def verify(config):
    grant = request(config["token_url"], method="POST", form=True, body={
        "grant_type": "client_credentials",
        "client_id": config["client_id"],
        "client_secret": config["client_secret"],
        "scope": "teleop:vehicle",
    })
    access = grant.get("access_token")
    if (not isinstance(access, str) or not access or len(access) > 32768
            or any(ord(char) <= 32 or ord(char) > 126 for char in access)):
        raise InstallationError("provider did not return a valid access token")
    gateway = config["gateway_url"].rstrip("/")
    identity = request(gateway + "/api/auth/me", token=access)
    if identity.get("Name") != config["vehicle_id"] or "vehicle" not in identity.get("Roles", []):
        raise InstallationError("Gateway returned a different vehicle identity")
    vehicle = urllib.parse.quote(config["vehicle_id"], safe="")
    request(gateway + f"/api/vehicles/{vehicle}/device-auth-check", token=access, expected=204)
    request(gateway + f"/api/vehicles/{vehicle}/installation-complete",
            method="POST", token=access, body={}, expected=204)


def main():
    raise InstallationError(
        "This mixed-configuration installer is retired. Use SDK "
        "vehicle_bootstrap --gateway-url HTTPS_URL and manual fingerprint approval; "
        "no credentials or runtime files were written."
    )
if __name__ == "__main__":
    try:
        main()
    except (InstallationError, ValueError, UnicodeError, OSError) as error:
        if isinstance(error, InstallationError):
            print(str(error), file=sys.stderr)
        else:
            print("Invalid protected configuration or local filesystem failure.", file=sys.stderr)
        sys.exit(1)
