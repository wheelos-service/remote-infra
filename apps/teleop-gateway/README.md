# Teleop Gateway

The Gateway is a small Go service for the operator-console and vehicle-edge
demo. It authenticates users, issues scoped LiveKit tokens, manages Redis-backed
control/video sessions, and records audit and telemetry events.

## Layout

```text
cmd/teleop-gateway/       # Process entrypoint only
internal/gateway/         # Gateway application and focused domain files
  app.go                  # Dependency wiring, routes, middleware, probes
  oidc_auth.go            # Authentication and claims
  vehicle_acl.go          # Vehicle permissions and identity mapping
  livekit_token.go        # Scoped LiveKit token creation
  control_*.go            # Control session and Redis lease behavior
  video_session*.go       # Video session state and HTTP API
  audit.go                # Audit and telemetry handling
  turn_auth.go            # TURN credential helper
*_test.go                 # Tests colocated with the implementation
```

## Local commands

```bash
go test ./...
go build -o teleop-backend ./cmd/teleop-gateway
```

The Docker Compose service and `infra/scripts/build-backend.sh` use the same
`./cmd/teleop-gateway` entrypoint.
