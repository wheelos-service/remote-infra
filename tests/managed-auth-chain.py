#!/usr/bin/env python3
"""Disposable PostgreSQL + pinned LiveKit signaling/drain acceptance.

Runs the real 11-minute refresh-token quiet interval. No media or vehicle
actuation is enabled. Never uses the running Compose stack or production IdP.
"""

import os
import pathlib
import shutil
import socket
import subprocess
import time
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
LIVEKIT = "livekit/livekit-server:v1.13.11"


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def main():
    suffix = uuid.uuid4().hex[:12]
    database = "managed-auth-db-" + suffix
    livekit = "managed-auth-rtc-" + suffix
    runner = "managed-auth-go-" + suffix
    started = []
    try:
        subprocess.run([
            "docker", "run", "--rm", "-d", "--name", database,
            "-e", "POSTGRES_PASSWORD=disposable-loopback-only",
            "-e", "POSTGRES_DB=managed_test", "-p", "127.0.0.1::5432",
            "postgres:16-alpine",
        ], check=True, stdout=subprocess.DEVNULL)
        started.append(database)
        port = subprocess.check_output(
            ["docker", "port", database, "5432/tcp"], text=True
        ).strip().rsplit(":", 1)[1]
        for _ in range(100):
            probe = subprocess.run(
                ["docker", "exec", database, "pg_isready", "-U", "postgres",
                 "-d", "managed_test"], capture_output=True, check=False,
            )
            if probe.returncode == 0:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("disposable PostgreSQL did not become ready")
        http, tcp, udp = free_port(), free_port(), free_port()
        subprocess.run([
            "docker", "run", "--rm", "-d", "--name", livekit,
            "--network", "host", LIVEKIT, "--dev", "--bind", "127.0.0.1",
            "--node-ip", "127.0.0.1", "--port", str(http),
            "--rtc.tcp_port", str(tcp), "--udp-port", str(udp),
            "--keys", "managed-rtc-test: disposable-managed-rtc-only-test-secret",
        ], check=True, stdout=subprocess.DEVNULL)
        started.append(livekit)
        url = f"http://127.0.0.1:{http}"
        for _ in range(100):
            try:
                with urllib.request.urlopen(url, timeout=0.2):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("disposable LiveKit did not become ready")
        env = {
            **os.environ,
            "AUTHZ_POSTGRES_TEST_DSN":
                f"postgres://postgres:disposable-loopback-only@127.0.0.1:{port}/managed_test?sslmode=disable",
            "MANAGED_RTC_TEST_URL": url,
        }
        test = ["go", "test", "-mod=readonly", "-p", "1",
                "./internal/gateway", "-run", "^TestManagedRealLiveKitSignalingAndDrain$",
                "-count=1", "-v", "-timeout=15m"]
        if shutil.which("go"):
            command = test
        else:
            cache = ROOT / "apps/vehicle-edge-cpp/build/managed-auth-go-cache"
            cache.mkdir(parents=True, exist_ok=True)
            command = [
                "docker", "run", "--rm", "--name", runner, "--network", "host",
                "--user", f"{os.getuid()}:{os.getgid()}",
                "-v", f"{ROOT}:/src:ro", "-v", f"{cache}:/cache",
                "-e", "GOCACHE=/cache/build", "-e", "GOMODCACHE=/cache/mod",
                "-e", "AUTHZ_POSTGRES_TEST_DSN", "-e", "MANAGED_RTC_TEST_URL",
                "-w", "/src/apps/teleop-gateway", "golang:1.24", *test,
            ]
            started.append(runner)
        subprocess.run(command, cwd=ROOT / "apps/teleop-gateway",
                       env=env, check=True, timeout=950)
    finally:
        for name in reversed(started):
            # Only exact, uniquely named containers created by this invocation.
            present = subprocess.check_output([
                "docker", "container", "ls", "-a", "--filter", f"name=^/{name}$",
                "--format", "{{.ID}}",
            ], text=True, timeout=15).strip()
            if present:
                subprocess.run(["docker", "stop", "-t", "1", name],
                               stdout=subprocess.DEVNULL, check=True, timeout=15)


if __name__ == "__main__":
    main()
