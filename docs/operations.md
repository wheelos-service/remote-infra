# Operations

These commands apply to the generated deployment from [LAN setup](setup.md)
or [source deployment](deploy-from-source.md). Run them as the original OS user.
Examples use the default state directory and Compose project `teleop`.

## Start and check

From the extracted release directory:

```bash
./teleop start
./teleop verify
```

From a source checkout, use `python3 infra/scripts/deploy.py start` and
`python3 infra/scripts/deploy.py verify` instead. If you chose a custom state
directory, pass the same `--state` on every command.

Verification checks Gateway health/readiness, login-service discovery, and
rejection of unauthenticated protected requests. First startup also tests the
initial administrator's PKCE login. `--login-check verify` repeats that check
only while the initial password is unchanged. These checks do not verify vehicle
cameras, media playback, or physical control.

The setup container in the prebuilt release includes Compose; Docker Engine
alone is enough for `./teleop`. The optional inspection commands below require
the Docker Compose v2 plugin on the host:

```bash
docker compose -p teleop -f "$HOME/.local/state/teleop/compose.json" ps
docker compose -p teleop -f "$HOME/.local/state/teleop/compose.json" logs --tail=100 gateway frontend caddy
docker compose -p teleop -f "$HOME/.local/state/teleop/compose.json" stop
```

Use the launcher to start again. Services normally restart automatically with
Docker unless explicitly stopped. Do not use `down --volumes` for routine shutdown.

## State, secrets, and backups

Keep the state directory private. It contains generated credentials, encryption
keys, administrator details, Casdoor data, and the HTTPS CA private key.
Only `root.crt` is intended for distribution to clients. Verify its fingerprint
before trusting it. Never distribute the entire state directory or generated
Compose file, and redact credentials and tokens before sharing logs.

Back up the state directory together with the deployment's named volumes:

| Location | Contents |
| --- | --- |
| State directory | Configuration, credentials, login identities, HTTPS CA |
| `postgres` volume | Organizations, memberships, vehicle identities, permissions |
| `redis` volume | Runtime leases, replay protection, and handover fences |
| `operations` volume | SQLite operational history |
| `caddy-config` volume | Caddy configuration state |

Compose prefixes volume names with the project name. Inspect the generated
Compose file privately to identify the exact names. For a consistent filesystem
backup, stop the complete deployment first; copying an active SQLite database
alone can omit WAL data. Preserve ownership and permissions on restore.

Before an update, take a backup and record the running release version. Keep
the same state directory, project name, and address. Loading new image tags
does not migrate identities or make database downgrades safe. Test restoration
in an isolated installation before relying on a backup.

Do not clear Redis fences or restore stale runtime state to force a session to
unlock. Stop remote operation and verify vehicle state independently before any
restore. Database permission changes are not evidence of physical handover.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Another LAN computer cannot connect | Server IP, TCP 8443/8444 firewall access, and whether setup used `--lan-ip` rather than `--local` |
| Browser certificate error | Trust the deployment's public `root.crt` in the client/browser store; use the exact configured address |
| Login fails | Use the platform administrator from `administrator.txt`; verify the login URL on port 8444 and client clock |
| Empty fleet | A fresh deployment has no vehicles; select the organization and [register a prepared vehicle](add-vehicle.md) |
| No live video | Vehicle media publisher and camera health, trusted HTTPS, TCP 7881 and UDP 51000–51100 connectivity |
| Native control returns 503 | This release blocks managed native driving until handover support is complete |
| Project/state error | Use the original private state directory and project; do not reuse another installation's project name |
| Service not ready | Check service status/logs and disk space; restart with the launcher after resolving the cause |

Never bypass certificate validation as a fix. If the server address changes,
restore the configured address or plan a separate deployment and identity migration.

## Data capacity

The current cloud store retains up to 10,000 events and 1,000 tasks per vehicle.
Exports and acknowledgements do not free deduplication storage; exhaustion
rejects new writes with HTTP 507. Monitor disk usage, capacity counters, and
diagnostic freshness. Exported records support investigation, not a consistent
database backup. Do not truncate tables or delete databases to clear an alarm.
Automatic record rotation is not implemented. The SQLite store requires one
Gateway owner on local disk, not NFS or independent replicas.
