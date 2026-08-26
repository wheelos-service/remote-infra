"""Demo runner: start a test WS server that sends signed commands and run the agent.

This script generates an Ed25519 keypair, writes a local registration JSON file,
starts a simple aiohttp WebSocket server that accepts the agent connection and
sends signed control messages at 100ms intervals. It then starts the agent
pointing at that WS and loads the local registration so CommandVerifier accepts
the messages.

Usage: python3 -m vehicle_edge.demo_run
"""

import asyncio
import base64
import json
import os
import tempfile
import time

from aiohttp import web, ClientSession, WSMsgType
from nacl.signing import SigningKey

from .vehicle_node import run_agent


async def ws_server(app_queue: asyncio.Queue, host="127.0.0.1", port=9001):
    async def ws_handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await app_queue.put(ws)
        # keep connection open until closed by client
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                break
        return ws

    app = web.Application()
    app.router.add_get("/ws", ws_handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    return runner


async def producer_loop(app_queue: asyncio.Queue, sign_key: SigningKey):
    seq = 1
    while True:
        ws = None
        try:
            ws = await asyncio.wait_for(app_queue.get(), timeout=1.0)
        except asyncio.TimeoutError:
            await asyncio.sleep(0.05)
            continue

        try:
            while not ws.closed:
                payload = {
                    "vehicle_id": "car-001",
                    "key_id": "demo-key-1",
                    "cmd": "steer",
                    "val": 12.3,
                    "seq": seq,
                    "ts": int(time.time() * 1000),
                    "alg": "Ed25519",
                }
                sign_msg = f"{payload['vehicle_id']}|{payload['key_id']}|{payload['cmd']}|{payload['val']}|{payload['seq']}|{payload['ts']}"
                signature = sign_key.sign(sign_msg.encode("utf-8")).signature
                payload["sig"] = base64.b64encode(signature).decode("utf-8")
                await ws.send_str(json.dumps(payload))
                seq += 1
                await asyncio.sleep(0.1)
        except Exception:
            pass


async def main():
    # generate keypair
    sk = SigningKey.generate()
    pk = sk.verify_key
    pub_b64 = base64.b64encode(bytes(pk)).decode("utf-8")

    reg = {
        "vehicle_id": "car-001",
        "operator_id": "demo-op",
        "key_id": "demo-key-1",
        "public_key_b64": pub_b64,
        "expires_at_ms": 9999999999999,
    }

    tmpdir = tempfile.mkdtemp(prefix="teleop-demo-")
    reg_file = os.path.join(tmpdir, "reg.json")
    with open(reg_file, "w") as f:
        json.dump(reg, f)

    app_queue: asyncio.Queue = asyncio.Queue()
    runner = await ws_server(app_queue)

    producer = asyncio.create_task(producer_loop(app_queue, sk))

    # run agent in same loop
    agent_task = asyncio.create_task(
        run_agent(
            gateway="http://127.0.0.1:8080",
            vehicle_id="car-001",
            token="demo-token",
            ws_url="ws://127.0.0.1:9001/ws",
            key_refresh_s=10,
            mode="ws",
            load_key_file=reg_file,
        )
    )

    try:
        await asyncio.gather(agent_task, producer)
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
