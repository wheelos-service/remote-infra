#!/usr/bin/env python3
"""Disposable simulator acceptance: production Gateway/SDK + real LiveKit.

Requires the LiveKit-enabled C++ build, frontend npm dependencies, Docker and
either Go or the cached golang:1.24 image. Never connects to a vehicle.
"""

import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
CPP = ROOT / "apps/vehicle-edge-cpp"
spec = importlib.util.spec_from_file_location(
    "rtc_fixture", CPP / "tests/livekit_e2e.py"
)
rtc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rtc)


def main():
    binary = CPP / "build/control_chain_test"
    if not binary.is_file():
        raise RuntimeError("Build apps/vehicle-edge-cpp with EDGE_ENABLE_LIVEKIT=ON first")
    suffix = uuid.uuid4().hex[:12]
    livekit_name = "edge-control-rtc-" + suffix
    gateway_name = "edge-control-gateway-" + suffix
    port, tcp, udp = rtc.free_port(), rtc.free_port(), rtc.free_port()
    gateway_process = signer = None
    livekit = False
    with tempfile.TemporaryDirectory(prefix="edge-control-chain-") as directory:
        work = pathlib.Path(directory)
        log_path = work / "gateway.log"
        fixture_path = work / "gateway.json"
        with log_path.open("w+") as log:
            try:
                subprocess.run([
                    "docker", "run", "--rm", "-d", "--name", livekit_name,
                    "--network", "host", rtc.IMAGE, "--dev", "--bind", "127.0.0.1",
                    "--node-ip", "127.0.0.1", "--port", str(port),
                    "--rtc.tcp_port", str(tcp), "--udp-port", str(udp),
                    "--keys", rtc.KEY + ": " + rtc.SECRET,
                ], check=True, stdout=subprocess.DEVNULL)
                livekit = True
                for _ in range(100):
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{port}", timeout=0.2):
                            break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise RuntimeError("LiveKit fixture did not become ready")
                if shutil.which("go"):
                    env = {**os.environ, "CONTROL_CHAIN_FIXTURE": str(fixture_path)}
                    command = ["go", "test", "./internal/gateway", "-run",
                               "^TestControlChainServer$", "-count=1", "-timeout=100s"]
                else:
                    cache = pathlib.Path(os.environ.get(
                        "CONTROL_CHAIN_GO_CACHE", CPP / "build/control-go-cache"
                    )).resolve()
                    cache.mkdir(parents=True, exist_ok=True)
                    env = None
                    command = [
                        "docker", "run", "--rm", "--name", gateway_name,
                        "--network", "host", "--user", f"{os.getuid()}:{os.getgid()}",
                        "-v", f"{ROOT}:/src:ro", "-v", f"{work}:/fixture",
                        "-v", f"{cache}:/cache", "-w", "/src/apps/teleop-gateway",
                        "-e", "GOCACHE=/cache/build", "-e", "GOMODCACHE=/cache/mod",
                        "-e", "CONTROL_CHAIN_FIXTURE=/fixture/gateway.json",
                        "golang:1.24", "go", "test", "./internal/gateway",
                        "-run", "^TestControlChainServer$", "-count=1", "-timeout=100s",
                    ]
                gateway_process = subprocess.Popen(
                    command, cwd=ROOT / "apps/teleop-gateway", env=env,
                    stdout=log, stderr=subprocess.STDOUT,
                )
                for _ in range(900):
                    if fixture_path.is_file():
                        gateway = json.loads(fixture_path.read_text())["gateway_url"]
                        break
                    if gateway_process.poll() is not None:
                        raise RuntimeError("Gateway fixture failed:\n" + log_path.read_text())
                    time.sleep(0.1)
                else:
                    raise RuntimeError("Gateway fixture readiness timed out:\n" + log_path.read_text())
                signer = subprocess.Popen(
                    ["node", "scripts/control-test-signer.mjs"], cwd=ROOT / "frontend",
                    stdout=subprocess.PIPE, text=True,
                )
                signer_url = json.loads(signer.stdout.readline())["signer_url"]
                with urllib.request.urlopen(signer_url + "/public", timeout=2) as response:
                    if not json.load(response)["public_key_b64"]:
                        raise RuntimeError("Frontend signer not responsive")
                config = {
                    "vehicle_id": "car-2", "gateway_url": gateway,
                    "token_url": gateway + "/oauth/token",
                    "client_id": "disposable-test-device",
                    "client_secret": "disposable-loopback-only",
                    "allow_insecure_localhost": True,
                    "media_enabled": True, "camera_source": "simulation",
                    "control_mode": "simulation",
                    "livekit_url": f"ws://127.0.0.1:{port}",
                    "media_worker_path": str(binary),
                }
                config_path = work / "device.json"
                config_path.write_text(json.dumps(config))
                config_path.chmod(0o600)
                subprocess.run([str(binary)], input=json.dumps({
                    "config": config, "config_path": str(config_path),
                    "signer_url": signer_url,
                }), text=True, timeout=40, check=True)
                pathlib.Path(str(fixture_path) + ".stop").touch()
                if gateway_process.wait(timeout=15) != 0:
                    raise RuntimeError("Gateway fixture failed:\n" + log_path.read_text())
            finally:
                pathlib.Path(str(fixture_path) + ".stop").touch()
                if signer:
                    signer.terminate()
                    signer.wait(timeout=5)
                if gateway_process and gateway_process.poll() is None:
                    try:
                        gateway_process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        if shutil.which("go"):
                            gateway_process.terminate()
                        else:
                            subprocess.run(["docker", "stop", "-t", "1", gateway_name],
                                           check=True, stdout=subprocess.DEVNULL)
                        gateway_process.wait(timeout=5)
                if livekit:
                    subprocess.run(["docker", "stop", "-t", "1", livekit_name],
                                   check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
