#!/usr/bin/env python3
"""Paste public dashboard setup data, preserve installed state, then enroll."""

import argparse
import json
import os
from pathlib import Path
import stat
import sys
import urllib.parse


class SetupError(Exception):
    pass


FIELDS = {"gateway_url", "console_url", "name", "serial", "platform"}
BOOTSTRAP_DEFAULTS = {
    "state_directory": "/var/lib/teleop/bootstrap",
    "device_template": "/etc/teleop/device.template.json",
    "device_config": "/etc/teleop/device.json",
    "allow_insecure_localhost": False,
    "allow_legacy_complete_404": False,
}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise SetupError("duplicate setup field")
        result[key] = value
    return result


def validate(value):
    if not isinstance(value, dict) or set(value) not in (FIELDS, FIELDS | BOOTSTRAP_DEFAULTS.keys()):
        raise SetupError("expected public vehicle setup or the dashboard bootstrap JSON")
    for field, expected in BOOTSTRAP_DEFAULTS.items():
        if field in value and (type(value[field]) is not type(expected) or value[field] != expected):
            raise SetupError("bootstrap paths and safety flags must use the standard defaults")
    result = {}
    for field in FIELDS:
        text = value[field]
        limit = 2048 if field.endswith("_url") else 200 if field == "name" else 128
        if (not isinstance(text, str) or (not text.strip() and field != "serial")
                or len(text.encode("utf-8")) > limit
                or any(ord(c) < 32 or ord(c) == 127 for c in text)):
            raise SetupError("missing, invalid or overlong setup field")
        text = text.strip()
        if field.endswith("_url"):
            try:
                url = urllib.parse.urlsplit(text)
                port = url.port
                if (url.scheme != "https" or not url.hostname or url.username is not None
                        or url.password is not None or url.query or url.fragment
                        or "?" in text or "#" in text or any(c.isspace() for c in text)
                        or port == 0):
                    raise ValueError()
            except ValueError:
                raise SetupError("setup endpoints must be HTTPS without credentials, query or fragment") from None
            text = text.rstrip("/")
        result[field] = text
    return result


def directory(path):
    """Validate each component before creating a child; never follow symlinks."""
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise SetupError("protected directories must be absolute without parent traversal")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            current.mkdir(mode=0o700)
        except FileExistsError:
            pass
        info = current.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.geteuid())
                or stat.S_IMODE(info.st_mode) & 0o022):
            raise SetupError("protected directory has unsafe ownership, permissions or symlink")
    return path


def read(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or info.st_size > 65536):
            raise SetupError("existing setup file must be owner-only mode 0600 with one link")
        try:
            return json.loads(stream.read(65537), object_pairs_hook=unique_object)
        except (ValueError, UnicodeError):
            raise SetupError("existing setup file is invalid JSON") from None


def create(path, value):
    # Never replace a config, template, key, enrollment state or credential file.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def prepare(value, config_dir=Path("/etc/teleop"), state_dir=Path("/var/lib/teleop/bootstrap")):
    public = validate(value)
    config_dir, state_dir = directory(config_dir), directory(state_dir)
    config = config_dir / "bootstrap.json"
    template = config_dir / "device.template.json"
    device = config_dir / "device.json"
    expected = {**public, "state_directory": str(state_dir),
                "device_template": str(template), "device_config": str(device),
                "allow_insecure_localhost": False, "allow_legacy_complete_404": False}
    existing = read(config)
    if existing is not None and existing != expected:
        raise SetupError("existing bootstrap settings differ; review them at a maintenance stop, no file was replaced")
    # Leave credential parsing and identity checks to the hardened SDK. This
    # helper only needs to know whether an existing installation is present.
    if device.exists() or device.is_symlink():
        info = device.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            raise SetupError("existing device file has unsafe ownership, permissions or links")
        print("Existing device credentials preserved; bootstrap checks their current identity first.")
    if read(template) is None:
        create(template, {"control_mode": "disabled", "media_enabled": False, "task_mode": "disabled"})
    if existing is None:
        create(config, expected)
    return config


def public_input():
    print("Paste the bootstrap JSON from the dashboard, then press Enter.")
    print("Or press Enter to type the five public fields. Do not paste credentials.")
    line = sys.stdin.readline(8193)
    if len(line) > 8192:
        raise SetupError("setup input exceeds 8 KiB")
    if line == "":
        raise SetupError("no setup input received")
    if line.strip():
        while True:
            try:
                return json.loads(line, object_pairs_hook=unique_object)
            except (ValueError, UnicodeError):
                if not line.lstrip().startswith("{"):
                    raise SetupError("invalid setup JSON") from None
                extra = sys.stdin.readline(8193 - len(line))
                line += extra
                if not extra or len(line) > 8192:
                    raise SetupError("invalid setup JSON or input exceeds 8 KiB") from None
    gateway = input("Gateway HTTPS URL: ").strip()
    return {"gateway_url": gateway,
            "console_url": input("Console HTTPS URL [same as Gateway]: ").strip() or gateway,
            "name": input("Vehicle name: ").strip(), "serial": input("Vehicle serial: ").strip(),
            "platform": input("Platform [apollo]: ").strip() or "apollo"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-only", action="store_true", help="save setup without starting enrollment")
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        raise SetupError("run with sudo inside the Apollo runtime container")
    os.umask(0o077)
    binary = Path("/usr/local/libexec/vehicle_bootstrap")
    info = binary.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
            or info.st_mode & 0o022 or not os.access(binary, os.X_OK)):
        raise SetupError("install the root-owned vehicle_bootstrap executable from the vehicle setup guide first")
    config = prepare(public_input())
    print("Setup saved. Enrollment requires trusted HTTPS and administrator approval.", flush=True)
    if not args.prepare_only:
        os.execv(str(binary), [str(binary), "--config", str(config)])


if __name__ == "__main__":
    try:
        main()
    except SetupError as error:
        print(f"Vehicle setup: {error}", file=sys.stderr)
        sys.exit(1)
    except (OSError, EOFError, UnicodeError):
        # Avoid echoing pasted values, credential contents or raw OS exceptions.
        print("Vehicle setup failed. Check the five public fields, existing protected settings, "
              "file permissions and installed bootstrap binary. No existing file is replaced.", file=sys.stderr)
        sys.exit(1)
