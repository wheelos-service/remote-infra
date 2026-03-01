Start both server components for local development

Run:

```bash
make start-dev
```

This will:
- attempt to run the `backend/teleop-backend` binary if present
- serve `operator-ui/dist` on port 3000 using `http-server` (installed via `npx`)

If binaries/build outputs are missing, run `make build-backend` and `make build-frontend` first.
