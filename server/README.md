# server/

This folder provides a lightweight unified developer surface for the project's server+UI components.

It intentionally does not duplicate sources; it wraps the existing `backend/` and `operator-ui/` folders so you can run common build/dev tasks from one place.

Usage:

Build backend (dockerized Go build):

```bash
make build-backend
```

Build frontend:

```bash
make build-frontend
```

Start both (dev):

```bash
make start-dev
```

Notes:
- This is a non-destructive scaffolding to help unify local workflows. If you want a full move (with `git mv` preserving history), run the provided shell commands in a feature branch instead.
- CI and deploy manifests still reference the original locations; update `.github/workflows` and `deploy/` when ready to permanently move files.
