# Local Development

## 1. Start the current Gateway stack

From the repository root:

```bash
cp .env.example .env
docker compose up -d --build redis livekit-config livekit teleop-backend
docker compose ps
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
```

The default local setup uses `AUTH_MODE=dev`. This development token mode is
only for local operator testing; it is not the vehicle's OAuth client-credentials
flow and must not be used in production.

## 2. Start the current React client

In a second terminal:

```bash
cd frontend
cd packages/teleop-shared
npm ci
cd ../../frontend
npm ci
npm run dev
```

Open the local client with the Gateway and LiveKit overrides:

```text
http://localhost:8000/?dev=1&backend=http://localhost:8080&livekit=ws://localhost:7880
```

Use the local development sign-in only on localhost.

The client uses OIDC Authorization Code + PKCE outside local development.
Production runtime configuration contains public endpoint/client-ID values
only, never client secrets or access tokens.

## 3. Current vehicle SDK

The primary vehicle runtime is the C++ SDK in `apps/vehicle-edge-cpp/`;
`apps/vehicle-edge/` is the legacy Python v1 reference. Follow the C++ README
for supported simulator/native build setup. The vehicle requires a real
client-credentials issuer and per-device credentials; `AUTH_MODE=dev` is not a
vehicle credential provider.

For deployments using the unified authorization policy, copy
`infra/local-dev/authorization-policy/authorization-policy.example.json` to
`authorization-policy.json` in the mounted policy directory, fill in test-only
vehicle subjects and operator grants, and set `AUTHORIZATION_POLICY_FILE` to
`/etc/teleop-auth/authorization-policy.json`. Clear the three legacy
`VEHICLE_*_JSON` policy variables before enabling the file.

To validate a provisioned vehicle's authentication without starting Cyber or
joining LiveKit:

```bash
bazel build //:vehicle_auth_check
bazel-bin/vehicle_auth_check /etc/teleop/device.json
```

See [authentication.md](authentication.md) for the operator/device flows,
authorization policy file, secret handling, and diagnostic boundaries.

## 4. Local acceptance

- Server: `healthz` and `readyz` return HTTP 200.
- Client development login succeeds only on localhost.
- When enabled, an empty authorization policy denies vehicle and operator
  vehicle access.
- The C++ authentication checker reports each stage without printing tokens.
- Use the isolated integration workflow in `docs/remote-validation.md` for
  cross-component tests; do not point local tests at production endpoints.

## 5. Stop the Environment

```bash
docker compose down
```

Development credentials are for integration testing only. Production requires `AUTH_MODE=oidc`, OIDC issuer/audience/JWKS configuration, HTTPS/WSS, and a reviewed Vehicle ACL. Do not expose secrets, device credentials, or production endpoints during local testing.

## Sources

- Test workflow: `.agents/skills/testing/SKILL.md`
- Deployment workflow: `docs/deployment.md`
- Runtime configuration: `docs/operations.md`
- Authentication: `docs/authentication.md`
