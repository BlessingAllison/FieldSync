SHELL := /bin/bash
.DEFAULT_GOAL := help

PYTHON ?= python3.12
VENV   := backend/.venv
PY     := $(VENV)/bin/python
MANAGE := cd backend && .venv/bin/python manage.py
# Host-run commands read the same .env as compose (POSTGRES_*, FIELDSYNC_DB_PORT, …).
LOAD_ENV := set -a; [ -f .env ] && . ./.env; set +a;

.PHONY: help
help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS=":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ── Setup ────────────────────────────────────────────────────────────────────
.PHONY: setup
setup: ## Backend venv + dev deps, frontend deps, Playwright Chromium
	cd backend && $(PYTHON) -m venv .venv && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q -e ".[dev]"
	cd frontend && npm ci && npx playwright install chromium

.PHONY: bootstrap
bootstrap: ## Create .env with freshly generated secrets (refuses to overwrite)
	$(PYTHON) scripts/bootstrap_env.py

# ── Stack ────────────────────────────────────────────────────────────────────
.PHONY: up
up: ## Build and start Postgres + API + PWA (http://localhost:$$FIELDSYNC_WEB_PORT, default 8090)
	docker compose up -d --build --wait
	@$(LOAD_ENV) echo "PWA:      http://localhost:$${FIELDSYNC_WEB_PORT:-8090}"
	@$(LOAD_ENV) echo "API docs: http://localhost:$${FIELDSYNC_WEB_PORT:-8090}/api/v1/docs"

.PHONY: deps
deps: ## Start only Postgres (for host-run API and tests)
	docker compose up -d --wait db

.PHONY: down
down: ## Stop the stack (database volume kept)
	docker compose down

.PHONY: logs
logs: ## Tail API and web logs
	docker compose logs -f api web

.PHONY: seed
seed: ## Seed synthetic demo data; credentials go to ACCOUNTS.local.md (git-ignored, mode 600)
	@umask 077 && docker compose exec -T api python manage.py seed_demo > ACCOUNTS.local.md
	@echo "Accounts written to ACCOUNTS.local.md (never commit it)."

# ── Host development ─────────────────────────────────────────────────────────
.PHONY: dev-api
dev-api: deps ## Django dev server on :8001 against the compose Postgres
	$(LOAD_ENV) $(MANAGE) migrate --noinput && $(LOAD_ENV) $(MANAGE) runserver 127.0.0.1:8001

.PHONY: dev-web
dev-web: ## Vite dev server on :5173 (proxies /api to :8001; no service worker in dev)
	cd frontend && npm run dev

# ── Quality ──────────────────────────────────────────────────────────────────
.PHONY: lint
lint: ## Ruff + ESLint
	cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check .
	cd frontend && npm run lint

.PHONY: typecheck
typecheck: ## mypy --strict + tsc (app, service worker, node)
	cd backend && .venv/bin/mypy .
	cd frontend && npm run typecheck

.PHONY: test-backend
test-backend: deps ## pytest against real PostgreSQL
	$(LOAD_ENV) cd backend && .venv/bin/pytest --cov --cov-report=term-missing:skip-covered

.PHONY: test-frontend
test-frontend: ## Vitest (unit + component)
	cd frontend && npm test

.PHONY: test
test: test-backend test-frontend ## All unit + integration tests

E2E_PASSWORD ?= e2e-Demo-Password-2026

.PHONY: e2e
e2e: ## Playwright against the stack (E2E login throttle on the API, seeded known passwords)
	THROTTLE_LOGIN=600/min docker compose up -d --wait api
	docker compose exec -T api python manage.py seed_demo --password "$(E2E_PASSWORD)" --reset-device-states > /dev/null
	@$(LOAD_ENV) cd frontend && E2E_PASSWORD="$(E2E_PASSWORD)" E2E_BASE_URL=http://localhost:$${FIELDSYNC_WEB_PORT:-8090} npm run e2e

.PHONY: size
size: ## Bundle budgets (size-limit)
	cd frontend && npm run build && npm run size

# ── Contracts ────────────────────────────────────────────────────────────────
.PHONY: openapi
openapi: ## Regenerate contracts/openapi.json and the frontend API types
	cd backend && DJANGO_SETTINGS_MODULE=config.settings.test .venv/bin/python manage.py spectacular --format openapi-json --file ../contracts/openapi.json --fail-on-warn --validate
	cd frontend && npm run gen

.PHONY: contracts-check
contracts-check: ## Fail if any generated contract artefact is stale
	cd frontend && npm run contracts:check

.PHONY: lock
lock: ## Re-pin backend runtime dependencies with hashes (requirements.lock)
	cd backend && .venv/bin/pip-compile --quiet --generate-hashes --strip-extras --allow-unsafe --output-file requirements.lock pyproject.toml

.PHONY: icons
icons: ## Re-render PWA icons from frontend/public/icon.svg
	cd frontend && npm run gen:icons

.PHONY: check
check: lint typecheck test contracts-check size ## Everything CI runs except E2E
