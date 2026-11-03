#!/usr/bin/env python3
"""Isolated browser + Gateway + C++ three-camera simulator acceptance."""

import functools
import http.server
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
CPP = ROOT / "apps/vehicle-edge-cpp"
spec = importlib.util.spec_from_file_location("rtc_fixture", CPP / "tests/livekit_e2e.py")
rtc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rtc)


def main():
    binary = CPP / "build/control_chain_test"
    if not binary.is_file() or not (ROOT / "frontend/dist/main.js").is_file():
        raise RuntimeError("Build the LiveKit-enabled C++ SDK and frontend first")
    name = "edge-driving-ui-" + uuid.uuid4().hex[:12]
    port, tcp, udp = rtc.free_port(), rtc.free_port(), rtc.free_port()
    gateway_process = vehicle = server = None
    requests = []
    started = False
    with tempfile.TemporaryDirectory(prefix="edge-driving-ui-") as directory:
        work = pathlib.Path(directory)
        fixture = work / "gateway.json"
        with (work / "gateway.log").open("w+") as gateway_log, (work / "vehicle.log").open("w+") as vehicle_log:
            try:
                subprocess.run([
                    "docker", "run", "--rm", "-d", "--name", name, "--network", "host",
                    rtc.IMAGE, "--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1",
                    "--port", str(port), "--rtc.tcp_port", str(tcp), "--udp-port", str(udp),
                    "--keys", rtc.KEY + ": " + rtc.SECRET,
                ], check=True, stdout=subprocess.DEVNULL)
                started = True
                for _ in range(150):
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{port}", timeout=0.2):
                            break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise RuntimeError("LiveKit fixture readiness timed out")
                if shutil.which("go"):
                    command = ["go", "test", "./internal/gateway", "-run",
                               "^TestControlChainServer$", "-count=1", "-timeout=100s"]
                    env = {**os.environ, "CONTROL_CHAIN_FIXTURE": str(fixture)}
                else:
                    cache = CPP / "build/control-go-cache"
                    cache.mkdir(parents=True, exist_ok=True)
                    subprocess.run([
                        "docker", "run", "--rm",
                        "--user", f"{os.getuid()}:{os.getgid()}",
                        "-v", f"{ROOT}:/src:ro", "-v", f"{work}:/fixture", "-v", f"{cache}:/cache",
                        "-w", "/src/apps/teleop-gateway", "-e", "GOCACHE=/cache/build",
                        "-e", "GOMODCACHE=/cache/mod",
                        "golang:1.24", "go", "test", "-c", "./internal/gateway",
                        "-o", "/cache/driving-gateway.test",
                    ], check=True, timeout=300)
                    command = [str(cache / "driving-gateway.test"), "-test.run=^TestControlChainServer$", "-test.timeout=100s"]
                    env = {**os.environ, "CONTROL_CHAIN_FIXTURE": str(fixture)}
                gateway_process = subprocess.Popen(command, cwd=ROOT / "apps/teleop-gateway",
                                                   env=env, stdout=gateway_log, stderr=subprocess.STDOUT)
                for _ in range(1800):
                    if fixture.is_file():
                        gateway = json.loads(fixture.read_text())["gateway_url"]
                        break
                    if gateway_process.poll() is not None:
                        raise RuntimeError("Gateway fixture failed:\n" + (work / "gateway.log").read_text())
                    time.sleep(0.1)
                else:
                    raise RuntimeError("Gateway fixture startup timed out:\n" + (work / "gateway.log").read_text())

                class Handler(http.server.SimpleHTTPRequestHandler):
                    def log_message(self, *_args):
                        requests.append(self.path.split("?")[0])

                    def proxy(self):
                        body = self.rfile.read(int(self.headers.get("Content-Length", 0))) if self.command == "POST" else None
                        request = urllib.request.Request(gateway + self.path, data=body,
                            headers={key: self.headers[key] for key in ("Authorization", "Content-Type") if key in self.headers},
                            method=self.command)
                        try:
                            response = urllib.request.urlopen(request, timeout=5)
                        except urllib.error.HTTPError as error:
                            response = error
                        with response:
                            data = response.read()
                            self.send_response(response.status)
                            self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
                            self.send_header("Cache-Control", "no-store")
                            self.send_header("Content-Length", str(len(data)))
                            self.end_headers()
                            self.wfile.write(data)

                    def do_GET(self):
                        if self.path.startswith("/api/"):
                            self.proxy()
                        else:
                            super().do_GET()

                    def do_POST(self):
                        self.proxy()

                server = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
                    functools.partial(Handler, directory=str(ROOT / "frontend/dist")))
                threading.Thread(target=server.serve_forever, daemon=True).start()
                origin = f"http://localhost:{server.server_port}"
                with urllib.request.urlopen(origin + "/", timeout=3) as response:
                    if response.status != 200:
                        raise RuntimeError("Frontend fixture is not responsive")
                config = {
                    "vehicle_id": "car-2", "gateway_url": gateway, "token_url": gateway + "/oauth/token",
                    "client_id": "disposable-test-device", "client_secret": "disposable-loopback-only",
                    "allow_insecure_localhost": True, "media_enabled": True,
                    "camera_source": "simulation", "camera_layout": "three", "control_mode": "simulation",
                    "livekit_url": f"ws://127.0.0.1:{port}", "media_worker_path": str(binary),
                }
                config_path = work / "device.json"
                config_path.write_text(json.dumps(config))
                config_path.chmod(0o600)
                vehicle = subprocess.Popen([str(binary), "--serve"], stdin=subprocess.PIPE,
                                           stdout=vehicle_log, stderr=subprocess.STDOUT, text=True)
                vehicle.stdin.write(json.dumps({"config": config, "config_path": str(config_path)}) + "\n")
                vehicle.stdin.flush()
                url = origin + f"/?dev=1&control=simulation&backend={origin}&livekit=ws://127.0.0.1:{port}#/teleop"
                browser_env = {**os.environ, "DRIVING_UI_URL": url}
                # Chrome's Unix singleton socket cannot use long repository scratch paths.
                browser_env.pop("TMPDIR", None)
                browser = subprocess.Popen(["node", "scripts/test-driving-ui.mjs"], cwd=ROOT / "frontend",
                                           env=browser_env)
                try:
                    if browser.wait(timeout=70) != 0:
                        raise RuntimeError("Browser driving acceptance failed")
                except subprocess.TimeoutExpired:
                    browser.terminate()
                    browser.wait(timeout=5)
                    raise
                pathlib.Path(str(fixture) + ".stop").touch()
                if gateway_process.wait(timeout=15) != 0:
                    raise RuntimeError("Gateway fixture failed")
            except Exception:
                print("Frontend fixture requests:", requests)
                print((work / "vehicle.log").read_text()[-8000:])
                print((work / "gateway.log").read_text()[-4000:])
                raise
            finally:
                pathlib.Path(str(fixture) + ".stop").touch()
                if vehicle and vehicle.poll() is None:
                    vehicle.stdin.close()
                    try:
                        vehicle.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        vehicle.terminate()
                        vehicle.wait(timeout=5)
                if gateway_process and gateway_process.poll() is None:
                    try:
                        gateway_process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        gateway_process.terminate()
                        gateway_process.wait(timeout=5)
                if server:
                    server.shutdown()
                    server.server_close()
                if started:
                    subprocess.run(["docker", "stop", "-t", "1", name], check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
