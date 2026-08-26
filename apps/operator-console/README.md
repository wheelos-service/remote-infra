# Operator Console

This component is the standalone browser client for the remote vehicle
supervision Demo.

The HTML entrypoint is kept in `public/index.html`. The control sender
implementation lives in `src/lib/secure-control-sender.ts` and is compiled to
`dist` by the build.

Goals:
- Run the UI as a static site for manual testing or in a browser kiosk.
- Make runtime configuration easy via URL query parameters so the page can be reused across environments.

Usage
-----

Run a simple static server and open the page with query parameters to set the operator client ID and endpoints.

Example (serve locally):

```bash
# from repo root
cd apps/operator-console
npm run build
python3 -m http.server 8000 --directory dist
# open in browser (the configured operator application client ID is the default):
# http://127.0.0.1:8000/
```

Query parameters
- `backend` - URL to Teleop Gateway (default: `https://gateway.wheelos.cn`)
- `livekit` - LiveKit server URL (default: `wss://rtc.wheelos.cn`)
- `casdoor` - Casdoor server base URL (default: `https://casdoor.wheelos.cn`)
- `clientId` - Casdoor operator application client ID (required)
- `org`, `app` - optional Casdoor display settings

The operator application must use authorization code + PKCE with redirect URI
`http://127.0.0.1:8000/` for this local static-server test. Do not put a client secret in the URL.

Security
--------
This page is intended for development and testing. In production you must:
- Serve via HTTPS and behind an authenticated ingress
- Replace the `mock_jwt` patterns with real SSO flows and store secrets securely
