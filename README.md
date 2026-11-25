# FieldSync — Offline-First Health Data Collection PWA

A mobile-first progressive web app for County Health Team workers to capture patient and facility data fully offline,
with encrypted on-device storage, idempotent background sync, conflict handling, and a supervisor sync-health dashboard.

> **Demonstration project.** FieldSync is a portfolio project modelling the needs described in the NHIC (Ministry of
> Health, Liberia) Software Developer TOR. It is not in production use, is not an official MoH system, and contains no
> real patient data. All facilities, users, patients and form templates in this repository are synthetic/illustrative.

## Status

| Phase | Status |
|---|---|
| 1 — Blueprint ([docs/ADD.md](docs/ADD.md)) | ✅ Done |
| 2 — Scaffolding | ✅ Done |
| 3 — Core implementation | ✅ Done |
| 4 — Polish | ✅ Done |
| 5 — QA report, user guide, maintenance guide | ✅ Done |

## Documentation

| Document | For |
|---|---|
| [docs/ADD.md](docs/ADD.md) | Architecture, security model, sync design, decisions and deviations |
| [docs/QA-REPORT.md](docs/QA-REPORT.md) | Test inventory, edge cases, measured performance, defects, self-code review |
| [docs/TESTING-CHECKLIST.md](docs/TESTING-CHECKLIST.md) | Manual field-pilot checklist on real phones |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | Plain-language guide for community health workers |
| [docs/MAINTENANCE.md](docs/MAINTENANCE.md) | Deploy, backups, key rotation, templates, translations, devices, retention, alerts, troubleshooting |

## Quick start

Prerequisites: Docker Desktop, Python 3.12, Node 22.

```bash
make bootstrap   # writes .env with freshly generated secrets (mode 600)
make up          # Postgres + API + PWA → http://localhost:8090
make seed        # synthetic counties, facilities, demo accounts, templates and 14 days of history
```

`make seed` writes the demo accounts and their one-time random passwords to `ACCOUNTS.local.md`
(git-ignored, mode 600). Accounts: `chw.bong.1`, `chw.bong.2`, `chw.nimba.1` (CHWs),
`supervisor.bong`, `supervisor.nimba` (county supervisors), `admin` (national; also the Django
back-office at `/api/admin/`).

### Try the offline flow

1. Sign in as `chw.bong.1`, then **New form → Sick child visit**. Answers autosave as you type.
2. Settings → *Offline sync simulator* → **Offline**. Save a few forms: they wait on the phone.
3. Switch to **Flaky**: some acknowledgements are lost *after* the server saved — watch
   *Duplicates prevented* count up while the server keeps exactly one copy.
4. **Supervisor edits the last sent form**, then edit the same form on the phone → the conflict
   screen shows a field diff and offers *Combine both*.
5. Sign in as `supervisor.bong` to see the county sync-health dashboard.
6. Settings → *Appearance* → **Outdoor** for maximum contrast in sunlight; *Language* →
   Kpelle shows the placeholder pseudo-locale (every UI string marked `⟦kpe⟧`, not a translation).

- PWA: <http://localhost:8090> (install it from the browser menu to protect its storage)
- API docs: <http://localhost:8090/api/v1/docs> · Redoc: `/api/v1/redoc` · schema: `/api/v1/schema`
- Health: `/api/v1/health/live`, `/api/v1/health/ready` · metrics: `/api/v1/metrics` (Bearer `METRICS_TOKEN`)

### Development

```bash
make setup        # backend venv + frontend deps + Playwright Chromium
make dev-api      # Django on :8001 against the compose Postgres (:5434)
make dev-web      # Vite on :5173, proxies /api → :8001 (no service worker in dev)
make check        # lint + typecheck + tests + contract drift + bundle budgets
make e2e          # Playwright + axe against the stack (make up first; re-seeds with a known password)
```

Performance and operations (details in the QA report and Maintenance Guide):

```bash
# In-browser core benchmarks + Slow-3G page load + 500-form drain through the real API
cd frontend && npx vite --port 5179 --strictPort &
PERF=1 PERF_DEV_URL=http://localhost:5179 E2E_BASE_URL=http://localhost:8090 \
  npx playwright test perf --project=desktop-chromium --workers=1
# Open-loop API load test (stdlib only)
LOADTEST_PASSWORD=<seeded password> python3 scripts/loadtest.py --rate 50 --duration 60
# Operations
docker compose exec api python manage.py prune_sync_events --dry-run
docker compose exec api python manage.py rotate_escrow --dry-run
```

Visual review (screenshots at 360 / 768 / 1280 px, light, dark and outdoor themes):

```bash
cd frontend && VISUAL_DIR=/tmp/fieldsync-shots VISUAL_THEMES=light,dark,outdoor \
  E2E_BASE_URL=http://localhost:8090 npx playwright test visual --project=desktop-chromium
```

## Repository layout

```
backend/                Django + DRF API
  config/settings/      base · dev · demo · test · prod (prod refuses unsafe config)
  fieldsync/common/     envelope, error contract, middleware (request id, gzip, headers,
                        observability), structured logging + PHI scrubber, UUIDv7, health, metrics
  fieldsync/accounts/   custom user, RBAC scope, device registry, key escrow, device-bound JWT
  fieldsync/facilities/ counties and facilities
  fieldsync/formtemplates/ versioned templates, lifecycle, validation engine (Python twin)
  fieldsync/submissions/   idempotent upsert, conflicts, quarantine, review, re-validation
  fieldsync/sync/       sync events, device queue state, per-facility sync health
  fieldsync/demo/       simulator fault injection, conflict injection, seed_demo
  tests/                pytest against real PostgreSQL
  requirements.lock     hash-pinned runtime dependencies (make lock)
frontend/               React + TypeScript PWA (Vite, Workbox injectManifest)
  src/core/             framework-free code shared with the service worker (compiled without DOM types):
                        crypto (keyring, AES-GCM), IndexedDB schema + repositories, validation engine,
                        API client, sync engine (state machine, backoff, breaker, batching), session
  src/sw.ts             service worker: precache shell, SPA navigation, prompted updates, Background Sync
                        drain; never caches /api
  src/i18n/             typed translator; en + Kpelle *placeholder* (pseudo-locale, not a translation)
  src/platform/         device capability probes
  src/features/         login/unlock, home, form runner, saved, sync status + conflicts, supervisor
                        dashboard, offline sync simulator, help, settings, device check
  e2e/                  Playwright: S1 offline capture, S2 lost ack, retry, S3 conflict, dashboard,
                        edge cases (empty states, storage full, session expired offline), axe
                        (light/dark/outdoor), pseudo-locale coverage, 320 px reflow, keyboard-only,
                        focus management, persisted preferences; opt-in perf and visual harnesses
contracts/              single source of truth shared by API and PWA (CI-checked on both sides)
  error-codes.json      error codes → HTTP status → sync-queue class
  openapi.json          generated from the API (make openapi)
  form-template.schema.json, validation-cases.json, examples/
infra/                  nginx (same-origin proxy, CSP, cache policy), web Dockerfile, TLS reference
scripts/                bootstrap_env.py, loadtest.py (open-loop API load generator)
docs/                   ADD (architecture, decisions, deviations), QA report, testing checklist,
                        CHW user guide, maintenance guide
```

## Stack

React 18 + TypeScript + Vite · Workbox service worker · IndexedDB (`idb`) + Web Crypto (AES-GCM) · Zustand ·
Tailwind 3.4 + shadcn/ui + Motion · Django 5.2 LTS + DRF + SimpleJWT · PostgreSQL 16 · Docker · GitHub Actions.

See [docs/ADD.md](docs/ADD.md) for the architecture, security model and sync design.

## License

MIT — see [LICENSE](LICENSE).
