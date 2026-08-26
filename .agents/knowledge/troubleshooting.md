# Troubleshooting

## When
Read this file when local startup, browser integration, tests, network connections, or deployment checks fail.

## Rules
- Confirm dependency service status and health checks first, then inspect client, Gateway, LiveKit, or vehicle-edge logs.
- Serve the browser console over HTTP/HTTPS; do not open the ES module page directly with `file://`.
- For CORS issues, compare `CLIENT_ORIGIN` with the browser's actual origin; in production also check HTTPS/WSS and the OIDC redirect URI.
- For LiveKit connection issues, check API/RTC domains, TCP fallback, UDP media ports, and short-lived token permissions together.
- For control failures, distinguish identity/ACL, Redis lease, session renewal, signature/replay protection, and vehicle watchdog failures.

## Do NOTs
- Do not bypass failures by broadening CORS, exposing Redis, or leaking secrets.
- Do not attribute one failed control connection to a single vehicle, LiveKit, or Gateway component without evidence.
- Do not claim a deployment succeeded while skipping health checks, relevant tests, or audit logs.

## Sources (SSOT)
- Local startup: `docs/local-dev.md`
- Deployment and ports: `docs/deployment.md`
- Operations guide: `docs/operations.md`
- Remote validation: `docs/remote-validation.md`
- Integration tests: `tests/`
