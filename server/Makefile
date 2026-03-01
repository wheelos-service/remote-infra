SHELL := /bin/bash

.PHONY: build-backend build-frontend start-dev

build-backend:
	@echo "Building backend using dockerized Go..."
	cd backend && \
	docker run --rm -v $$PWD:/app -w /app -e GOPROXY=https://goproxy.cn,direct golang:1.24 \
		sh -c 'go mod tidy && go build -o teleop-backend'

build-frontend:
	@echo "Building operator UI (TypeScript)..."
	cd operator-ui && \
	if [ -f package.json ]; then npm ci && npm run build; else echo "no package.json found in operator-ui"; fi

start-dev:
	@echo "Starting both backend and operator-ui in dev mode (background)..."
	# start backend binary if present
	(cd backend && if [ -f teleop-backend ]; then ./teleop-backend & else echo "backend binary not found, run make build-backend"; fi)
	# start a simple static server for the frontend if build exists
	(cd operator-ui && if [ -d dist ]; then npx http-server dist -p 3000 --silent & else echo "frontend dist not found, run make build-frontend"; fi)
