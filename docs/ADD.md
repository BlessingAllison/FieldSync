# FieldSync — Architecture Design Document (ADD)

| | |
|---|---|
| **System** | FieldSync — Offline-First Health Data Collection PWA |
| **Document status** | Phase 1 — Blueprint (baseline). Living document: every design change made in later phases is recorded in §20 *Decision Log & Deviations*. |
| **Date** | 2026-11-19 |
| **Nature of project** | Offline-first health data collection platform for County Health Teams (CHTs), designed against the needs described in the NHIC (Ministry of Health, Liberia) Software Developer TOR. Sample data created by the seed command is synthetic. |

---

## Table of contents

1. [Overview](#1-overview)
2. [Users, roles and key scenarios](#2-users-roles-and-key-scenarios)
3. [Feature list](#3-feature-list)
4. [Non-functional requirements and budgets](#4-non-functional-requirements-and-budgets)
5. [Tech stack and rationale](#5-tech-stack-and-rationale)
6. [System architecture](#6-system-architecture)
7. [Design patterns](#7-design-patterns)
8. [Data model — PostgreSQL](#8-data-model--postgresql)
9. [Data model — on-device (IndexedDB)](#9-data-model--on-device-indexeddb)
10. [API design](#10-api-design)
11. [Security and authentication](#11-security-and-authentication)
12. [Offline and sync design](#12-offline-and-sync-design)
13. [Form templates and validation](#13-form-templates-and-validation)
14. [Sync health model](#14-sync-health-model)
15. [Observability](#15-observability)
16. [Frontend architecture and UX](#16-frontend-architecture-and-ux)
17. [Testing strategy](#17-testing-strategy)
18. [Deployment and environments](#18-deployment-and-environments)
19. [Risks and mitigations](#19-risks-and-mitigations)
20. [Decision log and deviations](#20-decision-log-and-deviations)
21. [Phase plan and exit criteria](#21-phase-plan-and-exit-criteria)

---

## 1. Overview

### 1.1 Problem

Community Health Workers (CHWs / Community Health Assistants) and facility staff collect patient and facility data in places where connectivity is absent for hours or days, intermittent when present (2G/3G, high latency, frequent drops), and expensive per megabyte. Devices are shared, low-end Android phones with limited storage and older Chrome versions. Data is health data: losing it is a clinical and programmatic failure; leaking it is a privacy failure; duplicating it corrupts indicators.

The usual failure modes of "offline-capable" tools are:

| Failure mode | Consequence | FieldSync answer |
|---|---|---|
| Data stored unencrypted in the browser | PHI exposed on a lost/shared phone | Envelope encryption (AES-GCM DEK wrapped by password-derived KEK) for every PHI-bearing record (§11.4) |
| Retry after a lost acknowledgement creates duplicates | Inflated case counts | Client-generated UUIDv7 idempotency key + content hash; server upsert is idempotent (§12.4) |
| Concurrent edits silently overwrite each other | Corrected data reverted | Version check on every write; conflicts are surfaced to a human, never dropped (§12.5) |
| Unsynced data is invisible to supervisors | Backlogs discovered weeks later | Devices report queue depth; per-facility *sync health* on a supervisor dashboard (§14) |
| Browser silently evicts storage | Queue vanishes | `navigator.storage.persist()`, quota monitoring, install-to-home-screen guidance, dashboard visibility of last-reported queue depth (§12.10) |
| App update mid-form breaks the session | Lost draft | Prompted SW updates, never `skipWaiting` while a draft is open; forward-only IndexedDB migrations (§12.11) |

### 1.2 Goals

- G1. **Capture works 100% offline** after the first successful login on a device — including app reload, phone reboot, and access-token expiry.
- G2. **No data loss, no duplicates.** Every saved submission is either acknowledged by the server, or visibly pending/failed/conflicted on the device *and* (once the device has connectivity) visible to the supervisor.
- G3. **Health data is encrypted at rest on the device** and never written to logs, Cache Storage, or analytics.
- G4. **Low bandwidth:** ≤ 170 KB gzipped critical JS, gzip-compressed batched uploads, conditional GETs for reference data.
- G5. **Supervisor visibility:** per-facility sync health for a county at a glance.
- G6. **Configurable forms:** versioned templates with identical validation on client and server.
- G7. **Maintainable by a small MoH team:** boring, well-known technology; strict typing; documented runbooks.

### 1.3 Non-goals (explicit)

- Not a Master Patient Index — no cross-submission patient de-duplication or national-ID matching. Submissions carry a CHW-scoped `patient_ref`.
- Not an analytics/indicator platform. Integration with DHIS2 is a documented extension point, not built.
- No native app. A PWA is the deliverable; the trade-offs (iOS limits) are documented in §19.
- No real-time collaboration. Edits are asynchronous with optimistic concurrency.
- No machine translation. The Liberian-language locale ships as a clearly marked placeholder (§16.6).

---

## 2. Users, roles and key scenarios

### 2.1 Roles

| Role | Scope | Can do |
|---|---|---|
| `chw` | Facilities explicitly assigned to the user (`facility_assignments`) | Capture/edit own submissions for assigned facilities; view own sync status; view own facility's health tile |
| `supervisor` | All facilities in their county (`users.county_id`) | Everything `chw` can see for the county; review/flag/correct submissions; trigger server-side re-validation (`retry`); sync-status dashboard |
| `admin` | National (all counties) | Manage templates (draft → publish → supersede → retire), facilities, users, devices (revoke); everything supervisors can do |

Roles are enforced **on the server** by queryset scoping (§11.5). The PWA's role-based UI is a usability layer, never an authorisation layer.

### 2.2 Key scenarios (these drive the E2E suite in Phase 5)

| ID | Scenario |
|---|---|
| S1 | CHW logs in online at the facility in the morning; walks to a village with no signal; records 12 household visits; phone reboots once; returns in the evening; all 12 sync automatically within minutes of signal returning, with zero duplicates. |
| S2 | During sync on flaky 3G, the server processes a batch but the response is lost. The client retries; the server replays the stored results; dashboard shows 12, not 24. |
| S3 | Supervisor corrects a MUAC value on a synced submission. Meanwhile, the CHW (offline) edits the same submission's follow-up date. On sync the CHW sees a conflict with a field diff and chooses *Combine both*. |
| S4 | A CHW's refresh token expires while offline for 16 days. Capture continues (local unlock with password). On reconnect the app asks the CHW to sign in again; the queue is preserved and syncs after sign-in. |
| S5 | A phone is reported lost. The admin revokes the device. If it ever reconnects, its local data is crypto-shredded. The dashboard shows how many submissions were pending on that device at its last report. |
| S6 | Two CHWs share one phone. Each has their own encrypted database and key; switching user locks the previous user's queue until they sign in again. |
| S7 | A template rule was too strict (rejected valid MUAC values). Server quarantines the affected submissions as `rejected` instead of dropping them; admin publishes a fixed template version; supervisor re-validates via `POST /submissions/{id}/retry`. |

---

## 3. Feature list

### 3.1 PWA (field app)

- Installable PWA (manifest, icons, splash), app shell precached; works from cold start offline.
- Login (online) with cached session; **offline unlock** with password; optional 6-digit **quick-unlock PIN** for idle re-entry (§11.4.5).
- Home: *New submission* (primary thumb-zone CTA), *Pending sync* badge with count and stuck/failed indicators, *My facility* tile with sync health.
- Template picker (cached, versioned templates; patient- and facility-level forms).
- Form runner: stepper, **autosave on every field change** (encrypted draft), inline validation, conditional fields, minimal-typing controls (segmented choices, steppers, MUAC colour band selector, native date picker).
- *Saved* screen: explicit "Saved on this phone — will send automatically when there is network" state with a receipt code.
- Sync Status: per-item state (pending / sending / retry in mm:ss / failed / conflict / sent), last successful sync timestamp, *Sync now*, per-item *Retry*, failed-item *Fix & resend*, conflict resolution with field diff.
- Supervisor dashboard (supervisor/admin): county facility grid with health status, pending-on-devices, oldest pending, failed/conflicts, success rate; last snapshot cached for offline viewing with "as of" time.
- **Offline sync simulator** (demo/training mode): network profiles (Online / Offline / 3G / Flaky / Server errors), "lost acknowledgement" injection, conflict injection, burst generator (N synthetic submissions), animated queue lanes with per-item status, attempt counters, backoff countdowns, event log, and a *Duplicates prevented* counter (§16.7).
- Help: illustrated plain-language guide, "What happens when I'm offline?", troubleshooting.
- Settings: language (English / Kpelle placeholder), lock now, switch user, sign out & erase (with unsynced-data warning), storage usage.
- Accessibility: WCAG 2.2 AA, keyboard navigation, screen-reader labels/live regions for sync status, ≥ 48 px tap targets, high-contrast outdoor palette, reduced-motion support.

### 3.2 API (Django + DRF)

- JWT auth (short-lived access token in memory; rotating refresh token in an `HttpOnly` cookie bound to a registered device).
- Device registry with revocation and key-escrow secret (§11.4.3).
- Facilities and counties (scoped reads).
- Form templates: versioned JSON definitions, lifecycle (draft → published → superseded → retired), ETag/`If-None-Match` support.
- Submissions: **idempotent upsert** on `client_uuid` (single and batch), optimistic concurrency, quarantine of invalid submissions, version history, supervisor review/correction, server-side re-validation (`retry`).
- Sync status aggregation per facility (role-scoped).
- Device heartbeat (queue depth reporting).
- `/health/live`, `/health/ready`, Prometheus `/metrics`.
- OpenAPI 3.1 schema + Swagger UI/Redoc.
- Standard response envelope, structured JSON logs with request IDs, PII-scrubbing log filter.
- Demo-only fault injection middleware (hard-disabled outside demo settings).

---

## 4. Non-functional requirements and budgets

| Area | Budget / requirement | Enforcement |
|---|---|---|
| Critical JS (initial route, gzipped) | **≤ 170 KB target, 200 KB hard limit** | `size-limit` in CI fails the build |
| Critical CSS (gzipped) | ≤ 25 KB | `size-limit` |
| Images on critical path | 0 raster images; icons inline SVG | Code review + bundle report |
| Fonts | System font stack, no web-font downloads | Lint rule / review |
| First load on "Slow 3G" (400 kbps, 400 ms RTT), 4× CPU throttle | Interactive ≤ 6 s | Lighthouse CI profile (Phase 5) |
| Repeat load (SW precache) | Interactive ≤ 1.5 s | Lighthouse CI |
| Save submission (encrypt + atomic IDB write), 4× CPU | p95 ≤ 50 ms | Vitest benchmark + Playwright trace |
| Autosave per field | p95 ≤ 20 ms, debounced 400 ms | Benchmark |
| Queue capacity | 500 pending submissions without UI degradation (list virtualised/paginated) | E2E edge-case test |
| Drain 500 items on simulated 3G | ≤ 2 min (batches, gzip) | E2E/perf test |
| Offline unlock (PBKDF2 600k) on low-end device | ≤ 3 s with progress UI | Measured in Phase 5; iteration count stored per keyring for upgrade |
| Browser baseline | Chrome/Android WebView ≥ 87, Safari ≥ 14 (degraded: no Background Sync), Firefox ≥ 78 | Vite `build.target`, Browserslist |
| Accessibility | WCAG 2.2 AA; axe-core zero violations on every screen | Playwright + axe in CI |
| API p95 latency (single submission upsert, server-side) | ≤ 150 ms at 50 req/s on 2 vCPU | Load test script (Phase 5) |
| Availability posture | API outages must never block capture | By design (offline-first) |

> **Why 87?** Android 7 devices are frozen at Chrome 119 and Android 8/9 at Chrome 138; older Android 6 handsets top out at Chrome 106. Chrome 87 is the floor that gives us Web Crypto, IndexedDB 2.0, Service Workers, Background Sync, Web Locks, BroadcastChannel and `CompressionStream` without polyfills, and is Vite's default "modules" target. Everything FieldSync needs runs on it.

---

## 5. Tech stack and rationale

### 5.1 Stack table

| Layer | Choice | Version line | Why (offline reliability · low bandwidth · maintainability) |
|---|---|---|---|
| UI framework | **React + TypeScript** | React 18.3, TS 5.x (`strict`, `noUncheckedIndexedAccess`) | Largest hiring pool in Liberia and the region → maintainable by MoH staff; mature PWA tooling; TS makes the sync state machine and API contracts checkable at compile time. React's 44 KB gz runtime fits the budget. React 18 is chosen over 19 because the shadcn/ui Tailwind-v3 component track (see below) is built and tested on it. |
| Build | **Vite** | 5.x | Fast builds, native ESM, Rollup code-splitting per route, first-class `vite-plugin-pwa`. Build target `chrome87, safari14, firefox78`. |
| Service worker | **Workbox via `vite-plugin-pwa` (`injectManifest`)** | Workbox 7 | `injectManifest` (not `generateSW`) because we need custom SW code: the `sync` event handler that runs the shared SyncEngine. Workbox gives revisioned precaching and safe update flows we would otherwise hand-roll badly. |
| Local storage | **IndexedDB via `idb`** | idb 8 | `idb` is a ~1.2 KB promise wrapper that keeps the real IndexedDB semantics (transactions, indexes, cursors) visible — essential for atomic draft→outbox moves and index-driven queue scans. Dexie was rejected: 25 KB+ and its abstractions hide transaction scope. localStorage is rejected outright (synchronous, 5 MB, strings only, not available in SW). |
| Encryption | **Web Crypto API** (PBKDF2-SHA-256, AES-KW, AES-GCM-256, HKDF) | native | Native, constant-time, hardware-accelerated, zero bundle cost, available in SW. Keys can be **non-extractable** `CryptoKey`s that JS (including injected script) cannot export. Argon2 via WASM was rejected: +30–60 KB and memory-hard parameters that crash 1–2 GB devices. |
| State | **Zustand** | 5.x | ~1 KB. Holds the *UI projection* of local state and subscribes to the SyncEngine's event bus. **React Query is deliberately not used**: it is a server-state cache, whereas FieldSync's source of truth is local. Its offline-mutation persistence serialises a single blob, is coupled to the React lifecycle, cannot run inside the Service Worker, and has no notion of encryption, leases or idempotency. Our queue must run identically in the page and in the SW, so it is a framework-free module. |
| Routing | **React Router** | 6.x | Familiar to most React developers; route-level `lazy()` splitting keeps Supervisor/Simulator/Help out of the critical bundle. |
| Styling | **Tailwind CSS 3.4 + shadcn/ui (Radix primitives)** | Tailwind 3.4 | Utility CSS purges to a few KB. **Tailwind 3.4 not 4**: v4's output depends on `@property`, cascade layers and `oklch()`, requiring Chrome ≥ 111; a meaningful share of low-end Android handsets are frozen below that. shadcn components are copied into the repo (owned code, no runtime dependency lock-in) and only the primitives we use are bundled. For option lists ≤ 6 items we use large radio cards instead of Radix Select (fewer taps, smaller bundle). |
| Motion | **Motion (Framer Motion) with `LazyMotion` + `m` + `domAnimation`** | 11.x | ~15 KB instead of ~50 KB. Honours `prefers-reduced-motion`. Animations are transform/opacity only (GPU-composited, cheap on low-end GPUs). |
| i18n | **In-house typed `t()` (~1 KB)** + `Intl.PluralRules`/`Intl.DateTimeFormat` | — | i18next + react-i18next costs ~15 KB gz for features we don't need. Keys are type-checked against `en.json`, so a missing key is a compile error. Locale bundles are lazy-loaded. |
| Icons | **lucide-react** (tree-shaken, inline SVG) | — | No icon font download; each icon ~300 B. |
| API types | **`openapi-typescript`** (types only, zero runtime) | 7.x | Generated from the DRF OpenAPI schema; CI fails on drift. |
| Backend | **Django + Django REST Framework** | Python 3.12, Django 5.2 LTS, DRF 3.15 | LTS support window to 2028; batteries for auth, admin (back-office for admins), migrations, ORM with `select_for_update`; enormous talent pool. DRF gives serializers, throttling, permissions, and with drf-spectacular a correct OpenAPI 3 schema. |
| Auth | **djangorestframework-simplejwt** (+ token blacklist app) | 5.3+ | Standard JWT implementation with rotation and blacklist. We customise it to deliver the refresh token as an `HttpOnly` cookie and to bind tokens to a device (`did` claim). |
| Database | **PostgreSQL** | 16 | `JSONB` for versioned form payloads, partial and BRIN indexes, `SELECT … FOR UPDATE`, transactional DDL for safe migrations, `ON CONFLICT`. |
| DB driver | **psycopg 3** | 3.2 | Maintained successor to psycopg2; binary wheels. |
| OpenAPI | **drf-spectacular** | 0.27+ | Accurate schema from serializers with explicit `@extend_schema` for envelopes; Swagger UI + Redoc. |
| Logging | **structlog** → JSON stdout | 24.x | Context variables carry `request_id`/`user_id`/`device_id` through the request without manual plumbing; JSON is ingestible by any log stack. |
| Metrics | **prometheus_client** | — | Standard exposition format; no vendor lock-in. |
| Password hashing (server) | **Argon2id** (`argon2-cffi`) | — | Django's strongest built-in hasher. |
| Server crypto | **cryptography** (AES-GCM for escrow secrets at rest) | — | Audited, maintained. |
| Containers | **Docker + docker-compose** | Compose v2 | One command brings up Postgres + API + nginx-served PWA on one origin. |
| CI | **GitHub Actions** | — | Lint → type-check → unit → integration (Postgres service) → build → size-limit → E2E (compose) → axe. |
| Tests | **pytest + pytest-django + Hypothesis**; **Vitest + fake-indexeddb + Testing Library**; **Playwright + axe-core** | — | Real Postgres for integration (idempotency/locking semantics differ in SQLite — SQLite is never used). Hypothesis property-tests the upsert for "exactly one row whatever the retry sequence". |

### 5.2 Rejected alternatives (and why)

| Alternative | Rejected because |
|---|---|
| PouchDB/CouchDB replication | Elegant sync, but document-level replication of whole databases to devices conflicts with need-to-know RBAC, CouchDB is unfamiliar to MoH teams, and PouchDB is ~45 KB gz. Encryption plug-ins are third-party and unmaintained. |
| Firebase/Firestore offline | Vendor lock-in, data residency outside MoH control, opaque encryption at rest on device. |
| Native Android app | Better background execution, but distribution/updates through Play Store or sideloading is a real operational burden for CHTs; a PWA updates on next launch. TOR emphasises PWAs. |
| GraphQL | Adds client weight and caching complexity; our API surface is small and REST maps cleanly to idempotent upserts. |
| Storing PHI in Cache Storage (Workbox runtime caching of API GETs) | Cache Storage is not encrypted and is easy to inspect. **No `/api` response is ever cached by the SW.** Reference data (templates, facilities) is persisted by repositories in IndexedDB. |
| CORS between separate PWA and API origins | Same-origin deployment (nginx proxies `/api`) removes CORS entirely and lets the refresh cookie be `SameSite=Strict`. Dev uses Vite's proxy for the same effect. |

---

## 6. System architecture

### 6.1 Component view

```
 ┌────────────────────────────────────────── DEVICE (low-end Android, Chrome ≥ 87) ──────────────────────────────────────────┐
 │                                                                                                                           │
 │  ┌───────────────────────────── PWA page (React + TS) ─────────────────────────────┐    ┌──── Service Worker (Workbox) ───┐ │
 │  │                                                                                 │    │                                 │ │
 │  │  App shell ─ Router ─ Screens (Login/Unlock, Home, Form, Saved, Sync, Help,     │    │  Precache: app shell, hashed    │ │
 │  │                        Supervisor, Simulator, Settings)                          │    │  JS/CSS, SVG, manifest          │ │
 │  │        │                       ▲                                                │    │  Navigation fallback → shell    │ │
 │  │        ▼                       │ Zustand stores (UI projection)                 │    │  NO caching of /api responses   │ │
 │  │  Form runner ─ Validator (DSL) │                                                │    │                                 │ │
 │  │        │                       │ observes                                       │    │  'sync' event (tag: fs-outbox)  │ │
 │  │        ▼                       │                                                │    │        │                        │ │
 │  │  ┌──────────────── core/ (framework-free, shared by page AND SW) ─────────────────────────────▼──────────────────────┐ │ │
 │  │  │  Repositories ── DraftRepo · OutboxRepo · TemplateRepo · FacilityRepo · KeyringRepo · SessionRepo · SyncLogRepo   │ │ │
 │  │  │       │                                                                                                            │ │ │
 │  │  │  CryptoService (Web Crypto: PBKDF2 → AES-KW → AES-GCM)        SyncEngine (consumer)                                │ │ │
 │  │  │       │                                                       ├─ Scheduler ◄─ Strategy: BackgroundSync | Timer |   │ │ │
 │  │  │       │                                                       │                Manual                              │ │ │
 │  │  │       │                                                       ├─ ConnectivityBreaker (circuit breaker)             │ │ │
 │  │  │       │                                                       ├─ Backoff policy (exp + jitter, Retry-After)        │ │ │
 │  │  │       │                                                       ├─ Leases + Web Locks (single consumer)              │ │ │
 │  │  │       │                                                       └─ EventBus ──BroadcastChannel('fs-sync')──► pages   │ │ │
 │  │  │       ▼                                                                    │                                       │ │ │
 │  │  │  IndexedDB  fieldsync-u-<userhash>                                          ▼                                       │ │ │
 │  │  │   meta · keyring · session · templates · facilities · drafts* · outbox* ·  ApiClient (Adapter: fetch → typed       │ │ │
 │  │  │   receipts · sync_log · dashboard_cache        (* = AES-GCM encrypted)      Result, envelope unwrap, gzip, auth,    │ │ │
 │  │  │                                                                             NetworkConditions for simulator)        │ │ │
 │  │  └─────────────────────────────────────────────────────────────────────────────────────────┬──────────────────────────┘ │ │
 │  └─────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────┘ │
 └─────────────────────────────────────────────────────────────────────────────────────────────────┼──────────────────────────────┘
                                                      HTTPS (TLS 1.2+, HSTS) │ same origin, /api/v1/*
 ┌──────────────────────────────────────────────── SERVER ──────────────────────────────────────────┼──────────────────────────────┐
 │  nginx: serves built PWA (immutable hashed assets, no-cache index.html + sw.js), proxies /api ───┘ ; security headers, gzip     │
 │                                                                                                                                 │
 │  Django + DRF (gunicorn)                                                                                                        │
 │   Middleware: RequestId → GzipRequestBody (bounded) → [DemoFaults, demo only] → Security → Auth                                  │
 │   ┌──────────────┬───────────────┬──────────────────┬───────────────────────────────┬─────────────────┬──────────────────────┐ │
 │   │ auth         │ devices       │ facilities       │ templates                     │ submissions     │ sync                 │ │
 │   │ login/refresh│ register,     │ counties,        │ versions, lifecycle, ETag     │ upsert (single, │ sync-status agg,     │ │
 │   │ logout, me   │ revoke,escrow │ scoped list      │                               │ batch), review, │ heartbeat, events    │ │
 │   │              │               │                  │                               │ retry, history  │                      │ │
 │   └──────┬───────┴───────┬───────┴────────┬─────────┴──────────────┬────────────────┴────────┬────────┴──────────┬───────────┘ │
 │          │ Services layer (domain logic, typed, transaction boundaries) — views are thin                            │             │
 │          ▼                                                                                                          ▼             │
 │   PostgreSQL 16: counties · users · facility_assignments · devices · device_facility_state · form_templates ·                 │
 │                  submissions · submission_versions · sync_events · token_blacklist_*                                         │
 │   Observability: structlog JSON → stdout (request_id, user_id, device_id; never payload) · prometheus_client /metrics        │
 └─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Offline → queue → sync → ack flow

```
  CHW              Form runner          DraftRepo/OutboxRepo        SyncEngine (page or SW)          API                     PostgreSQL
   │  types field      │                       │                          │                          │                          │
   ├──────────────────►│ debounce 400ms        │                          │                          │                          │
   │                   ├─ encrypt(draft) ─────►│ put drafts[uuid]         │                          │                          │
   │  taps "Save"      │                       │                          │                          │                          │
   ├──────────────────►│ validate (DSL)        │                          │                          │                          │
   │                   ├─ encrypt(payload) ───►│ ONE IDB txn:             │                          │                          │
   │                   │                       │  outbox.put(PENDING)     │                          │                          │
   │                   │                       │  drafts.delete(uuid)     │                          │                          │
   │                   │                       │  receipts.put(summary)   │                          │                          │
   │ "Saved on phone"  │◄──────────────────────┤ commit                   │                          │                          │
   │◄──────────────────┤ bus.emit(enqueued) ───┼─────────────────────────►│ schedule():              │                          │
   │                   │                       │                          │  BackgroundSync.register │                          │
   │                   │                       │                          │  or Timer / online event │                          │
   │      ... offline for hours: breaker OPEN, no requests, no battery/data spent ...                │                          │
   │                   │                       │  'online' / sync event   │                          │                          │
   │                   │                       │                          ├─ breaker HALF-OPEN:      │                          │
   │                   │                       │                          │  HEAD /health/live ─────►│                          │
   │                   │                       │                          │◄──────────── 204 ────────┤ breaker CLOSED            │
   │                   │                       │                          ├─ navigator.locks('fs-sync') (single consumer)        │
   │                   │                       │◄── claim due items ──────┤ PENDING→SYNCING, lease 60s                          │
   │                   │                       │─── decrypt payloads ────►│                          │                          │
   │                   │                       │                          ├─ POST /submissions/batch ►│ per item, own txn:       │
   │                   │                       │                          │   gzip, ≤25 items,        │  SELECT…FOR UPDATE by     │
   │                   │                       │                          │   attempt n, device_state │  client_uuid ────────────►│
   │                   │                       │                          │                          │  insert / replay /        │
   │                   │                       │                          │                          │  update / 409 / 422       │
   │                   │                       │                          │                          │  + sync_events row        │
   │                   │                       │                          │◄── 200 {results[i]} ─────┤◄──────────────────────────┤
   │                   │                       │◄── per item transition ──┤ SYNCED (purge payload) │ │                          │
   │                   │                       │    RETRY_WAIT/FAILED/    │ CONFLICT (store server   │                          │
   │                   │                       │    CONFLICT              │ copy, encrypted)         │                          │
   │  badge updates    │◄───────── BroadcastChannel('fs-sync') ───────────┤ bus.emit(itemChanged)    │                          │
   │◄──────────────────┤                       │                          │                          │                          │
```

Key properties of the flow:

1. **The save is local and atomic.** Moving a draft into the outbox, deleting the draft and writing the receipt happen in one IndexedDB transaction. There is no state where a submission exists in neither or both.
2. **The network is never on the save path.** The CHW gets the "saved" confirmation from IndexedDB, not from the server.
3. **The server is the authority on what was accepted**; the client only marks `SYNCED` after a per-item acknowledgement.
4. **A lost acknowledgement is harmless**: the next attempt carries the same `client_uuid` and payload; the server returns the stored outcome (`replayed: true`).

---

## 7. Design patterns

| Pattern | Where | Why here |
|---|---|---|
| **Repository** | `core/repositories/*` (PWA): `DraftRepository`, `OutboxRepository`, `TemplateRepository`, `FacilityRepository`, `KeyringRepository`, `SessionRepository`, `SyncLogRepository`, built on a generic `EncryptedStore<T>`. Backend: `services/` modules own all ORM access for submissions and sync. | Screens and the SyncEngine never touch IndexedDB or crypto directly. Encryption becomes a property of the store, not something each caller must remember. Repositories are unit-tested against `fake-indexeddb` + Node Web Crypto. |
| **Queue / Producer–Consumer** | Producer: form runner (`OutboxRepository.enqueue`). Consumer: `SyncEngine.drain()`. Queue: `outbox` store keyed by `client_uuid`, indexed by `[state, nextAttemptAt]`. | Decouples capture from connectivity. The consumer can run in the page, in the SW, or both, with Web Locks guaranteeing one active consumer per origin. |
| **Strategy** | `SyncTransportStrategy` with `BackgroundSyncStrategy` (Chromium `sync` event), `ForegroundTimerStrategy` (30 s while visible + `online` + `visibilitychange`), `ManualStrategy` (Sync now). Selected at runtime by capability detection; strategies compose (Background Sync *and* timer on Chrome). | Background Sync is unavailable on Safari/Firefox; the engine must not care which trigger fired. |
| **Observer** | `SyncEventBus` (typed emitter) inside each context, bridged across page ↔ SW ↔ other tabs via `BroadcastChannel('fs-sync')`. Zustand stores subscribe. Server side: `sync_events` is an append-only observation log consumed by the sync-status aggregator. | The SW may sync while the page is open; the badge must update without polling. |
| **Adapter** | `ApiClient` adapts `fetch` into `Result<T, ApiError>` with envelope unwrapping, error classification (`network`, `timeout`, `auth`, `conflict`, `validation`, `rate_limited`, `server`), gzip request bodies, auth header injection and single-flight refresh. `NetworkConditions` is a decorator on the adapter used by the simulator. | Domain code never sees `Response` objects or HTTP status codes — only typed outcomes that map directly to queue transitions. |
| **Circuit Breaker** | `ConnectivityBreaker`: CLOSED → OPEN after 3 consecutive network-class failures; OPEN → HALF_OPEN after cool-down (15 s doubling to 5 min) or on `online` event; HALF_OPEN probes `HEAD /api/v1/health/live` (≈ 200 bytes). | `navigator.onLine === true` only means "a network interface is up" — on a captive Wi-Fi or a dead 3G cell it lies. The breaker prevents burning battery and airtime on doomed requests, and gives the UI an honest "No connection to server" state. |
| **State Machine** | Outbox item lifecycle (§12.2) and engine lifecycle (§12.3) implemented as explicit transition tables with an exhaustive `switch` on a discriminated union; illegal transitions throw in dev and are logged in prod. | Sync bugs are almost always illegal transitions. Making them unrepresentable is cheaper than debugging them in the field. |
| **Envelope / Template Method (backend)** | `EnvelopeRenderer` + custom DRF exception handler produce `{success, data, error, meta}` for every response, including 404/500 and throttling. | One parsing path on the client. |
| **Unit of Work (backend)** | Each submission upsert is its own `transaction.atomic()` block (batch = N independent units). | One bad item never rolls back 24 good ones; partial success is reported per item. |

---

## 8. Data model — PostgreSQL

### 8.1 Entity overview

```
 counties 1───* facilities 1───* facility_assignments *───1 users 1───* devices 1───* device_facility_state *───1 facilities
                    │                                        │            │
                    │ 1                                       │ 1          │ 1
                    *                                        *            *
 form_templates 1───* submissions *─────────────────────── submitted_by   device_id
                         │ 1
                         *
                  submission_versions

 sync_events (append-only; references users/devices/facilities/submissions by id, nullable)
```

### 8.2 Tables (DDL-level; Django models generate the migrations)

All primary keys are UUIDs except lookup/append-only tables. All timestamps are `timestamptz` in UTC. Health-data FKs use `ON DELETE PROTECT` — submissions are never cascade-deleted.

```sql
-- ── Reference ─────────────────────────────────────────────────────────────
CREATE TABLE counties (
  id          smallserial PRIMARY KEY,
  code        varchar(8)  NOT NULL UNIQUE,      -- e.g. 'BG' (Bong)
  name        varchar(64) NOT NULL UNIQUE
);

CREATE TABLE facilities (
  id             uuid PRIMARY KEY,
  code           varchar(32)  NOT NULL UNIQUE,
  name           varchar(160) NOT NULL,
  county_id      smallint     NOT NULL REFERENCES counties(id) ON DELETE PROTECT,
  district       varchar(80)  NOT NULL,
  facility_type  varchar(24)  NOT NULL CHECK (facility_type IN
                   ('hospital','health_center','clinic','community_post')),
  is_active      boolean      NOT NULL DEFAULT true,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX facilities_county_active ON facilities (county_id) WHERE is_active;

-- ── Identity ──────────────────────────────────────────────────────────────
CREATE TABLE users (                                  -- custom AbstractBaseUser
  id                uuid PRIMARY KEY,
  username          citext       NOT NULL UNIQUE,
  password          varchar(128) NOT NULL,           -- Argon2id
  display_name      varchar(120) NOT NULL,
  role              varchar(16)  NOT NULL CHECK (role IN ('chw','supervisor','admin')),
  county_id         smallint     NULL REFERENCES counties(id) ON DELETE PROTECT,
  preferred_locale  varchar(8)   NOT NULL DEFAULT 'en',
  is_active         boolean      NOT NULL DEFAULT true,
  is_staff          boolean      NOT NULL DEFAULT false,   -- Django admin access (admins only)
  failed_logins     smallint     NOT NULL DEFAULT 0,
  locked_until      timestamptz  NULL,
  last_login        timestamptz  NULL,
  date_joined       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT supervisor_has_county CHECK (role <> 'supervisor' OR county_id IS NOT NULL)
);

CREATE TABLE facility_assignments (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  facility_id  uuid NOT NULL REFERENCES facilities(id) ON DELETE PROTECT,
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  assigned_by  uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, facility_id)
);
CREATE INDEX facility_assignments_facility ON facility_assignments (facility_id);

-- A "device" is one (browser installation × user) pair. A shared phone with
-- two CHWs has two device rows, two local databases and two keys (§11.7).
CREATE TABLE devices (
  id                 uuid PRIMARY KEY,                  -- generated on device (UUIDv4)
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE PROTECT,
  label              varchar(80)  NOT NULL,             -- e.g. "Android · Chrome 126"
  app_version        varchar(32)  NOT NULL,
  escrow_secret_enc  bytea        NOT NULL,             -- AES-GCM(server KEY_ESCROW_KEK, 32 random bytes)
  escrow_key_id      smallint     NOT NULL,             -- server KEK rotation id
  registered_at      timestamptz  NOT NULL DEFAULT now(),
  last_seen_at       timestamptz  NOT NULL DEFAULT now(),
  revoked_at         timestamptz  NULL,
  revoked_by         uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason      varchar(200) NULL
);
CREATE INDEX devices_user ON devices (user_id);
CREATE INDEX devices_active_seen ON devices (last_seen_at) WHERE revoked_at IS NULL;

-- Last self-reported queue state per device per facility (one row, overwritten).
CREATE TABLE device_facility_state (
  device_id          uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  facility_id        uuid NOT NULL REFERENCES facilities(id) ON DELETE PROTECT,
  pending            integer NOT NULL DEFAULT 0 CHECK (pending   >= 0),
  failed             integer NOT NULL DEFAULT 0 CHECK (failed    >= 0),
  conflicts          integer NOT NULL DEFAULT 0 CHECK (conflicts >= 0),
  stuck              integer NOT NULL DEFAULT 0 CHECK (stuck     >= 0),
  oldest_pending_at  timestamptz NULL,
  last_attempt_at    timestamptz NULL,
  last_success_at    timestamptz NULL,
  reported_at        timestamptz NOT NULL,
  PRIMARY KEY (device_id, facility_id)
);
CREATE INDEX device_facility_state_facility ON device_facility_state (facility_id);

-- ── Templates ─────────────────────────────────────────────────────────────
CREATE TABLE form_templates (
  id             uuid PRIMARY KEY,
  code           varchar(64) NOT NULL,                 -- slug, stable across versions
  version        integer     NOT NULL CHECK (version > 0),
  subject        varchar(16) NOT NULL CHECK (subject IN ('patient','facility')),
  title          jsonb       NOT NULL,                 -- {"en": "...", "kpe": "..."}
  description    jsonb       NOT NULL DEFAULT '{}',
  definition     jsonb       NOT NULL,                 -- validated against contracts/form-template.schema.json
  definition_hash char(64)   NOT NULL,                 -- sha256 of canonical JSON → ETag
  status         varchar(12) NOT NULL CHECK (status IN ('draft','published','superseded','retired')),
  accept_until   timestamptz NULL,                     -- grace window for superseded/retired versions
  published_at   timestamptz NULL,
  superseded_at  timestamptz NULL,
  retired_at     timestamptz NULL,
  created_by     uuid NOT NULL REFERENCES users(id) ON DELETE PROTECT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);
-- At most one *current* published version per template code.
CREATE UNIQUE INDEX form_templates_one_published ON form_templates (code) WHERE status = 'published';
-- Published definitions are immutable: enforced in the service layer AND by a trigger
-- that rejects UPDATE of definition/definition_hash when OLD.status <> 'draft'.

-- ── Submissions ───────────────────────────────────────────────────────────
CREATE TABLE submissions (
  id                   uuid PRIMARY KEY,               -- server id (UUIDv7)
  client_uuid          uuid NOT NULL UNIQUE,           -- idempotency key (UUIDv7, device-generated)
  template_id          uuid NOT NULL REFERENCES form_templates(id) ON DELETE PROTECT,
  facility_id          uuid NOT NULL REFERENCES facilities(id)     ON DELETE PROTECT,
  submitted_by         uuid NOT NULL REFERENCES users(id)          ON DELETE PROTECT,
  device_id            uuid NOT NULL REFERENCES devices(id)        ON DELETE PROTECT,
  payload              jsonb NOT NULL,                 -- field values only, ≤ 64 KB
  payload_hash         char(64) NOT NULL,              -- sha256(canonical JSON of payload)
  status               varchar(12) NOT NULL CHECK (status IN ('accepted','rejected','reviewed','flagged')),
  validation_errors    jsonb NULL,                     -- field paths + codes only (no values)
  version              integer NOT NULL DEFAULT 1 CHECK (version > 0),   -- PAYLOAD version
  captured_at          timestamptz NOT NULL,           -- device clock (informational)
  client_clock_skew_ms integer NULL,                   -- server_now - client_now at receipt
  received_at          timestamptz NOT NULL DEFAULT now(),  -- first acceptance by server (authoritative)
  updated_at           timestamptz NOT NULL DEFAULT now(),
  reviewed_by          uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at          timestamptz NULL,
  review_note          varchar(500) NULL
);
-- Keyset pagination for supervisor and CHW lists:
CREATE INDEX submissions_facility_received ON submissions (facility_id, received_at DESC, id DESC);
CREATE INDEX submissions_submitter_received ON submissions (submitted_by, received_at DESC, id DESC);
CREATE INDEX submissions_rejected ON submissions (facility_id) WHERE status = 'rejected';
CREATE INDEX submissions_template ON submissions (template_id);
-- No GIN index on payload: write amplification on every upsert is not justified by any
-- current read path. Revisit only with a concrete query.

CREATE TABLE submission_versions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id  uuid NOT NULL REFERENCES submissions(id) ON DELETE PROTECT,
  version        integer NOT NULL,
  payload        jsonb NOT NULL,
  payload_hash   char(64) NOT NULL,
  status         varchar(12) NOT NULL,
  source         varchar(16) NOT NULL CHECK (source IN ('device','review','override','revalidate')),
  changed_by     uuid NOT NULL REFERENCES users(id) ON DELETE PROTECT,
  device_id      uuid NULL REFERENCES devices(id) ON DELETE PROTECT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, version)
);

-- ── Sync observation log (append-only) ────────────────────────────────────
CREATE TABLE sync_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  event_type      varchar(32) NOT NULL,   -- see §15.3
  request_id      uuid NOT NULL,
  user_id         uuid NULL,
  device_id       uuid NULL,
  facility_id     uuid NULL,
  submission_id   uuid NULL,
  client_uuid     uuid NULL,
  client_attempt  smallint NULL,          -- attempt number reported by the device
  latency_ms      integer NULL,
  detail          jsonb NOT NULL DEFAULT '{}'   -- non-PII only (codes, counts, versions)
);
CREATE INDEX sync_events_occurred_brin ON sync_events USING brin (occurred_at);
CREATE INDEX sync_events_facility_time ON sync_events (facility_id, occurred_at DESC);
CREATE INDEX sync_events_type_time     ON sync_events (event_type, occurred_at DESC);
```

SimpleJWT's `token_blacklist_outstandingtoken` / `token_blacklist_blacklistedtoken` tables are added by its app migrations.

### 8.3 Schema decisions

- **`client_uuid` is UUIDv7** (48-bit ms timestamp + random): unique without coordination, and *time-ordered* so the unique B-tree index stays append-mostly rather than splitting random pages — measurable on write-heavy tables. The device's clock only affects index locality, never correctness.
- **`version` is the payload version.** A supervisor marking a submission `reviewed` without changing values does **not** bump it, so it cannot cause spurious conflicts with CHW edits. A supervisor *correction* (values changed) bumps it.
- **`received_at` is authoritative; `captured_at` is informational.** Field device clocks are routinely wrong by hours or years (dead RTC battery). We record skew (`client_clock_skew_ms`) from the `X-Client-Time` header and flag captures with |skew| > 10 min in the dashboard.
- **Invalid submissions are stored (`status='rejected'`) rather than dropped** (quarantine). A CHW may never get the chance to fix it (device lost, staff turnover); a supervisor can re-validate after a template fix (S7). Malformed envelopes (unknown template, wrong facility, non-JSON) are *not* stored.
- **`submission_versions`** gives history for conflict diffs, audit, and "who changed MUAC from 11.2 to 12.1".
- **`sync_events` uses BRIN on `occurred_at`** — append-only, physically time-ordered, so BRIN is ~1000× smaller than B-tree for the same pruning power. Retention: 180 days (management command, scheduled). Monthly partitioning is the documented next step when volume justifies it.
- **Server-side at-rest encryption of payloads** relies on volume encryption + RBAC + PII-free logs. Column-level encryption (pgcrypto) was rejected for the demo because it breaks server-side validation and review flows; documented as a production-hardening item (§19).

---

## 9. Data model — on-device (IndexedDB)

Database name: `fieldsync-u-<first 16 hex of SHA-256(user_id)>` — one database per user per browser profile. A bootstrap database `fieldsync-boot` holds only the list of known user hashes, display initials and the current active user (no PHI).

| Store | Key | Indexes | Encrypted? | Content |
|---|---|---|---|---|
| `meta` | `key` | — | No | Schema version, device id, simulator profile, last online timestamp |
| `keyring` | `'dek'` | — | Wrapped | `{ kdf:'PBKDF2-SHA256', iterations, salt, wrappedByPassword, wrappedByEscrow, createdAt, version }` |
| `session` | `'current'` | — | Handle | `{ dek: CryptoKey (non-extractable), userId, unlockedAt, expiresAt, pinVerifier? }` + encrypted cached profile |
| `templates` | `[code, version]` | `code` | No (not PHI) | Template definitions + ETag |
| `facilities` | `id` | — | No (not PHI) | Assigned facilities |
| `drafts` | `clientUuid` | `updatedAt` | **Yes** | In-progress form values, current step |
| `outbox` | `clientUuid` | `[state, nextAttemptAt]`, `createdAt`, `facilityId` | **Payload yes; queue metadata no** | Sync queue (below) |
| `receipts` | `clientUuid` | `createdAt` | **Summary yes** | Long-lived record that a submission exists, with non-PII status, server id/version; PHI summary encrypted |
| `sync_log` | auto | `at` | No (PII-free by construction) | Local sync events for the Sync screen and support (`request_id`, codes) — ring buffer, 1 000 entries |
| `dashboard_cache` | `scope` | — | No (aggregates only) | Last supervisor dashboard snapshot + `asOf` |

Outbox record:

```ts
type OutboxItem = {
  clientUuid: string;                // UUIDv7, primary key — at most ONE outbox entry per submission
  op: 'create' | 'update';
  templateCode: string; templateVersion: number;
  facilityId: string;
  state: 'PENDING' | 'SYNCING' | 'RETRY_WAIT' | 'SYNCED' | 'FAILED' | 'CONFLICT';
  attempts: number;                  // requests that actually left the device
  nextAttemptAt: number;             // epoch ms; 0 = due now
  leaseUntil: number | null;         // crash recovery for SYNCING
  baseVersion: number | null;        // for updates: last server version this edit was based on
  resolution: 'none' | 'override' | 'merge';
  dirtyAfterSync: boolean;           // edited while SYNCING → re-queue after ack
  serverId: string | null; serverVersion: number | null;
  lastError: { class: ErrorClass; code: string; requestId: string | null; at: number } | null;
  capturedAt: number; createdAt: number; updatedAt: number;
  enc: { iv: Uint8Array; ct: ArrayBuffer };          // AES-GCM( {payload, patientLabel} )
  encSummary: { iv: Uint8Array; ct: ArrayBuffer };   // tiny blob for list rendering
  conflict: { iv: Uint8Array; ct: ArrayBuffer } | null; // encrypted server copy on 409
};
```

Invariants (asserted in tests): plaintext fields never contain PHI; `state='SYNCED'` ⇒ `enc` purged (payload deleted from device after acknowledgement — data minimisation) and the item is moved to `receipts`; `state='SYNCING'` ⇒ `leaseUntil != null`.

---

## 10. API design

### 10.1 Conventions

- Base path `/api/v1/`. JSON, UTF-8. Request bodies may be `Content-Encoding: gzip` (bounded decompression, §11.8).
- Every response uses the envelope:

```json
{
  "success": true,
  "data": { },
  "error": null,
  "meta": { "request_id": "0b5c…", "api_version": "1", "pagination": { "next_cursor": "…", "limit": 50 } }
}
```

```json
{
  "success": false,
  "data": null,
  "error": { "code": "conflict_version", "message": "This submission was changed on the server.", "details": { "server_version": 4 } },
  "meta": { "request_id": "0b5c…", "api_version": "1" }
}
```

- `error.message` is human-readable English for logs/dev tools; the PWA localises by `error.code`, never by message.
- Validation `details` contain **field paths and rule codes, never submitted values** (prevents PHI echo into logs/proxies).
- Lists use **keyset pagination** (`cursor` = opaque base64 of `(received_at, id)`), never `OFFSET`.
- Request headers from the PWA: `Authorization: Bearer <access>`, `X-Request-ID` (optional, validated UUID), `X-Client-Time` (ISO-8601), `X-App-Version`, `X-Device-ID`.

### 10.2 Error codes

> The authoritative list is [`contracts/error-codes.json`](../contracts/error-codes.json) (code, HTTP status, client class). This table explains the queue effect of each class.

| HTTP | `error.code` | Client classification → queue effect |
|---|---|---|
| 400 | `malformed_request`, `template_unknown` | permanent → `FAILED` |
| 413 / 415 | `payload_too_large`, `unsupported_media_type` | permanent → `FAILED` |
| 401 | `token_invalid`, `token_expired` | auth → refresh once, else engine `PAUSED_AUTH`, item back to `PENDING` (attempt not counted) |
| 401 | `device_revoked` | → crypto-shred local data (§11.7) |
| 403 | `facility_forbidden`, `permission_denied` | permanent → `FAILED` |
| 409 | `conflict_version` | → `CONFLICT` (server copy attached) |
| 409 | `client_uuid_foreign` | permanent → `FAILED` (UUID belongs to a different user — should be impossible; logged as security event) |
| 422 | `validation_failed` (stored as `rejected`) | permanent → `FAILED` with field errors; *Fix & resend* |
| 422 | `template_retired` | permanent → `FAILED`; offer migrate-to-current-version |
| 429 | `rate_limited` (+`Retry-After`) | transient → `RETRY_WAIT` (Retry-After as floor) |
| 5xx | `server_error`, `unavailable` (+`Retry-After`) | transient → `RETRY_WAIT` |
| — | network error / timeout (30 s) | transient → `RETRY_WAIT`; feeds circuit breaker |

### 10.3 Endpoints

| Method & path | Roles | Purpose |
|---|---|---|
| `POST /auth/login` | public (throttled) | `{username, password, device:{id, label, app_version}}` → `data:{access, access_expires_at, user, device:{id, escrow_secret}}`; sets refresh cookie |
| `POST /auth/refresh` | cookie | Rotate refresh token (cookie), return new access. Requires `X-Requested-With: fieldsync` (CSRF defence in depth) |
| `POST /auth/logout` | auth | Blacklist refresh token, clear cookie |
| `GET /auth/me` | auth | Profile, role, scope (county, facility ids) |
| `GET /devices` / `POST /devices/{id}/revoke` | admin (supervisor: own county's CHWs) | Device registry and revocation |
| `GET /counties`, `GET /facilities` | auth (scoped) | Reference data; `ETag` |
| `GET /form-templates` | auth | Current published + still-accepting versions; `ETag`/`If-None-Match` → 304 |
| `GET /form-templates/{code}/versions/{v}` | auth | One immutable version |
| `POST /form-templates` · `PATCH …/{id}` · `POST …/{id}/publish` · `POST …/{id}/retire` | admin | Lifecycle (draft editable; published immutable) |
| `POST /submissions` | chw, supervisor | **Idempotent upsert** on `client_uuid` (§12.4) |
| `POST /submissions/batch` | chw, supervisor | ≤ 25 items, ≤ 512 KB decompressed; per-item results; optional `device_state` heartbeat piggy-back |
| `GET /submissions` | scoped | Keyset-paginated list; filters: facility, status, template, date range |
| `GET /submissions/{id}` | scoped | Detail incl. current version |
| `GET /submissions/{id}/versions` | supervisor, admin | History |
| `POST /submissions/{id}/review` | supervisor, admin | `{status: reviewed|flagged, note?, payload?, base_version}` — payload present ⇒ correction (bumps version) |
| `POST /submissions/{id}/retry` | supervisor, admin | Re-validate a `rejected` submission against its template version (or a specified newer version of the same template code) → `accepted` or still `rejected` with updated errors. Records `source='revalidate'`. Idempotent. |
| `GET /submissions/sync-status` | scoped | Per-facility sync-health aggregation (§14) |
| `POST /sync/heartbeat` | auth | Device queue state when there is nothing to upload |
| `GET|HEAD /health/live` | public | Process up (used by circuit breaker probe) |
| `GET /health/ready` | public | DB reachable + migrations applied |
| `GET /metrics` | admin token or internal network | Prometheus exposition |
| `GET /schema`, `/docs`, `/redoc` | public (dev), admin (prod) | OpenAPI 3.1 |
| `POST /demo/supervisor-edit/{client_uuid}` | demo mode only | Simulator conflict injection; route not registered unless `FIELDSYNC_DEMO_MODE=1` |

> **Note on "retry" semantics.** There are two retries and they are deliberately different. *Client retry* (Sync Status → Retry) re-sends a queued item from the device — it needs no endpoint because the upsert is idempotent. *Server retry* (`POST /submissions/{id}/retry`) re-runs validation for a quarantined submission already on the server, e.g. after a template defect is fixed.

### 10.4 Submission request/response (single and per batch item)

```jsonc
// POST /api/v1/submissions/batch
{
  "items": [
    {
      "client_uuid": "01936f2e-6a3b-7c1e-9d4f-2a8b5c6d7e8f",
      "op": "create",                       // or "update"
      "template": { "code": "iccm-child-u5", "version": 3 },
      "facility_id": "…",
      "captured_at": "2026-11-19T09:14:03Z",
      "base_version": null,                 // required for op=update
      "resolution": "none",                 // "override" | "merge" after a conflict
      "attempt": 2,
      "payload": { "patient_ref": "HH-0042-03", "age_months": 26, "fever": true, "rdt_result": "positive", "muac_mm": 118 }
    }
  ],
  "device_state": { "facilities": [ { "facility_id": "…", "pending": 11, "failed": 0, "conflicts": 0, "stuck": 0, "oldest_pending_at": "…" } ] }
}

// 200 — batch transport succeeded; inspect each result
{
  "success": true,
  "data": {
    "results": [
      { "client_uuid": "01936f2e-…", "outcome": "created", "http_status": 201,
        "submission": { "id": "…", "status": "accepted", "version": 1, "received_at": "…" } },
      { "client_uuid": "01936f2f-…", "outcome": "replayed", "http_status": 200, "submission": { … } },
      { "client_uuid": "01936f30-…", "outcome": "conflict", "http_status": 409,
        "error": { "code": "conflict_version", "details": { "server_version": 4 } },
        "server_copy": { "version": 4, "payload": { … }, "changed_at": "…", "changed_by_role": "supervisor" } },
      { "client_uuid": "01936f31-…", "outcome": "rejected", "http_status": 422,
        "error": { "code": "validation_failed", "details": { "fields": { "muac_mm": ["max"] } } },
        "submission": { "id": "…", "status": "rejected", "version": 1 } }
    ]
  },
  "error": null,
  "meta": { "request_id": "…" }
}
```

Outcomes: `created | updated | replayed | conflict | rejected | forbidden | invalid`. Batch is **not** atomic (Unit of Work per item) — a deliberate choice so one bad record can't block a CHW's whole day.

---

## 11. Security and authentication

### 11.1 Threat model (STRIDE-lite, scoped to a demo of a field system)

| Threat | Asset | Control |
|---|---|---|
| Lost/stolen phone, attacker opens browser | PHI in IndexedDB | Envelope encryption; session handle expires (≤ 12 h) → password required; quick-unlock PIN gates UI; device revocation + crypto-shred on reconnect |
| Forensic dump of browser profile | PHI, keys | Ciphertext + PBKDF2-600k-wrapped DEK. **Limitation:** while a session is unlocked, the non-extractable DEK handle is in the profile; a forensic attacker with the device *during an active session* can use it. Bounded by session expiry and idle lock. Documented, not hidden. |
| XSS → exfiltrate tokens/keys | Refresh token, DEK | Refresh token `HttpOnly`; access token in memory only; DEK non-extractable; strict CSP (no inline script, no third-party origins); React escaping; no `dangerouslySetInnerHTML` (lint rule) |
| CSRF on refresh | Session | Same-origin, `SameSite=Strict`, path-scoped cookie, required `X-Requested-With` header, Origin check |
| Replay / duplicate submissions | Data integrity | Idempotency on `client_uuid` + payload hash |
| Lost update (concurrent edits) | Data integrity | Optimistic concurrency on `version`; conflicts surfaced |
| Horizontal privilege escalation (CHW reads other facility) | PHI | Queryset scoping in every view + object-level checks; integration tests per endpoint × role |
| Credential stuffing | Accounts | DRF throttle (IP + username), progressive lockout, Argon2id |
| PHI leakage via logs/metrics/errors | PHI | Log filter drops payload keys; error details carry codes not values; metrics labels never include patient fields; `sync_log` and `sync_events.detail` are PII-free by schema |
| PHI in HTTP caches | PHI | `Cache-Control: no-store` on all `/api` responses; SW never caches `/api` |
| Malicious template definition (admin) | Clients | Template meta-schema validation; regex rules restricted to a safe subset with length caps (ReDoS) |
| Zip bomb via gzip request bodies | API availability | Streaming decompression with 512 KB cap → 413 |
| Device clock manipulation | Ordering | Server never orders by client time; versions + `received_at` |

### 11.2 Authentication and session

```
 Login (online)                                   Server
  username + password + device{id,label} ───────► verify Argon2id, lockout check
                                                  upsert devices row (escrow_secret created on first registration)
                                                  issue access JWT (10 min) {sub, role, did, auth_time}
                                                  issue refresh JWT (14 d sliding, rotating) {sub, did, auth_time}
  ◄──── body: access, user, device.escrow_secret   Set-Cookie: fs_rt=…; HttpOnly; Secure; SameSite=Strict;
                                                  Path=/api/v1/auth/; Max-Age=1209600
```

- **Access token:** 10 minutes, held in memory only (page and SW each obtain their own via refresh). Contains `role` and `did` for fast checks; *scope* (facility ids) is resolved server-side per request, never trusted from the token.
- **Refresh token:** rotating, blacklisted after rotation (SimpleJWT `ROTATE_REFRESH_TOKENS` + `BLACKLIST_AFTER_ROTATION`), 14-day sliding lifetime, **30-day absolute cap** from `auth_time` (a CHW must re-enter their password online at least monthly). Refresh is refused if the device is revoked or the user inactive.
- **Single-flight refresh across contexts.** The page and the SW can both need a token at the same moment; with rotation, a naive double refresh makes the second one present a blacklisted token and logs the user out. All refreshes run inside `navigator.locks.request('fs-auth-refresh', …)`; the cookie jar is shared, so the second holder simply rotates again with the newest cookie.
- **Device check on writes:** the authentication class verifies `did` is not revoked (PK lookup, memoised per request) for all write endpoints — revocation takes effect immediately for writes, within ≤ 10 min for reads.
- **Cached session (offline):** the user profile and scope are cached **encrypted** in `session`. Offline unlock re-derives the KEK from the password (§11.4) — the server is not needed.
- **Expired token while offline:** irrelevant to capture. On reconnect the engine refreshes; if the refresh token has expired, the engine enters `PAUSED_AUTH`, items stay `PENDING` (attempts not counted), and the UI shows *Sign in to send N saved forms*. The queue survives because it is encrypted with the DEK, not with anything token-derived.

### 11.3 Authorisation (RBAC) on the server

| Resource / action | chw | supervisor | admin |
|---|---|---|---|
| Read facilities | assigned | county | all |
| Read templates (published) | ✓ | ✓ | ✓ |
| Manage templates | — | — | ✓ |
| Create/update submission | assigned facilities, own submissions | county facilities | all |
| Read submissions | own | county | all |
| Review / correct | — | county | all |
| Server retry (re-validate) | — | county | all |
| Sync status | own facilities + own devices | county | all (filter by county) |
| Revoke device | — | county CHWs' devices | all |
| Metrics / OpenAPI in prod | — | — | ✓ |

Implementation: a `Scope` value object is computed once per request from the user (`scope.facility_ids`, `scope.county_id`, `scope.is_national`). Every view's queryset goes through `ScopedQuerySet.for_scope(scope)`; object fetches on out-of-scope ids return **404, not 403**, so existence is not leaked. A test matrix (endpoint × role × in/out-of-scope) is generated, not hand-written, so new endpoints cannot skip it.

### 11.4 On-device encryption

#### 11.4.1 Key hierarchy

```
                password (never stored)           escrow_secret (32 B, server-held per device;
                      │                             delivered only in an authenticated online
                      │ PBKDF2-HMAC-SHA256           login response; never persisted on device)
                      │ 600 000 iters, 16 B salt            │ HKDF-SHA256(info="fs-escrow-kek-v1")
                      ▼                                     ▼
               KEK_pw (AES-KW-256,                   KEK_escrow (AES-KW-256,
               non-extractable)                      non-extractable)
                      │ wrapKey                             │ wrapKey
                      ▼                                     ▼
          keyring.wrappedByPassword            keyring.wrappedByEscrow
                      └──────────────┬──────────────────────┘
                                     │ unwrapKey (extractable = false)
                                     ▼
                     DEK (AES-GCM-256, random, generated on device)
                                     │  stored as a non-extractable CryptoKey handle in
                                     │  `session` with expiresAt (≤ 12 h) — usable by page AND SW
                                     ▼
       record = AES-GCM(DEK, iv = 96-bit random, aad = "fs:v1:<store>:<primaryKey>:<schemaVersion>")
```

#### 11.4.2 Why envelope encryption

- The DEK never changes, so a password change does not require re-encrypting the queue — only re-wrapping 32 bytes.
- **AAD binds ciphertext to its record and store**, so an attacker who can write to IndexedDB cannot swap one record's ciphertext into another record (GCM authentication fails).
- 96-bit random IVs are safe: the NIST bound (2³² invocations per key) is far beyond any device's lifetime volume.

#### 11.4.3 Why a server escrow wrap exists

Without it, a CHW whose password is reset by a supervisor (common: forgotten passwords) would lose every unsynced submission on the phone, because the DEK is wrapped by the old password. With escrow: on the next online login with the new password, the server returns the device's `escrow_secret`; the client unwraps the DEK via `KEK_escrow` (transiently extractable for the re-wrap only), re-wraps it under the new `KEK_pw`, and discards the transient copy. The escrow secret is never persisted on the device, so a thief without the password cannot use it. **Accepted risk:** an attacker holding *both* the server database plus the server escrow KEK *and* the physical device could decrypt that device's queue — documented.

#### 11.4.4 What is and isn't encrypted

Encrypted: drafts, outbox payloads and summaries, conflict server copies, receipt summaries (patient labels), cached profile. Not encrypted (and verified PII-free): queue metadata (state, timestamps, attempt counts, template code, facility id), templates, facility list, sync log, dashboard aggregates. Rationale: the engine must query the queue by `[state, nextAttemptAt]` without decrypting, and IndexedDB indexes cannot be built over ciphertext.

#### 11.4.5 Unlock, idle lock and PIN

- **Crypto boundary — password.** First login and every session expiry (12 h max, configurable; also on explicit *Lock*, *Switch user*, or 5 failed PIN attempts) require the password to unwrap the DEK. Offline password attempts are rate-limited locally (exponential delay after 5 failures); PBKDF2 cost bounds offline brute-force against a copied profile.
- **UI boundary — quick-unlock PIN (optional, 6 digits).** After 5 minutes idle the UI locks; the PIN re-opens it while the session handle is valid. **The PIN is a shoulder-surfing/casual-access control, not a cryptographic one** — it is documented as such. WebAuthn PRF (fingerprint-derived key) is the planned upgrade once Android Chrome support is broad (§19).

### 11.5 Logging and PII

- structlog processor `drop_phi` removes keys `payload`, `server_copy`, `patient_*`, `password`, `escrow_secret`, `access`, `refresh` at any depth; a unit test feeds a full submission through every log call path and asserts no field value appears.
- Django's default request logging of bodies is disabled; DRF validation error `details` are field paths/rule codes only.
- The PWA has no analytics SDK and no remote error reporting. `sync_log` stores codes and `request_id`s so a CHW can read a short support code (`FS-0b5c`) to a supervisor, who can find the server log line.

### 11.6 Transport and headers

- HTTPS only; HSTS `max-age=31536000; includeSubDomains` (preload documented as a production step); `SECURE_SSL_REDIRECT`, secure cookies.
- CSP (nginx and Django in sync): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. React and Motion set styles through the CSSOM, which CSP's `style-src` does not block, so no `'unsafe-inline'` is needed.
- `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Permissions-Policy: camera=(), microphone=(), geolocation=()` (geolocation enabled only if a template requests it — future).
- `/api` responses: `Cache-Control: no-store`.

### 11.7 Lost and shared devices — documented behaviour

**Lost or stolen device**

1. CHW or supervisor reports it. Supervisor (own county) or admin revokes the device in the dashboard/admin (`POST /devices/{id}/revoke`).
2. Server: device `revoked_at` set; all refresh tokens with that `did` are rejected; write endpoints reject its access tokens immediately.
3. Dashboard shows the device's **last reported** `pending` count per facility — the potential data loss is quantified, not invisible.
4. If the device reconnects: the first API call returns `401 device_revoked`; the client **crypto-shreds** — deletes `keyring` and `session` first (instantly making all ciphertext unrecoverable even if the next step is interrupted), then deletes the user's database.
5. If the device never reconnects: data stays encrypted; access requires the CHW's password (PBKDF2-600k). Session handles expire within 12 h.
6. The CHW's password should be reset (supervisor action); this also invalidates any offline-unlock attempts on a recovered device after the next online contact.

**Shared device**

- Each user gets a separate IndexedDB database and a separate DEK. One user is active at a time. *Switch user* locks the current user (drops their session handle); their queue remains on the phone, encrypted, and syncs next time **they** sign in. The dashboard shows it as pending on that device.
- *Sign out & erase* is separate from *Lock*. If unsynced items exist it shows a blocking dialog: "N forms have not been sent. If you erase, they will be lost permanently." Erase requires typing the count.
- Background Sync only runs for the currently unlocked user (the SW reads the active session handle).

---

## 12. Offline and sync design

### 12.1 Principles

1. Local first: the UI reads and writes IndexedDB; the network is an asynchronous replication concern.
2. Exactly-once *effect* via at-least-once delivery + idempotent server.
3. No head-of-line blocking: items are independent; a permanently failing item never blocks others.
4. Never silently drop: every non-success ends in a visible, actionable state on the device and is counted on the dashboard.
5. Don't waste the CHW's airtime: breaker gates attempts, batches are gzip'd, reference data uses conditional GETs.

### 12.2 Outbox item state machine

```
                         Save (atomic IDB txn: drafts→outbox→receipts)
     ┌─────────┐       ─────────────────────────────────────────────►  ┌───────────┐
     │  DRAFT  │                                                        │  PENDING  │◄───────────────────────────────┐
     │(drafts) │       edit while PENDING: payload replaced in place    └─────┬─────┘                                │
     └─────────┘       (same clientUuid; no second entry)                    │ claim: engine holds lock 'fs-sync',  │
          ▲                                                                   │ item due (nextAttemptAt ≤ now),     │
          │                                                                   │ breaker CLOSED/HALF_OPEN            │
          │                                                                   ▼ set leaseUntil = now + 60 s          │
          │                                                             ┌───────────┐   lease expired             │
          │                                                             │  SYNCING  │── (tab/SW killed) ──────────►┤
          │                                                             └─────┬─────┘                              │
          │                ┌──────────────────────────┬───────────────────────┼──────────────────────┐              │
          │                │ created / updated /       │ conflict_version      │ 4xx permanent        │ network /    │
          │                │ replayed (2xx)            │ (409)                 │ (400/403/422)        │ timeout/429/ │
          │                ▼                           ▼                       ▼                      │ 5xx          │
          │          ┌───────────┐              ┌────────────┐          ┌───────────┐                 ▼              │
          │          │  SYNCED   │              │  CONFLICT  │          │  FAILED   │          ┌─────────────┐      │
          │          │ payload   │              │ server copy│          │ field errs│          │ RETRY_WAIT  │──────┘
          │          │ purged →  │              │ (encrypted)│          │ shown     │          │ attempts+1, │ timer fires /
          │          │ receipts  │              └─────┬──────┘          └─────┬─────┘          │ backoff     │ breaker closes /
          │          └─────┬─────┘                    │                       │                └─────────────┘ manual Retry
          │                │ user edits synced        │ Keep mine / Combine   │ Fix & resend
          │                │ record → op=update,      │ → PENDING, base =     │ → DRAFT → Save
          │                │ base = serverVersion     │ server_version,       │   → PENDING
          │                ▼                          │ resolution=override/  │ Discard (confirm)
          └────────── (edit flow) ──► PENDING ◄───────┘ merge                 └─► removed (receipt kept,
                                                       Use server's →            status 'discarded')
                                                       SYNCED (receipt v = server)
```

**Item transitions (exhaustive table; anything else throws in dev):**

| From | Event | To | Side effects |
|---|---|---|---|
| — | `save` | PENDING | draft deleted, receipt written, `bus.enqueued`, schedule sync |
| PENDING | `edit` | PENDING | payload replaced (same key) |
| PENDING | `claim` | SYNCING | `leaseUntil = now+60s` |
| SYNCING | `ack(created|updated|replayed)` | SYNCED | `serverId/Version` stored; payload purged; receipt updated; if `dirtyAfterSync` → immediately new PENDING `op=update` with `baseVersion = serverVersion` |
| SYNCING | `conflict` | CONFLICT | encrypted server copy stored |
| SYNCING | `permanent(code)` | FAILED | `lastError` set |
| SYNCING | `transient(code, retryAfter?)` | RETRY_WAIT | `attempts++`, `nextAttemptAt = backoff(attempts, retryAfter)` |
| SYNCING | `auth_paused` | PENDING | attempts **not** incremented |
| SYNCING | `edit` | SYNCING | `dirtyAfterSync = true`, payload replaced (sent on next cycle) |
| SYNCING | `lease_expired` | PENDING | recovery on engine start |
| RETRY_WAIT | `due` / `breaker_closed` (network-class errors only) / `manual_retry` | PENDING | manual retry resets `nextAttemptAt = 0` (not attempts) |
| CONFLICT | `resolve(override|merge)` | PENDING | `baseVersion = server_version`, payload = chosen |
| CONFLICT | `resolve(accept_server)` | SYNCED | local edit discarded; receipt shows server version |
| FAILED | `fix_and_resend` | DRAFT → PENDING | values reopened in form runner |
| FAILED | `discard` | (removed) | receipt marked `discarded`; requires confirmation |
| SYNCED | `edit` | PENDING (`op=update`) | requires decrypted copy → re-fetched from server if online, else edit is disabled offline after purge (see §12.8) |

### 12.3 Engine state machine (global, not per item)

```
   IDLE ──schedule()──► DRAINING ──queue empty──► IDLE
     ▲                    │  │  │
     │                    │  │  └── breaker OPEN ─────► PAUSED_OFFLINE ──breaker CLOSED──┐
     │                    │  └── refresh failed ──────► PAUSED_AUTH ────user signs in────┤
     │                    └── session expired/locked ─► PAUSED_LOCKED ──unlock───────────┤
     └────────────────────────────────────────────────────────────────────────────────────┘
   Also: PAUSED_QUOTA (QuotaExceededError while writing results — engine stops claiming, surfaces storage warning)
```

The engine state drives the global banner: *Offline — 12 forms saved on this phone* / *Sending 4 of 12…* / *Sign in to send 12 forms* / *All sent · 14:02*.

### 12.4 Idempotency strategy

**Client.** Each submission gets a UUIDv7 `client_uuid` when the draft is created (not at save time), so autosaves, saves, retries and edits all share one identity. The outbox is keyed by it, which makes "two queue entries for one submission" impossible by construction.

**Server upsert algorithm** (per item, inside `transaction.atomic()`):

```
canonical  = canonical_json(payload)          # sorted keys, no whitespace, NFC strings
h          = sha256(canonical)
row        = SELECT … FROM submissions WHERE client_uuid = :u FOR UPDATE

if row is None:
    # op='update' with no row cannot happen: an update is only queued after a create was acked.
    if op == 'update':                                          → 400 malformed_request
    validate scope (facility ∈ scope.facility_ids)            else 403 facility_forbidden
    validate template accepting (published, or superseded/retired with accept_until > now) else 422 template_retired
    errors = validate(payload, template)
    INSERT … ON CONFLICT (client_uuid) DO NOTHING RETURNING id
        └─ if nothing returned (concurrent first insert won the race) → re-SELECT FOR UPDATE, fall through to "row exists"
    INSERT submission_versions(v1, source='device'); INSERT sync_events(submission.created | submission.rejected)
    return 201 created  |  422 rejected(stored)

if row.submitted_by != user and not scope.can_write(row.facility_id):
    return 409 client_uuid_foreign   (logged as security event; no data returned)

if row.payload_hash == h:                                  # same content → this is a retry
    INSERT sync_events(submission.replayed, client_attempt)
    return original outcome (200 replayed / 422 rejected) with current row

# different content → an edit
# override/merge are ordinary edits whose base_version was set to the server version the
# CHW saw in the conflict screen — they pass this check only if nobody wrote in between.
if base_version != row.version:
    INSERT sync_events(submission.conflict)
    return 409 conflict_version + server_copy
apply: payload, payload_hash, version += 1, status = 'accepted'|'rejected' (re-validated), updated_at
INSERT submission_versions(source = 'override' if resolution != 'none' else 'device')
INSERT sync_events(submission.updated | submission.conflict_resolved)
return 200 updated
```

Why the content hash matters: a retry of an *edit* whose response was lost arrives with `base_version = N` while the server is already at `N+1`. A pure version check would report a false conflict. Comparing the payload hash first recognises it as a replay. Hypothesis property test: for any interleaving of {send, lose-response, retry, duplicate, concurrent duplicate} the table contains exactly one row per `client_uuid` and the final payload equals the last *intended* payload.

### 12.5 Conflict resolution

Policy: **last-write-wins *with* a server version check** — a write wins only if it was based on the current version. A stale write is rejected with the server's copy, and a human decides. The server never auto-merges health data.

```
 CHW device (saw v3)                          API                                   Supervisor
                                                               ◄── corrects MUAC 118→121 (v3→v4)
 edits follow-up date offline
 outbox: op=update, base=3 ──── POST ──────► hash differs, base 3 ≠ 4
                             ◄── 409 conflict_version + server_copy v4
 CONFLICT screen:
   field diff vs base v3 (from receipt) :   muac_mm      118 → 121   (changed on server)
                                            followup_on  –   → 11-26 (changed by you)
   ┌───────────────────────┐  disjoint field sets → "Combine both (recommended)" pre-selected
   │ Combine both          │──► payload = server v4 + your changed fields, base=4, resolution=merge ──► 200 v5
   │ Keep my version       │──► payload = yours, base=4, resolution=override ──────────────────────────► 200 v5 (audited)
   │ Use server version    │──► discard local edit → SYNCED at v4
   └───────────────────────┘
```

- To compute *which fields you changed* the client keeps the encrypted base snapshot of the last-synced version for records with a pending `update` (only then — base snapshots are purged with the item).
- Overlapping field changes disable *Combine both*; the CHW chooses per field (radio per conflicting field).
- Every override/merge is recorded in `submission_versions.source` and `sync_events` (`submission.conflict_resolved` with `{resolution}`), and counted on the dashboard.

### 12.6 Retry and backoff policy

```
d(n)        = min(CAP, BASE · 2^(n-1))                   BASE = 5 s, CAP = 15 min
delay(n)    = d(n)/2 + random(0, d(n)/2)                 "equal jitter": spreads load, keeps a floor
delay       = max(delay(n), Retry-After)                 when the server sends Retry-After (429/503)
attempt n:  1→2.5–5 s  2→5–10 s  3→10–20 s  4→20–40 s  5→40–80 s  6→1.3–2.7 min  7→2.7–5.3 min  8→5.3–10.7 min  ≥9→7.5–15 min
```

- **Attempts only count requests that left the device.** While the breaker is OPEN nothing is attempted, so two days in the bush don't push items to the 15-minute cap.
- **When the breaker closes**, all `RETRY_WAIT` items whose last error was *network-class* become due immediately (staggered by 0–3 s jitter). Items waiting on a 5xx/429 keep their backoff — the server asked for patience.
- **No maximum attempt count for transient errors.** Data is never abandoned automatically. An item with `attempts ≥ 8` or age > 48 h is flagged **stuck**: shown prominently on the device and reported in the heartbeat so the supervisor sees it.
- Request timeout: 30 s (3G-appropriate) via `AbortController`.

### 12.7 Transport strategies, batching and scheduling

- `BackgroundSyncStrategy` (Chromium): after every save, `registration.sync.register('fs-outbox')`. The browser fires `sync` when connectivity returns, **even if the app is closed**; the SW runs `SyncEngine.drain()` under `event.waitUntil`. If drain leaves due work, the handler rejects so the browser reschedules.
- `ForegroundTimerStrategy` (all browsers, including Safari/Firefox): while visible, tick every 30 s, plus on `online`, `visibilitychange→visible`, and app start.
- `ManualStrategy`: *Sync now* button (also resets the breaker to HALF_OPEN).
- **Single consumer:** `drain()` runs inside `navigator.locks.request('fs-sync', { ifAvailable: true })`; a second context finding the lock taken simply returns. Leases (60 s) recover items orphaned by a killed SW/tab.
- **Batching with AIMD sizing:** start at 10 items per request; +2 after each fast success (< 3 s) up to 25; halve on timeout. A 500-item backlog drains in ~20–50 requests rather than 500. Request bodies are `gzip`-compressed with `CompressionStream` (form JSON typically compresses 4–6×).
- **Order:** due items in `createdAt` order (FIFO), so older captures go first; independent items so no head-of-line blocking.
- **Reference data refresh:** after a successful drain, `GET /form-templates` and `GET /facilities` with `If-None-Match` (usually a ~200 B 304).
- **Heartbeat:** piggy-backed on every batch (`device_state`); when the queue is empty, `POST /sync/heartbeat` at most every 30 min while online, so supervisors can distinguish "device alive, nothing pending" from "device silent".

### 12.8 Data retention on the device

- On acknowledgement the encrypted payload is **purged** from the device and a minimal encrypted receipt remains (patient label, template, status, server id/version) for 30 days, then pruned. Rationale: minimise PHI at rest on devices that get lost.
- Editing a synced submission therefore needs the server copy: online → fetched (`GET /submissions/{id}`), encrypted locally, then edited offline as needed. Fully offline edits of already-synced records are disabled with an explanatory message. This trade-off (minimisation over offline edit-after-sync) is deliberate and reversible via a per-template setting `retain_after_sync_days`.

### 12.9 Network failure mid-sync

| Failure point | Server state | Client state | Recovery |
|---|---|---|---|
| Before request leaves device | Nothing | SYNCING → RETRY_WAIT (network) | Normal retry |
| Request sent, server crashed before commit | Rolled back (per-item txn) | RETRY_WAIT | Retry creates it |
| Server committed, response lost | Row exists | RETRY_WAIT | Retry → `replayed` → SYNCED (no duplicate) |
| Batch partially committed, response lost | Some rows exist | All items RETRY_WAIT | Retry → mix of `replayed` and `created` |
| Tab/SW killed mid-request | Either | SYNCING with lease | Lease expiry → PENDING → retry (idempotent) |
| Device storage write of ack fails (quota) | Row exists | SYNCING | Engine → PAUSED_QUOTA; lease expiry later → retry → `replayed` |

### 12.10 Storage durability and quota

- At first unlock: `navigator.storage.persist()`; result recorded and shown in Settings (*Storage protected: Yes/No*). Chrome grants it to installed PWAs; on refusal the Help screen explains *Install FieldSync* steps.
- `navigator.storage.estimate()` checked at startup and after every 50 saves: warn at 80 % of quota, block *new* captures (not syncing) at 95 % with *Sync now* / *Free space* guidance.
- Every IDB write handles `QuotaExceededError`: autosave failure keeps the draft in memory and shows a non-dismissable banner; a failed **Save** never navigates away — the CHW does not lose the form.
- **iOS/Safari:** no Background Sync; script-writable storage of *non-installed* sites may be evicted after 7 days without interaction. FieldSync on iOS is supported only as an installed home-screen app; documented in the user guide.

### 12.11 App updates and migrations

- SW update mode is **prompt**, never auto-`skipWaiting`: an *Update ready* toast appears; if a draft is open, the update is deferred until the form is saved or closed.
- IndexedDB schema migrations are forward-only, versioned, idempotent functions run in `onupgradeneeded`; each has a unit test from the previous version's fixture DB. A migration never decrypts/re-encrypts payloads unless strictly necessary.
- API compatibility: the server accepts the current and previous minor client versions (`X-App-Version`); breaking API changes go to `/api/v2/`.

---

## 13. Form templates and validation

### 13.1 Template definition DSL (abridged)

```jsonc
{
  "code": "iccm-child-u5",
  "version": 3,
  "subject": "patient",
  "title": { "en": "Sick child visit (2–59 months)", "kpe": "[kpe] Sick child visit (2–59 months)" },
  "retain_after_sync_days": 0,
  "steps": [
    {
      "id": "child",
      "title": { "en": "Child" },
      "fields": [
        { "id": "patient_ref", "type": "text", "label": { "en": "Household / child ID" }, "required": true,
          "rules": { "pattern": "^HH-[0-9]{4}-[0-9]{2}$", "maxLength": 16 }, "pii": true },
        { "id": "age_months", "type": "integer", "label": { "en": "Age (months)" }, "required": true,
          "rules": { "min": 2, "max": 59 }, "widget": "stepper" },
        { "id": "sex", "type": "select", "widget": "cards", "required": true,
          "options": [ { "value": "f", "label": { "en": "Girl" } }, { "value": "m", "label": { "en": "Boy" } } ] }
      ]
    },
    {
      "id": "assessment",
      "title": { "en": "Danger signs & assessment" },
      "fields": [
        { "id": "fever", "type": "boolean", "required": true },
        { "id": "rdt_result", "type": "select", "required": true, "showIf": { "field": "fever", "equals": true },
          "options": [ { "value": "positive" }, { "value": "negative" }, { "value": "not_done" } ] },
        { "id": "muac_mm", "type": "integer", "widget": "muac", "rules": { "min": 80, "max": 200 } },
        { "id": "danger_signs", "type": "multiselect", "options": [ … ] }
      ]
    }
  ],
  "crossRules": [
    { "id": "refer_if_danger", "when": { "field": "danger_signs", "notEmpty": true },
      "require": "referred", "message": { "en": "Danger sign present — record referral." } }
  ]
}
```

Field types: `text`, `integer`, `decimal`, `boolean`, `select`, `multiselect`, `date`, `phone`. Rules: `required`, `min`, `max`, `minLength`, `maxLength`, `pattern` (safe subset: no backreferences/lookarounds, ≤ 128 chars, anchored), `pastOnly`/`futureOnly` for dates, `showIf` (equals / in / notEmpty), declarative `crossRules`. Hidden fields (by `showIf`) are stripped from the payload before validation and save — on both sides — so stale hidden values never reach the server.

### 13.2 One rule set, two engines, one conformance suite

The DSL validator is implemented **twice** — TypeScript (`core/validation`) and Python (`templates/validation.py`) — and both run the same fixture file `contracts/validation-cases.json` (template + input + expected errors) in their test suites. A third engine (generic JSON Schema via Ajv) was rejected: Ajv is ~35 KB gz and compiles validators with `new Function`, which our CSP forbids. Template *definitions themselves* are validated server-side against `contracts/form-template.schema.json` (Python `jsonschema`) on create/publish.

### 13.3 Versioning lifecycle

`draft → published → superseded → retired`. Publishing v4 supersedes v3 and sets v3's `accept_until = now + 30 days` (configurable): devices that captured on v3 offline still sync. After `accept_until`, v3 submissions get `422 template_retired`; the client offers *Open in current version* (values copied by field id; unmapped fields shown for re-entry). Published definitions are immutable (service rule + DB trigger).

---

## 14. Sync health model

### 14.1 Per-facility inputs

- From `device_facility_state` (device self-reports, scoped to non-revoked devices seen in the last 30 days): `pending`, `failed`, `conflicts`, `stuck`, `oldest_pending_at`, `last_success_at`.
- From `submissions` / `sync_events` (server truth): `submissions_24h`, `rejected_open` (quarantined, unresolved), `last_received_at`, first-attempt success rate and mean attempts-to-sync over 7 days (from `client_attempt` on acknowledged events — this captures failures that never reached the server, which the server otherwise cannot see).

### 14.2 Health status

| Status | Rule (first match wins; thresholds configurable per county) |
|---|---|
| `unknown` | No device has ever synced for this facility |
| `stale` | `now − last_success_at > 72 h` **or** `oldest_pending_at` older than 72 h |
| `degraded` | `last_success_at` 24–72 h ago, **or** `failed + conflicts + stuck > 0`, **or** `rejected_open > 0`, **or** 7-day first-attempt success rate < 80 % |
| `healthy` | Otherwise |

### 14.3 `GET /submissions/sync-status` response (abridged)

```jsonc
{
  "generated_at": "2026-11-19T15:00:00Z",
  "scope": { "county": "BG" },
  "thresholds": { "degraded_after_h": 24, "stale_after_h": 72, "min_first_attempt_success": 0.8 },
  "summary": { "facilities": 42, "healthy": 31, "degraded": 7, "stale": 3, "unknown": 1,
               "pending_on_devices": 186, "stuck": 4, "conflicts_open": 2, "rejected_open": 5,
               "first_attempt_success_7d": 0.91, "mean_attempts_7d": 1.3 },
  "facilities": [
    { "facility_id": "…", "code": "BG-HC-014", "name": "Demo Health Centre 14", "health": "stale",
      "last_success_at": "…", "pending_on_devices": 37, "oldest_pending_at": "…", "failed": 0,
      "conflicts": 0, "stuck": 3, "rejected_open": 1, "devices_active": 3, "devices_silent_72h": 1,
      "submissions_24h": 0, "first_attempt_success_7d": 0.62, "reasons": ["no_sync_72h", "stuck_items"] }
  ]
}
```

`reasons[]` makes the status explainable in the UI ("Why is this red?"). Aggregation is computed on read with two grouped queries (devices state, server counts) — O(facilities in scope), ~40–80 rows per county. A materialised rollup is the documented scale-up path, not built.

---

## 15. Observability

### 15.1 Request IDs

`RequestIdMiddleware` accepts a client `X-Request-ID` if it is a valid UUID (else generates UUIDv4), binds it into structlog contextvars, returns it as a header and in `meta.request_id`. The PWA stores it in `sync_log` per attempt and shows the 4-char support code on failures.

### 15.2 Structured logs

JSON lines: `ts, level, event, request_id, user_id, role, device_id, method, path_template, status, duration_ms` (+ domain fields such as `client_uuid`, `outcome`, `batch_size`). Path *templates* (`/api/v1/submissions/{id}`) not raw paths. PHI filter per §11.5.

### 15.3 Metrics (Prometheus)

| Metric | Type | Labels |
|---|---|---|
| `fieldsync_http_request_duration_seconds` | histogram | method, route, status_class |
| `fieldsync_submission_upserts_total` | counter | outcome (`created/updated/replayed/conflict/rejected/forbidden/invalid`), op |
| `fieldsync_sync_batch_size` | histogram | — |
| `fieldsync_client_attempts` | histogram (attempt number at acknowledgement) | outcome |
| `fieldsync_sync_success_ratio` | gauge (7-day, recomputed every 5 min) | county |
| `fieldsync_queue_depth_reported` | gauge (sum of device-reported pending) | county |
| `fieldsync_stuck_items_reported` | gauge | county |
| `fieldsync_duplicates_prevented_total` | counter (= replayed) | — |
| `fieldsync_conflicts_total` | counter | resolution (`open/override/merge/accept_server`) |
| `fieldsync_auth_events_total` | counter | event (`login_ok/login_fail/refresh/refresh_denied/device_revoked`) |

Labels are bounded (county = 15 values; no facility, user or patient labels — per-facility detail lives in the API, not in Prometheus, to avoid cardinality blow-ups).

`sync_events.event_type` values: `batch.received`, `submission.created`, `submission.updated`, `submission.replayed`, `submission.conflict`, `submission.conflict_resolved`, `submission.rejected`, `submission.revalidated`, `submission.reviewed`, `device.registered`, `device.heartbeat`, `device.revoked`, `auth.refresh_denied`.

---

## 16. Frontend architecture and UX

### 16.1 Screens and routes

| Route | Screen | Roles | Bundle |
|---|---|---|---|
| `/login` | Login (online), offline notice if no network and no cached user | all | critical |
| `/unlock` | Offline unlock (password) / PIN pad; user switcher for shared devices | all | critical |
| `/` | Home: *New submission* (bottom thumb-zone), pending badge, *My facility* health tile | chw | critical |
| `/new` | Template picker (patient / facility forms) | chw, supervisor | critical |
| `/form/:clientUuid` | Form runner: stepper, autosave, inline validation | chw, supervisor | critical |
| `/saved/:clientUuid` | Saved confirmation (offline vs sent states) | chw, supervisor | critical |
| `/sync` | Sync Status: grouped list, per-item actions, last-sync time | all | lazy |
| `/sync/:clientUuid` | Item detail / *Fix & resend* / conflict resolution | all | lazy |
| `/supervisor` | County dashboard (health grid, filters, facility drill-down) | supervisor, admin | lazy |
| `/simulator` | Offline sync simulator (demo/training) | all, demo mode | lazy |
| `/help` | Illustrated guide | all | lazy |
| `/settings` | Language, lock, switch user, sign out & erase, storage | all | lazy |

Supervisors land on `/supervisor`; CHWs on `/`. Admins land on `/supervisor` with the national filter and a link to Django admin for back-office.

### 16.2 State layout

- `core/` — framework-free TypeScript shared with the SW: crypto, repositories, sync engine, api client, validation, i18n catalog loader. No React imports (lint-enforced boundary).
- `stores/` — Zustand: `sessionStore` (user, lock state), `syncStore` (engine state, counts, per-item states — fed by the event bus), `simStore` (simulator profile).
- `features/*` — screens and components per feature; `ui/` — owned shadcn components.

### 16.3 Visual language

- **Outdoor-first palette:** near-black text on off-white (contrast ≥ 12:1 for body), one strong primary (deep teal), semantic status colours with icon + text (never colour alone): pending (amber + clock), sending (blue + arrows), sent (green + check), failed (red + alert), conflict (purple + split). Dark theme for night visits.
- Type: system stack; base 17 px, form labels 18 px, primary buttons 18 px semibold; line-height 1.5.
- Tap targets ≥ 48×48 px, ≥ 8 px apart; primary actions in the bottom 40 % of the screen; sticky bottom action bar in forms (*Back* / *Next*, *Save* on last step).
- Minimal typing: card-style choices, ± steppers, MUAC tape-colour selector (red/yellow/green bands with mm entry), native date input, auto-advance on single-choice steps (with undo).

### 16.4 Interaction and states

- Every async surface has explicit **loading** (skeletons matching final layout), **empty** (illustration + next action), **offline** (what still works), and **error** (what happened + support code + action) states.
- Micro-interactions: save check-morph, queue badge count-up, card slide on step change (transform/opacity only, 150–220 ms), item status chip transitions on the Sync screen. All disabled under `prefers-reduced-motion`.
- Screen-reader: sync engine state announced via a polite `aria-live` region (*"3 forms sent. 2 waiting for network."*), throttled to avoid chatter.

### 16.5 Performance tactics

Route-level splitting; `LazyMotion`; no date library (`Intl`); no lodash; SVG illustrations inlined in Help chunk only; list virtualisation (simple windowing) on Sync screen beyond 100 items; IndexedDB reads by index, never full-store scans in render paths; encrypt/decrypt off the main thread is **not** needed initially (Web Crypto is already async and native) — revisited in the Self-Code Review with measurements.

### 16.6 Multilingual UI

- `en` complete. Second locale: **Kpelle (`kpe`)** — the most widely spoken Liberian indigenous language — shipped as a **placeholder**: every string is rendered as a pseudo-localised `[kpe] …` form so untranslated strings are obvious and layouts are tested for ~30 % expansion. **No machine-generated Kpelle is shipped**; the locale file carries a header noting that strings require a qualified translator and community review. The catalogue format (flat JSON with ICU-style plural keys) is translator-friendly. Template labels use the same `{ en, kpe }` maps.
- Locale switch is instant (lazy chunk), persisted per user.

### 16.7 Offline sync simulator (the "wow" feature)

Purpose: make the invisible visible — for supervisors and trainers, and as a **training mode** for CHWs.

- **Controls:** network profile — *Online*, *Offline*, *3G* (400 ms RTT, 400 kbps simulated by delay = RTT + bytes/bandwidth), *Flaky* (30 % requests dropped before send, 20 % **acknowledgement lost after the server committed**), *Server trouble* (server returns 503 + `Retry-After` via demo fault header). Buttons: *Add 5 / 50 / 500 synthetic forms*, *Supervisor edits a synced record* (conflict injection), *Sync now*, *Reset demo data*.
- **Visualisation:** three animated lanes — **On this phone** → **Sending** → **Server** — with one card per item showing state chip, attempt count, and a live backoff countdown. Breaker indicator (Closed/Open/Half-open). Live event log. Counters: queue depth, sent, retries, **duplicates prevented** (server `replayed` outcomes), conflicts.
- **Honesty:** the simulator talks to the **real API** through the `NetworkConditions` decorator on `ApiClient`; the server really commits, really replays and really reports conflicts. Only the network is simulated. The profile is persisted in `meta` so the SW's background engine honours it too.
- Server-side fault injection and the demo route exist only when `FIELDSYNC_DEMO_MODE=1`; production settings assert it is off at startup.

### 16.8 Accessibility

WCAG 2.2 AA: contrast, focus visible (3 px ring, not colour-only), logical focus order through stepper, `aria-describedby` linking inline errors, error summary at top of step on submit attempt, labelled icon buttons, `prefers-reduced-motion`, text resizable to 200 % without loss, target size ≥ 24 px (we use 48). axe-core zero violations on every route in light and dark themes (CI gate).

---

## 17. Testing strategy

| Level | Tooling | Must cover |
|---|---|---|
| Unit (PWA) | Vitest, fake-indexeddb, Node Web Crypto | Outbox transition table (every legal + illegal transition); backoff (bounds, jitter, Retry-After floor, breaker-close reset); AIMD batch sizing; circuit breaker; UUIDv7 monotonicity; crypto helpers (round-trip, AAD tamper → fail, wrong key → fail, IV uniqueness, non-extractability); keyring re-wrap via escrow; validation conformance fixtures; i18n key completeness |
| Unit (API) | pytest | Canonical JSON + hash; validation engine conformance fixtures; health-status rules; envelope renderer; PHI log filter; gzip bounded decompression |
| Integration (API) | pytest-django + **real PostgreSQL** + Hypothesis | Upsert: create / replay / update / conflict / override / merge; **no duplicates on retry** (property test with random interleavings, and a true concurrency test with two DB connections racing on one `client_uuid`); batch partial success; RBAC matrix (endpoint × role × in/out scope, generated); device revocation; refresh rotation + blacklist + absolute cap; template lifecycle + accept window; quarantine + server retry; sync-status aggregation against hand-computed fixtures |
| Component | Testing Library | Form runner (showIf, inline errors, autosave calls), conflict diff UI, sync list states |
| E2E | Playwright (Chromium + mobile viewport), `context.setOffline()` | S1: offline → fill → reload → still there → online → synced (assert server count); failed sync + retry (server 503 then recovery); lost-ack duplicates (simulator Flaky) → server count exact; conflict resolution; expired token while offline → sign-in prompt → sync; 500-item queue drains; quota-exceeded save path (stubbed `estimate`/`QuotaExceededError`); axe scan per route |
| Performance | size-limit, Lighthouse CI profile, Vitest bench, `scripts/loadtest.py` | Budgets in §4 |

Edge-case checklist tracked in Phase 5 QA report: empty states everywhere; network failure mid-sync (each row of §12.9); duplicate submissions; expired token offline; 500-item queue; storage quota exceeded; clock skew; template retired while queued; device revoked while items pending; shared-device switch with pending items; SW update during an open draft.

---

## 18. Deployment and environments

- **docker-compose (dev/demo):** `db` (postgres:16-alpine, healthcheck), `api` (python:3.12-slim, gunicorn, non-root, read-only rootfs, migrations on start), `web` (unprivileged nginx: built PWA + `/api` proxy + security headers). One origin: `http://localhost:8090` (see §20 deviation 1). `make up`, `make seed` (synthetic counties/facilities/users/templates), `make demo`.
- **Settings modules:** `base`, `dev`, `demo`, `test`, `prod`. `prod` asserts: `DEBUG=False`, `DEMO_MODE=False`, secure cookies, HSTS, non-default secrets, `ALLOWED_HOSTS` set.
- **Secrets** via env (`.env.example` documents every variable): `DJANGO_SECRET_KEY`, `JWT_SIGNING_KEY`, `ESCROW_KEKS` (key-id → key, for rotation), `DATABASE_URL`, `FIELDSYNC_DEMO_MODE`.
- **CI (GitHub Actions):** `backend` (ruff, mypy --strict, `makemigrations --check`, pytest with Postgres service, OpenAPI drift check), `frontend` (eslint, tsc, vitest, build, size-limit, generated API types drift), `contracts` (validation fixtures parity), `e2e` (compose up → Playwright → axe).
- **Production notes (documented, not built):** TLS termination at nginx/ingress, HSTS preload, managed Postgres with encrypted volumes and PITR, log shipping, Prometheus scraping, backup/restore runbook in the Maintenance Guide.

---

## 19. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| CHW clears browser data / uninstalls with unsynced items | Medium | High | `persist()`, training + Help copy, dashboard shows last-reported pending per device so loss is visible; Settings shows "N forms not yet sent" prominently |
| Background Sync unavailable (iOS/Firefox) | Certain on those platforms | Medium | Foreground timer strategy; Android Chrome is the primary target; documented |
| iOS 7-day eviction for non-installed sites | Medium on iOS | High | Install-only support statement for iOS |
| PBKDF2-600k too slow on lowest-end devices | Medium | Medium (UX) | Iterations stored per keyring; measured in Phase 5; floor 310k with documented deviation if needed; unlock happens once per session |
| Forensic attacker on an *unlocked* device | Low | High | Session ≤ 12 h, idle lock, revocation + crypto-shred; documented limitation |
| Escrow (server + device) compromise | Low | High | Escrow KEK separate from DB, rotatable (`escrow_key_id`); documented |
| Device clock wrong | High | Low | Server time authoritative; skew recorded and flagged |
| Template change breaks queued submissions | Medium | Medium | Immutable versions, 30-day accept window, quarantine + server retry |
| Placeholder Kpelle mistaken for real translation | Medium | Medium | Pseudo-loc rendering + header disclaimer; translator workflow in Maintenance Guide |
| Server-side PHI at rest | Medium | High | Volume encryption + RBAC in demo; column-level encryption/tokenisation listed as production hardening |
| WebAuthn PRF quick-unlock not yet universal | — | — | PIN as UI gate now; PRF as planned upgrade |

---

## 20. Decision log and deviations

Locked decisions (changes require an entry below with reason):

| # | Decision |
|---|---|
| D1 | Separate repo `FieldSync`; React 18 + TS strict + Vite 5; Tailwind 3.4 (Chrome ≥ 87 support) + owned shadcn components; Motion via LazyMotion |
| D2 | Sync queue is a framework-free module shared by page and SW; Zustand is a projection; no React Query |
| D3 | IndexedDB via `idb`; one database per user; PHI encrypted per record with AES-GCM + AAD; queue metadata plaintext and PII-free |
| D4 | Envelope encryption: random DEK wrapped by PBKDF2-600k password KEK and by server-escrow KEK; non-extractable DEK session handle ≤ 12 h; PIN is a UI gate only |
| D5 | Access JWT in memory (10 min); refresh JWT in `HttpOnly SameSite=Strict` path-scoped cookie, rotating, 14 d sliding / 30 d absolute, device-bound (`did`); Web Locks single-flight refresh |
| D6 | Same-origin deployment (nginx proxies `/api`); no CORS |
| D7 | Idempotency: UUIDv7 `client_uuid` created with the draft; outbox keyed by it; server upsert compares payload hash before version |
| D8 | Concurrency: payload `version`; stale writes → 409 with server copy; override/merge are explicit, audited writes; server never auto-merges |
| D9 | Invalid but well-formed submissions are quarantined (`rejected`), not dropped; `POST /submissions/{id}/retry` re-validates server-side |
| D10 | Backoff: exponential 5 s→15 min, equal jitter, Retry-After floor; attempts count only sent requests; no automatic abandonment; "stuck" flag at ≥ 8 attempts or 48 h |
| D11 | Batch endpoint (≤ 25, AIMD sizing), gzip request bodies, per-item Unit of Work |
| D12 | Payload purged from device on acknowledgement (data minimisation); offline edit of synced records disabled by default |
| D13 | Validation DSL implemented in TS and Python, shared conformance fixtures; no Ajv |
| D14 | Kpelle placeholder via pseudo-localisation; no machine translation |
| D15 | No `/api` responses in Cache Storage; `Cache-Control: no-store` |

Deviations (filled in during Phases 2–5):

| # | Phase | Change | Reason |
|---|---|---|---|
| 1 | 2 | Demo stack publishes the PWA on **:8090** (not :8080), Postgres on **:5434**, host-run API on **:8001**; all configurable in `.env` | Coexist with other local stacks (Sentinel uses 8080/8000/5432) |
| 2 | 2 | `payload_too_large` is **HTTP 413** (§10.2 listed 400); added codes `invalid_credentials`, `account_locked`, `not_acceptable`, `method_not_allowed`, `unsupported_media_type`, `not_found`. `contracts/error-codes.json` is now the single source of truth, with a `class` per code driving queue transitions | Correct HTTP semantics; one machine-readable contract instead of a prose table |
| 3 | 2 | Django apps join incrementally: Phase 2 ships only `fieldsync.common` (envelope, errors, middleware, health, metrics); `contrib.auth`/admin, the custom user model and domain apps arrive together in Phase 3 | Avoid a throwaway initial auth migration; the custom user model must exist before the first `auth` migration |
| 4 | 2 | API docs (Swagger UI/Redoc) are self-hosted via `drf-spectacular-sidecar` + WhiteNoise under `/api/static/` with a docs-only CSP | No CDN dependency; `/api` is the only prefix nginx proxies |
| 5 | 2 | Logging scrubber **replaces** sensitive values with `[redacted]` (keys kept) rather than removing keys | Presence of a field is useful when debugging; values are what must never leak |
| 6 | 2 | The `kpe` placeholder renders as `⟦kpe⟧ <English> ··` (padding ≈ 30 %) and is generated from `en.json`; CI fails if it is stale | Makes untranslated text unmistakable and exercises layout expansion (§16.6) |
| 7 | 2 | Backend runtime image installs from a **hash-pinned** `requirements.lock` (pip-tools, `--require-hashes`); CI checks it is current and runs `pip-audit` | Supply-chain integrity for a health system |
| 8 | 2 | Phase 2's first screen is a **Device check** (offline readiness, encryption, storage protection/quota, background sync, server readiness) at `/device-check`; it stays as a Settings/Help tool after Phase 3 adds Home | Gives CHWs and supervisors a pre-field readiness check; exercises every platform capability the sync design depends on |
| 9 | 3 | **Own-writes rule** in the upsert (§12.4): a stale `base_version` is *not* a conflict when every newer server version was written by the same device. Also covers `op=create` re-sent with new content after a lost ack | Without it, a device that edits again after an earlier edit's acknowledgement was lost would get a false conflict against its own write |
| 10 | 3 | Lease recovery is **lock-aware**: while the engine holds the `fs-sync` Web Lock, every `SYNCING` item is orphaned (the browser releases locks when their holder dies) and is recovered immediately; the 60 s lease remains the fallback without Web Locks | Found in E2E: a reload mid-batch left items waiting a full minute for nothing |
| 11 | 3 | Claims and results are applied in **one IndexedDB transaction per batch** (`Vault.applyMany`), encryption done before the transaction | Per-item transactions made a 500-item drain IDB-bound; one transaction per batch is the dominant saving on low-end phones (Phase 5 measures it) |
| 12 | 3 | Single-item upsert errors return the result alongside the error: 409 carries `data.server_copy`, 422 carries the quarantined `data.submission` | One envelope shape for "error + result"; the batch endpoint reports the same per item |
| 13 | 3 | Health model refinement (§14.2): **never synced + nothing waiting = `unknown`** regardless of device heartbeats; never synced + forms waiting = `degraded` (`never_synced`) until the oldest passes 72 h (`stale`) | Found in E2E: a supervisor phone's zero-count heartbeat turned "no data" facilities into "not syncing" |
| 14 | 3 | Devices send zero-count state rows only for facilities the user is **assigned to as a CHW**; otherwise only for facilities where they hold forms | Supervisor/admin scope is a whole county or country; their phones would otherwise inflate "Phones" counts everywhere |
| 15 | 3 | **Send now** = manual retry of everything in backoff, then drain (not just "drain what is due") | Matches what a CHW means by the button; backoff still applies to automatic retries |
| 16 | 3 | nginx forwards `Host: $http_host` (keeps the port) | Found in E2E: `$host` drops the port, so the refresh endpoint's same-origin check refused every session restore (403) behind a non-443 port |
| 17 | 3 | The "ready to work offline" confirmation is a self-dismissing toast under the header; only "update ready" (needs a decision) is a bottom sheet, placed above the navigation bar | Found in E2E: a bottom sheet on first install covered the Sign in button on phone-sized screens |
| 18 | 3 | Demo routes are always registered but answer 404 unless `FIELDSYNC_DEMO_MODE` is on (checked per request) | Same external behaviour as "not registered"; lets tests toggle demo mode without reloading URLConf |
| 19 | 3 | Login throttle is configurable (`THROTTLE_LOGIN`, default 10/min/IP); `make e2e` and CI raise it for the test stack only | The E2E suite legitimately signs in many times from one IP |
| 20 | 3 | Response serializers are read-only and method fields are typed, so required response fields are required in `openapi.json` | Generated TypeScript types were optional where the server always sends a value |
| 21 | 3 | The PIN record is persisted (encrypted DB meta) as well as in the session record, so a PIN survives lock → password unlock | The ADD stored it only in the session handle, which every lock deletes |
| 22 | 4 | A fourth theme, **Outdoor** (maximum contrast: black on white, darker borders/inputs, saturated status text, no tinted fills), alongside System / Light / Dark. Theme and language are stored in the boot database (no PHI) and applied **before first render**, including on the login screen | §16.3 promised "outdoor readability"; a dedicated theme serves bright sunlight better than the light palette, and CHWs may need their language before signing in |
| 23 | 4 | Responsive shell: a **side navigation rail at ≥ 1024 px**; on phones the bottom tab bar is **hidden on form routes** (focus mode) and the form owns a fixed action bar | Found in the visual review: tab bar + action bar took ~170 px of a 780 px screen and overlapped the field being filled; desktop wasted the width |
| 24 | 4 | The first-install confirmation is an **in-flow strip** under the header that pushes content down and dismisses itself (refines deviation 17) | Visual review: a floating toast still covered page titles on phones |
| 25 | 4 | Chart **fill** tokens (`--viz-critical/warning/unknown/good`) are separate from the darker `--status-*` **text** tokens and were validated with the dataviz palette validator in bar order (worst adjacent CVD ΔE 12.5 light / 14.7 dark; normal-vision ≥ 20); label ink per fill ≥ 4.5:1. Selection is shown with an outline ring — never by dimming with opacity | The text tokens failed as adjacent fills (red↔amber ΔE 2.8 for deuteranopia); axe caught opacity-dimmed labels at 1.8–2.1:1 |
| 26 | 4 | Contract change: template field `unit` may be an **i18n map** (unit words such as "months"); a bare string remains valid and means a language-neutral symbol ("mm", "°C") rendered with `translate="no"` | Found by the pseudo-locale coverage test: unit words were shown in English beside localised labels. Backward-compatible: published (immutable) templates stay valid |
| 27 | 4 | SPA accessibility: a route announcer sets `document.title` from the page `<h1>`, moves focus to it and announces it; it waits for the **new** heading because exit transitions keep the old one mounted briefly | WCAG 2.4.2/2.4.3; the race was caught by the focus test |
| 28 | 4 | Button labels may wrap (no `nowrap` in the primitive); the body uses `overflow-wrap: break-word`; small buttons still have 48 px targets | Reflow test (WCAG 1.4.10): long labels overflowed by 63–80 px at 320 px, worst with pseudo-locale expansion |
| 29 | 4 | The language choice is **persisted before** the catalogue chunk loads | Found in the full E2E run: a reload during the lazy load lost the choice |
| 30 | 4 | i18n completeness is enforced by an **E2E pseudo-locale coverage gate** (every visible text node on every screen must carry the `⟦kpe⟧` marker unless it is data) rather than a lint rule | Catches strings assembled at runtime and template content, which static analysis misses |
| 31 | 5 | Device queue state rides on the **first** batch of a drain only, and a heartbeat with the post-drain state is sent as soon as anything was acknowledged (§12.7 sent it with every batch) | Found in Phase 5: the state was computed before the batch's acks, so dashboards showed phones as "waiting" after everything had arrived (QA P5-1) |
| 32 | 5 | `Vault.applyMany` / `logMany` **pipeline** IndexedDB requests (issue all, await once); `listDue` reads at most `limit` records per state from the index | Measured: 500-item drain at 4× CPU 29.6 s → 8.5 s (QA B1–B2) |
| 33 | 5 | The service worker registers **after `load` + idle**, not at boot | Measured: precache competed with first paint on 3G; cold load 8.9 s → ~6 s (QA B5). Lazy-loading the form routes was measured and rejected (QA B6) |
| 34 | 5 | Root route **error boundary** (`RouteError`) | A lazy chunk that fails to download must not leave a blank screen (QA P5-6) |
| 35 | 5 | *Fix and send again* after `template_retired`/`template_unknown` moves the answers to the newest published version on the phone (answers to removed questions dropped); non-field failures show plain-language reasons, never raw codes | Edge case "template retired while queued" could otherwise never be resolved by the CHW (QA P5-3/4) |
| 36 | 5 | API: principal resolved in one query; per-process template resolution cache (30 s TTL, invalidated by publish/retire); scrape-time sync gauges memoised 60 s (`SYNC_METRICS_CACHE_SECONDS`) | Measured: −2 of 10 queries per upsert; national `sync_status` ≈ 0.3 s was too costly per 15 s scrape (QA B8–B9) |
| 37 | 5 | New operational commands: `rotate_escrow` (re-seal device escrow under the active KEK) and `prune_sync_events` (retention, `SYNC_EVENT_RETENTION_DAYS`, default 180) | §11.4.3 rotation could not retire an old key; §8.3 retention needed an executable job |
| 38 | 5 | `seed_demo` refreshes its time-relative device reports on every run; `--reset-device-states` (used by `make e2e` and CI) drops throwaway-device reports | The demo dashboard aged from "degraded" to "stale" ~52 h after seeding and failed E2E (QA P5-5) |
| 39 | 5 | API budget "p95 ≤ 150 ms at 50 req/s on 2 vCPU" is **not verified** on the development host; a stdlib open-loop load generator (`scripts/loadtest.py`) is provided for the target environment | The laptop's Docker VM got ≈ 1 physical core; projection and set-based batch refactor in QA §5.4 / R1 |
| 40 | 5+ | **Admin form builder in the PWA** (`/admin/forms`, admin role only): list every template version, create, edit drafts (steps, questions, eight answer types, choices, per-type rules, units, display widgets, `showIf` conditions, identifier flag, Kpelle labels), live preview with the field team's own widgets and engine, publish, new version, copy, retire, delete draft. New admin endpoints: `GET /form-templates/manage`, `GET`/`DELETE /form-templates/{id}`, `POST /form-templates/validate` (dry run). Published versions open read-only | §13.3 left authoring to the API/Django admin; administrators need to create and maintain many field forms without developers. The builder generates valid ids and option values from labels and only offers rules a type allows, and the server still validates every save |
| 41 | 5+ | **Network-strength meter** in the header (0–4 bars + word, details dialog with server response time, phone network type and speed estimate, *Check now*). Inputs: timing of small API requests already made, a ~200-byte probe when nothing was measured for 45 s while visible, and the Network Information API where available; replaces the Online/Offline text chip | Workers need to know whether *now* is a good moment to send; `navigator.onLine` says nothing about reaching the server (captive Wi-Fi, dead cells) |
| 42 | 5+ | Product framing: no "demonstration" notices in the UI or user-facing documents; the footer shows the app version; sample data from `seed_demo` uses generic facility names and fictional person names | The owner asked for production framing. The seed data remains synthetic and is documented as such |

---

## 21. Phase plan and exit criteria

| Phase | Deliverables | Exit criteria |
|---|---|---|
| **1 — Blueprint** ✅ | This ADD | Reviewed; decisions D1–D15 accepted |
| **2 — Scaffolding** ✅ | Monorepo layout (`backend/`, `frontend/`, `contracts/`, `infra/`, `docs/`, `scripts/`), Dockerfiles, docker-compose (db, api, web), `.env.example`, Makefile, shared contracts (template meta-schema, validation fixtures, generated API types pipeline), SW config (`injectManifest`), lint/type/test tooling, CI skeleton | `make up` serves an installable empty shell on :8080 with `/api/v1/health/ready` green; CI green |
| **3 — Core** ✅ | Models + migrations; auth (login/refresh/logout, cookie, device registry, escrow); facilities/counties; templates lifecycle; idempotent submissions (single/batch), review, retry, versions; sync-status + heartbeat; OpenAPI. PWA: app shell, keyring/crypto, repositories, sync engine (strategies, breaker, backoff, leases, locks), ApiClient, login/unlock, home, form runner, saved, sync status, conflict UI, supervisor dashboard, simulator | All integration tests for §17 API rows pass; S1–S3 runnable manually |
| **4 — Polish** ✅ | Tailwind design tokens, shadcn components, Motion, skeletons, responsive layouts (mobile/tablet/desktop), accessibility pass, i18n (en + kpe placeholder), Help illustrations | axe zero violations; size-limit within budget; visual review on 360 px, 768 px, 1280 px |
| **5 — QA** ✅ | Unit/integration/E2E suites, edge-case checklist, measured performance, Self-Code Review (bottlenecks: IndexedDB write throughput, encryption overhead, aggregation queries; refactor proposals), plain-language CHW User Guide, Maintenance Guide | CI fully green including E2E; QA report published in `docs/` |
