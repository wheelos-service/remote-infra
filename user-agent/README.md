User Agent (Operator Web UI)
=================================

This folder contains a standalone version of the operator web UI (originally under `tools/index.html`).

Goals:
- Run the UI as a static site for manual testing or as an embedded user-agent in a browser kiosk.
- Make runtime configuration easy via URL query parameters so the page can be reused across environments.

Usage
-----

Run a simple static server and open the page with query parameters to set backend/livekit/Casdoor endpoints.

Example (serve locally):

```bash
# from repo root
cd user-agent
./serve.sh
# open in browser:
# http://127.0.0.1:8000/?backend=http://host:8080&livekit=ws://host:7880&casdoor=https://casdoor.example.com
```

Query parameters
- `backend` - URL to Teleop Gateway (default: `http://localhost:8080`)
- `livekit` - LiveKit server URL (default: `ws://localhost:7880`)
- `casdoor` - Casdoor server base URL
- `clientId`, `org`, `app` - Casdoor settings

Security
--------
This page is intended for development and testing. In production you must:
- Serve via HTTPS and behind an authenticated ingress
- Replace the `mock_jwt` patterns with real SSO flows and store secrets securely
