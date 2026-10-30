#!/usr/bin/env python3
"""Isolated loopback RTC acceptance test; requires an existing Docker image."""

import base64
import hashlib
import hmac
import http.server
import json
import pathlib
import socket
import subprocess
import threading
import tempfile
import time
import urllib.request
import uuid


ROOT = pathlib.Path(__file__).resolve().parents[1]
IMAGE = "livekit/livekit-server@sha256:3497163e15c48fef6e7830c78716f9e9d5edc28abf7aa90b61c86e93bbc306b1"
# Isolated disposable test identities, never production credentials.
KEY = "edge-integration-test"
SECRET = "disposable-loopback-only-test-secret"


def token(identity, publish):
    def encode(value):
        return base64.urlsafe_b64encode(
            json.dumps(value, separators=(",", ":")).encode()
        ).rstrip(b"=")

    now = int(time.time())
    header = encode({"alg": "HS256", "typ": "JWT"})
    payload = encode({
        "iss": KEY, "sub": identity, "iat": now, "nbf": now - 1, "exp": now + 60,
        "video": {
            "room": "edge-integration", "roomJoin": True,
            "canPublish": publish, "canPublishData": publish, "canSubscribe": True,
        },
    })
    body = header + b"." + payload
    signature = base64.urlsafe_b64encode(
        hmac.new(SECRET.encode(), body, hashlib.sha256).digest()
    ).rstrip(b"=")
    return (body + b"." + signature).decode()


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class Gateway(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.path != "/oauth/token":
            self.send_error(404)
            return
        self.respond({"access_token": "disposable-device-token", "expires_in": 60})

    def do_GET(self):
        if self.path != "/api/token/vehicle":
            self.send_error(404)
            return
        if self.headers.get("Authorization") != "Bearer disposable-device-token":
            self.send_error(401)
            return
        self.respond({"token": token("vehicle-car-test", True)})


def main():
    name = "edge-sdk-test-" + uuid.uuid4().hex[:12]
    port, tcp, udp = free_port(), free_port(), free_port()
    gateway = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
    gateway_thread = threading.Thread(target=gateway.serve_forever)
    gateway_thread.start()
    container = None
    try:
        container = subprocess.check_output([
            "docker", "run", "--rm", "-d", "--name", name, "--network", "host",
            IMAGE, "--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1",
            "--port", str(port), "--rtc.tcp_port", str(tcp),
            "--udp-port", str(udp), "--keys", KEY + ": " + SECRET,
        ], text=True).strip()
        for _ in range(100):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}", timeout=0.2):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("isolated LiveKit server did not become ready")
        config = {
            "vehicle_id": "car-test",
            "gateway_url": f"http://127.0.0.1:{gateway.server_port}",
            "token_url": f"http://127.0.0.1:{gateway.server_port}/oauth/token",
            "client_id": "disposable-test-device",
            "client_secret": "disposable-loopback-test-value",
            "allow_insecure_localhost": True,
            "media_enabled": True, "camera_source": "simulation",
            "livekit_url": f"ws://127.0.0.1:{port}",
            "media_worker_path": str(ROOT / "build/vehicle_media_worker"),
        }
        subprocess.run(
            [str(ROOT / "build/livekit_integration_test")],
            input=json.dumps({"config": config, "mismatched_vehicle": True}),
            text=True, timeout=5, check=True,
        )
        subprocess.run(
            [str(ROOT / "build/livekit_integration_test")],
            input=json.dumps({"config": config, "observer_token": token("observer", False)}),
            text=True, timeout=25, check=True,
        )
        # Generate one independently decodable baseline AU, no camera/device.
        with tempfile.TemporaryDirectory(prefix="edge-encoded-fixture-") as directory:
            path = pathlib.Path(directory) / "frame.h264"
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                "-i", "testsrc2=size=640x480:rate=10", "-frames:v", "1",
                "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
                "-profile:v", "baseline", "-x264-params",
                "keyint=1:bframes=0:repeat-headers=1:aud=1", "-f", "h264", str(path),
            ], check=True, timeout=15)
            config["camera_source"] = "h264_annexb"
            subprocess.run(
                [str(ROOT / "build/livekit_integration_test")],
                input=json.dumps({
                    "config": config,
                    "observer_token": token("observer-encoded", False),
                    "encoded_frame": list(path.read_bytes()),
                }),
                text=True, timeout=25, check=True,
            )
    finally:
        gateway.shutdown()
        gateway.server_close()
        gateway_thread.join()
        if container:
            subprocess.run(["docker", "stop", "-t", "1", container],
                           stdout=subprocess.DEVNULL, check=True)


if __name__ == "__main__":
    main()
