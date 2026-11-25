# FieldSync — QA Report (Phase 5)

Scope: the complete system as of Phase 5. The PWA (`frontend/`), the API (`backend/`), the
shared contracts (`contracts/`) and the compose stack (`infra/`, `docker-compose.yml`).
Companion documents: [TESTING-CHECKLIST.md](TESTING-CHECKLIST.md) (manual field pilot),
[USER-GUIDE.md](USER-GUIDE.md) (CHWs), [MAINTENANCE.md](MAINTENANCE.md) (operators).

> FieldSync is a portfolio demonstration. All data is synthetic. Every measurement below was
> taken on a development laptop, not on target phones or servers. Section 5.1 describes the
> environment and how far the numbers can be trusted.

**Summary**

- **Automated gates:** backend 217 tests (92 % line coverage), frontend 182 unit/component
  tests, E2E 21 tests × 2 viewports (final full run 41/42; the one failure was a sign-in timeout during a host load spike and passed on rerun, §2.1). Lint, strict typing, migrations, OpenAPI drift and bundle
  budgets are green.
- **Edge cases:** all 11 edge cases in ADD §17 have automated evidence (§4). Two of them
  exposed real defects that are now fixed: the save-with-full-storage path and the
  retired-template path.
- **Defects:** Phase 5 found and fixed 10 defects (§6.3). The most important was that
  **supervisors saw phones as "waiting" after every form had arrived**, because the queue
  report was sent before the acknowledgements. The demo database still held 107 such phantom
  reports from Phase 3 test runs.
- **Performance:** a 500-form drain went from 29.6 s to 8.5 s of on-device work at 4× CPU.
  Through the real API on emulated Slow 3G it takes **61 s** (budget 2 min). Cold load is
  **at** the 6 s budget with no margin. The API's 150 ms @ 50 req/s budget is **not verified**:
  the laptop could not provide two dedicated vCPUs. §5 explains why, and refactor R1 gives
  the path to headroom.

---

## 1. How to reproduce

```bash
make check                       # ruff, mypy --strict, pytest (real PostgreSQL), eslint, tsc,
                                 # vitest, contract drift, build, size-limit
make up && make e2e              # Playwright + axe on mobile and desktop Chromium

# Performance (opt-in; needs the Vite dev server for the in-browser core benches)
cd frontend && npx vite --port 5179 --strictPort &
PERF=1 PERF_DEV_URL=http://localhost:5179 E2E_BASE_URL=http://localhost:8090 \
  PERF_OUT=/tmp/perf.json npx playwright test perf --project=desktop-chromium --workers=1
LOADTEST_PASSWORD=<seeded password> python3 scripts/loadtest.py --rate 50 --duration 60
```

---

## 2. Test inventory

| Suite | Tooling | Files | Tests | What it covers |
|---|---|---|---|---|
| API unit + integration | pytest, pytest-django on **real PostgreSQL**, Hypothesis | 18 | 217 | Envelope and error contract, middleware (request id, gzip bomb, size caps, headers), PHI log scrubber, UUIDv7, settings guards (`prod` refuses unsafe config), auth (login, lockout, rotation + blacklist, absolute cap, CSRF/same-origin refresh, revocation, escrow + rotation), RBAC matrix (endpoint × role × in/out of scope), idempotent upsert (create/replay/update/conflict/override/merge/own-writes/quarantine/re-validation), **property test over random action interleavings**, **true concurrency test with two DB connections**, batch partial success and gzip, template lifecycle and resolution cache, sync-health classification and aggregation, domain metrics, retention, seed |
| Validation conformance | the same 39 cases in `contracts/validation-cases.json` run by both engines | 2 | 39 + 39 | Python and TypeScript validators agree on every rule, type, `showIf` and cross-rule |
| PWA unit | Vitest, fake-indexeddb, Node Web Crypto | 11 | 179 | Outbox transition table (every legal and illegal transition), engine (S1–S3, 500-item drain, AIMD, breaker, backoff with Retry-After, leases and locks, auth pause, revocation, device-state reporting), vault (bounded `listDue`, pipelined `applyMany`, sync-log ring buffer), quota handling, crypto (round trip, AAD tamper, wrong key, non-extractable keys, escrow re-wrap), session (offline unlock, rate limiting, PIN, 12 h expiry, crypto-shred, **shared-phone switch**), HTTP client (single-flight refresh, error classification from the contract), UUIDv7, i18n (completeness, placeholders, pseudo-locale), update holds |
| Component | Testing Library | 1 | 3 | Device check |
| E2E | Playwright on mobile (Pixel 7) and desktop Chromium, axe-core | 4 + 2 opt-in | 21 per project | Install/offline cold start, cache and security headers, S1 offline capture → reload → sync exactly once, S2 lost acknowledgement, server 503 → backoff → recovery, S3 conflict → combine, supervisor dashboard, empty states, storage full during Save, session expired while offline, keyboard-only form, focus management, 320 px reflow (English + pseudo-locale), pseudo-locale coverage of every visible string, theme/language persistence, axe on every screen in light, dark and outdoor |
| Performance | Playwright + CDP throttling, `scripts/loadtest.py`, size-limit | 2 | — | §5 |
| Visual review | Playwright screenshots (`VISUAL_DIR`) | 1 | — | 360 / 768 / 1280 px × light / dark / outdoor (manual review, Phase 4) |

Two suites are opt-in because they need extra set-up or take long (`PERF=1`,
`VISUAL_DIR=`); they show as *skipped* in a normal `make e2e`.

### 2.1 E2E stability on this host

The suite was run in full five times during Phase 5. Every failure lined up with a host load
spike from other workloads on the same laptop, and each failed test passed when re-run
alone:

| Run | Host load (1-min peak) | Result | Failures |
|---|---|---|---|
| 1 | ~55 | 36 / 40 | *storage full during Save* (both viewports): **real defect P5-2**; *supervisor dashboard* (both): **real defect P5-5** |
| 2 | 81 | 36 / 38 (+2 did not run) | S3 conflict (both): *Edit this form* stayed disabled for 60 s. It is disabled only while `navigator.onLine` is false; macOS's network daemon was busy during the spike. Passed 2/2 on rerun. Not reproduced. |
| 3 | 399 | 34 / 39 | 5 timeouts across the desktop project |
| 4 (final) | 288 | **41 / 42** | keyboard-only form (mobile): the 30 s sign-in wait expired during PBKDF2 under load. Passed 3/3 on rerun. |
| Perf | 122 (5-min) | 2 / 3 | Real-API drain: the test went offline before the service worker finished installing (a consequence of fix B5). The test now waits for offline readiness, as a CHW does (checklist 1.4); the simulator now reports such failures instead of failing silently. |

Treat a red run on a loaded machine as "re-run first". R7 (hermetic E2E on dedicated CI
runners) removes this ambiguity.

---

## 3. Requirement traceability

| Requirement (ADD) | Evidence |
|---|---|
| Works fully offline after first sign-in (§12.1) | E2E `the shell cold-starts offline after the first visit`, `S1: capture offline, reload offline, reconnect, synced exactly once`; session unit `lock drops the session handle; offline unlock needs the password` |
| Encrypted on-device storage, AES-GCM, non-extractable keys (§11.4) | `crypto.test.ts` (7); `session.test.ts` `first online sign-in creates an encrypted vault…`; manual 5.9 |
| Password reset keeps unsynced data (escrow, §11.4.3) | `a supervisor password reset keeps unsynced data via escrow re-wrap`; API `test_escrow_*`, `test_rotate_escrow_command_*` |
| Idempotent sync, no duplicates (§12.4) | API `test_create_then_replay_is_idempotent`, `test_batch_lost_response_retry_creates_no_duplicates`, `test_concurrent_first_inserts_produce_one_row`, Hypothesis `test_any_interleaving_yields_one_row_with_the_last_intended_payload`; engine S2; E2E S2 (server count exact) |
| Retry with exponential backoff + jitter, Retry-After floor (§12.6) | `states.test.ts`, engine `honours Retry-After on 503 and counts the attempt`; E2E `server trouble: retry with backoff, then recover` |
| Conflict handling, never auto-merged silently (§12.5) | API `test_stale_edit_is_a_conflict_with_server_copy`, `test_conflict_resolved_by_explicit_override`, own-writes tests; engine S3; E2E S3 |
| Background sync / triggers, crash recovery (§12.7) | engine lease and lock tests; E2E S1 (reload mid-flow) |
| Supervisor dashboard with sync health (§14) | API `test_classification_rules`, `test_heartbeat_and_aggregation`, scope tests; seed test covers every health state; E2E `supervisor dashboard explains facility health` |
| RBAC (§11.3) | `test_rbac.py` (11 functions, generated matrix); auth scope tests |
| Configurable templates, versioning, accept window (§13) | `test_templates.py` (9), contracts tests, `test_unknown_and_retired_templates`, `test_server_retry_revalidates_after_template_fix` |
| Client + server validation, one rule set (§13.2) | 39 conformance cases × 2 engines |
| Multilingual UI with placeholder language (§16.6) | `i18n.test.ts`; E2E pseudo-locale coverage and 320 px reflow with text expansion |
| Accessibility WCAG 2.2 AA (§16.8) | axe zero violations on every screen in three themes; keyboard-only and focus E2E; manual 8.4–8.5 (TalkBack, large text) |
| OpenAPI documentation (§10) | `test_openapi.py` (schema validates, no warnings); drift check |
| Observability (§15) | `test_metrics.py`, `test_metrics_domain.py`, `test_logging.py` (PHI scrubber), request-id middleware tests |
| Budgets (§4) | §5 below |

---

## 4. Edge-case checklist (ADD §17)

| # | Edge case | Expected behaviour | Evidence | Result |
|---|---|---|---|---|
| E1 | Empty states | Every list explains what will appear and what to do | E2E `a new device shows explanatory empty states` (Home, banner, Sync) | ✅ (fixed a duplicate live region on desktop, §6.3 P5-8) |
| E2 | Network failure mid-sync — before the request leaves | SYNCING → RETRY_WAIT, normal retry | engine breaker/backoff tests; E2E `server trouble…` | ✅ |
| E3 | … server crashed before commit | Rolled back per item; retry creates it | API per-item transaction tests; property test | ✅ |
| E4 | … server committed, response lost | Retry → `replayed`, no duplicate | API `test_batch_lost_response_retry_creates_no_duplicates`; engine S2; E2E S2 | ✅ |
| E5 | … batch partially committed, response lost | Mix of `replayed` and `created` | API `test_batch_partial_success_and_device_state`; property test | ✅ |
| E6 | … tab/service worker killed mid-request | Lease expiry (or held lock) → PENDING → retry | engine `recovers items orphaned in SYNCING…`, `with the sync lock held…` | ✅ |
| E7 | … ack received but storing it fails (quota) | Engine → PAUSED_QUOTA; later replay | `quota.test.ts` `engine PAUSED_QUOTA then recovery as a replay` | ✅ |
| E8 | Duplicate submissions | Exactly one row per `client_uuid`; resends answered as replays | E4 evidence + concurrency test + `fieldsync_duplicates_prevented_total` | ✅ |
| E9 | Expired token while offline | Forms wait; *Sign in again*; then they send | E2E `session expired while offline…`; engine `expired session pauses without counting attempts` | ✅ |
| E10 | 500-item queue | Drains in AIMD batches; UI stays responsive (paged list) | engine `drains a 500-item backlog…`; perf drain via real API on Slow 3G (61 s); Sync screen pages 50 at a time | ✅ |
| E11 | Storage quota exceeded | Autosave failure visible; Save never navigates away; nothing lost; retry works | `quota.test.ts`; E2E `storage full during Save…` | ✅ **after fix P5-2** |
| E12 | Clock skew | Server time authoritative; skew recorded and flagged | API `test_clock_skew_is_recorded` | ✅ |
| E13 | Template retired while queued | Item FAILED with a plain explanation; *Fix and send again* moves answers to the newest version | API `test_unknown_and_retired_templates`; runtime fix P5-4 (manual 4.4 on device) | ✅ **after fixes P5-3, P5-4** |
| E14 | Device revoked while items pending | Engine stops; data crypto-shredded; server refuses | engine `…revocation stops the engine`; API `test_revocation_takes_effect_immediately_for_access_tokens`, `test_refresh_refused_for_revoked_device` | ✅ |
| E15 | Shared-device switch with pending items | Each user's forms stay sealed under their own password and survive switching | `session.test.ts` `shared phone: switching user keeps the first CHW's unsent forms sealed and intact` (added in Phase 5) | ✅ |
| E16 | SW update during an open draft | Update waits for every hold (open form) | `update-store.test.ts` `defers activation until every hold is released` | ✅ |

---

## 5. Performance

### 5.1 Environment and trustworthiness

| | |
|---|---|
| Host | 4-thread Intel laptop (macOS 13), shared with an IDE, other agents' Docker stacks (a DHIS2 instance during most runs) and the Docker Desktop VM |
| Host load average during runs | 10–55 for runs 1–2, ~10–25 for run 3, ~4–10 for the final run |
| Browser | Playwright Chromium, desktop; **4× CPU throttling via CDP** to approximate a low-end Android phone |
| Network emulation | CDP *Slow 3G*: 400 ms RTT, 400 kbit/s each way |
| API | 2 gunicorn workers × 4 threads (`gthread`), PostgreSQL 16, same host |

**Caveats.** CPU throttling of a desktop core is only a proxy for a 2–3-year-old Android
phone. Real devices differ in IndexedDB implementation, storage speed and thermal
throttling, so the field checklist (§1, §2, §9) must confirm these numbers. Run-to-run
variation on this host was large: the same 1× keyring creation measured 0.73 s and 2.6 s in
two runs. Small differences between runs are noise; the large effects reported below
(≥ 2×) reproduced in every run.

### 5.2 Results against the ADD §4 budgets

Two runs are reported: **run 3** (all performance fixes, host load ≈ 10–25, the quietest available) and the **final run** (all Phase 5 fixes, started at load 13 right after the host recovered from a reboot and a load spike of ~300; its p95 tails are inflated by bursts).

| Budget (ADD §4) | Measured | Verdict |
|---|---|---|
| Critical JS ≤ 170 KB target / 200 KB limit (gzip) | 149.8 KB | ✅ |
| Critical CSS ≤ 25 KB | 7.0 KB | ✅ |
| Service worker | 17.5 KB (limit 30 KB) | ✅ |
| First load, Slow 3G + 4× CPU: interactive ≤ 6 s | 6.0 s (run 3) · 6.2 s (final); was 8.9 s | ⚠️ **at the limit, no margin** — §5.5 |
| Repeat load (SW) ≤ 1.5 s | 0.92 s (run 3) · 1.31 s (final) | ✅ |
| Save (encrypt + atomic write) p95 ≤ 50 ms at 4× CPU | 41 ms (run 3) · 114 ms (final, under load bursts); was 72.9 ms | ✅ in the quiet run; p95 is load-sensitive — confirm on devices |
| Autosave p95 ≤ 20 ms at 4× CPU | 20.8 ms (run 3) · 41 ms (final) | ⚠️ marginal (B10) — debounced and off the input path |
| 500 pending without UI degradation | Sync screen data for 500 items: 148 ms (run 3) · 361 ms (final) at 4× (was 601 ms); list paged 50 at a time | ✅ |
| Drain 500 on simulated 3G ≤ 2 min | **61 s** through the real API (23 batch requests), Slow 3G + 4× CPU | ✅ |
| Offline unlock (PBKDF2-SHA256 600k) ≤ 3 s | 0.69 s (run 3) · 1.72 s (final) p50 at 4× desktop CPU | ✅ on the proxy; **must be confirmed on a low-end phone** (risk B7) |
| API single upsert p95 ≤ 150 ms at 50 req/s on 2 vCPU | Not achievable on this host: saturates at ~40–45 req/s (both workers at 100 % CPU, the Docker VM receiving ~1 physical core). At 20 req/s: server-side p50 28.5 ms / p95 125 ms; client-side p95 191 ms–902 ms between runs | ⚠️ **not verified** — §5.4 |

### 5.3 On-device core benchmarks (real Chromium IndexedDB and Web Crypto)

Three runs; run 1 is before the Phase 5 fixes, run 2 after the first round (sync-log batching,
bounded `listDue`, one device-state read per drain, deferred SW), run 3 after pipelining
IndexedDB requests. Values in ms.

| Measure | Run 1 1× | Run 3 1× | Run 1 4× | Run 2 4× | Run 3 4× |
|---|---|---|---|---|---|
| Keyring create (PBKDF2 600k + wraps) | 731 | 729 | 1,793 | 859 | 507 |
| Unlock p50 / p95 | 590 / 671 | 889 / 1,526 | 1,149 / 1,478 | 777 / 1,080 | 686 / 965 |
| Seal ~1.5 KB p50 / p95 | 0.1 / 0.3 | 0.1 / 0.2 | 0.6 / 4.1 | 0.7 / 2.7 | 0.5 / 2.5 |
| Open ~1.5 KB p50 / p95 | 0.1 / 0.2 | 0.1 / 0.2 | 0.4 / 3.1 | 0.4 / 2.3 | 0.3 / 1.5 |
| Autosave p50 / p95 | 1.1 / 5.4 | 0.7 / 1.9 | 5.2 / 32.7 | 4.7 / 25.5 | 4.5 / 20.8 |
| Save p50 / p95 | 3.1 / 11.3 | 1.7 / 3.5 | 13.0 / 72.9 | 11.2 / 43.4 | 9.9 / 41.4 |
| Sync screen, 500 queued (decrypt summaries) | 71 | 44 | 601 | 187 | 148 |
| Read outbox, 500 queued, p50 | 41 | 32 | 62 | 90 | 45 |
| **Drain 500 forms, batched** (in-page fake server) | 8,903 | **1,232** | 29,638 | 14,787 | **8,510** |
| Drain 500, one transaction per item (comparison) | 6,613 | 2,753 | 39,345 | 14,913 | 14,271 |

Profile of a 500-item drain at 4× CPU before pipelining (wall 9.6 s; calls overlap):
`applyMany` 6.5 s over 47 calls (claim + ack per batch), `outboxPayload` 2.4 s (500
decrypts, concurrent), `logMany` 1.5 s, `listDue` 0.8 s. After pipelining, wall 5.9 s with
`applyMany` at 75 ms per call (was 137 ms).

**Final run** (all Phase 5 fixes; host recovering, see §5.1). Medians are consistent with
run 3, and the batched drain was the fastest measured. The p95 tails are not representative.

| Measure (final run) | 1× | 4× |
|---|---|---|
| Keyring create / unlock p50 | 1,108 / 1,097 | 1,844 / 1,722 |
| Seal p50 / p95 · open p50 / p95 | 0.1 / 0.8 · 0.1 / 1.4 | 0.6 / 3.0 · 0.4 / 2.4 |
| Autosave p50 / p95 | 1.0 / 2.5 | 4.0 / 41 |
| Save p50 / p95 | 2.6 / 7.4 | 9.0 / 114 |
| Sync screen, 500 queued | 101 | 361 |
| **Drain 500, batched** | 2,675 | **5,293** |
| Drain 500, one transaction per item | 4,365 | 14,711 |

**Encryption overhead** is negligible next to IndexedDB: sealing a 1.5 KB form is 0.1 ms at
1× and ~0.5 ms at 4× (p50). The expensive crypto is intentional and paid once per session:
PBKDF2 at 600,000 iterations (0.5–0.9 s at 4×).

### 5.4 API and database

**Single upsert, in process** (100 requests after warm-up, Django test client inside the
API container): mean 37 ms → **30 ms** after removing two queries per request (principal
lookup in one join; per-process template resolution cache). 8 SQL statements remain:
device+user, facility scope, row lock, savepoint/insert/release, version insert,
sync-event insert. About a third of the time is psycopg waiting on PostgreSQL; the rest is
ORM/DRF CPU (SQL compilation alone ~8 ms).

**Open-loop load test** (`scripts/loadtest.py`; arrivals scheduled at a constant rate and
latency measured from the scheduled time, so a slow server cannot hide its queue;
3 CHW accounts; 90 % new forms, 10 % resends):

| Rate | Achieved | Statuses | p50 | p95 | p99 |
|---|---|---|---|---|---|
| 50 req/s (before query fixes) | 38.5 | 2,495 × 201, 248 × 200, 7 × 502 | 4,251 ms | 16,709 ms | 17,808 ms |
| 50 req/s (after) | 45.5 | 2,493 × 201, 256 × 200, 1 × 502 | 3,537 ms | 5,275 ms | 6,082 ms |
| 30 req/s | 29.7 | all 2xx | 64 ms | 693 ms | 1,038 ms |
| 20 req/s (run A) | 20.0 | all 2xx | 42 ms | 902 ms | 1,336 ms |
| 20 req/s (run B; server-side from logs) | 20.0 | all 2xx | 42 ms (server 28.5) | 191 ms (server 125) | 376 ms (server 245) |
| Batch of 25, 2 req/s (= 50 forms/s) | 2.0 | all 200 | 692 ms | 3,526 ms | 4,635 ms |

Interpretation:

- At 50 req/s the API container used **188 % CPU** (both workers saturated), while macOS
  showed the whole Docker VM receiving about **one physical core**. The host, not the
  dedicated 2 vCPU the budget specifies, is the limit. The 502s are gunicorn worker
  timeouts under that overload; phones treat them as transient and retry.
- At 20–30 req/s the median is fine, but the tail varies from 191 ms to 902 ms between
  identical runs. That is host scheduling noise (the server's own p95 in run B was 125 ms).
- **Per-item batch cost (~28 ms) is no cheaper than single upserts**, so a batch saves round
  trips, not server CPU. This is the main server-side inefficiency (B8 → R1).
- Projection for 2 dedicated vCPU, at ~20 ms CPU per upsert: ~2 / 0.020 ≈ 100 req/s capacity,
  so 50 req/s is ~50 % utilisation and p95 should land under 150 ms. **This is a projection,
  not a measurement.** Run `scripts/loadtest.py` on the target environment before a pilot.

**Sync-status at national scale** (824 facilities, 213 k submissions, 515 k sync events,
generated inside a rolled-back transaction): median **314 ms**, max 802 ms
(seeded demo: 39 ms). The dashboard is fine with this; it was too costly for a 15 s
Prometheus scrape, so the scrape-time gauges are now memoised for 60 s (B9).

### 5.5 Page load

| | Run 1 | Final |
|---|---|---|
| Cold (Slow 3G + 4× CPU, to the login heading) | 8,860 ms | 6,005 ms (run 3) · 6,163 ms (final) |
| Bytes before the login screen | 156 KB | 156 KB |
| Repeat (service worker) | 1,455 ms | 923 ms (run 3) · 1,312 ms (final) |

The cold-load fix was **not** making the bundle smaller. Registering the service worker at
boot started a ~570 KB precache that competed with the login page's own requests on a
50 KB/s link. Registration now waits for `load` plus idle (B5). Lazy-loading the three form
screens was measured too: only −3.5 KB gz (~70 ms), so it was rejected, because it would add
a chunk download that can fail offline on a first visit (B6).

---

## 6. Defects

### 6.1 Found by E2E in Phase 3 (fixed then; ADD §20 deviations)

| Ref | Defect | Fix |
|---|---|---|
| P3-1 (dev. 10) | Reload mid-batch left items waiting a full lease (60 s) | Lock-aware lease recovery |
| P3-2 (dev. 13) | Supervisor phones' zero heartbeats turned "no data" facilities into "not syncing" | Health-model refinement |
| P3-3 (dev. 16) | nginx `$host` dropped the port; every session restore refused (403) | Forward `$http_host` |
| P3-4 (dev. 17) | First-install bottom sheet covered **Sign in** on phones | Toast, later in-flow strip |
| P3-5 (dev. 9) | False conflicts against the device's own earlier write after a lost ack | Own-writes rule |

### 6.2 Found in Phase 4 (accessibility, i18n and visual review)

| Ref | Defect | Fix |
|---|---|---|
| P4-1 (dev. 25) | Status colours indistinguishable as adjacent chart fills for deuteranopia (ΔE 2.8); opacity-dimmed labels at 1.8:1 | Validated `--viz-*` fill tokens; selection by ring |
| P4-2 (dev. 26) | Unit words ("months") shown in English beside localised labels | `unit` may be an i18n map |
| P4-3 (dev. 27) | Route announcer read the *old* heading during exit transitions | Wait for the new heading |
| P4-4 (dev. 28) | Long labels overflowed by 63–80 px at 320 px | Wrapping buttons, `overflow-wrap` |
| P4-5 (dev. 29) | Language choice lost on reload during catalogue load | Persist before loading |

### 6.3 Found in Phase 5

| Ref | Severity | Defect | How found | Fix |
|---|---|---|---|---|
| P5-1 | **High** (wrong information to supervisors) | Queue state rode on each batch **before** its acknowledgements and was never re-reported. A phone that had sent everything still appeared to have forms waiting until its 30-minute heartbeat — or forever, if it went offline. The demo database held 107 such phantom reports from Phase 3 E2E runs. | Code review of the engine while profiling | State is reported once per drain (first batch), and a heartbeat with the post-drain queue is sent as soon as anything was acknowledged. Unit test `device state rides on the first batch only, then a post-drain heartbeat reports the truth`. |
| P5-2 | **High** (CHW confusion during a stressful moment) | *Save form* with storage full and an autosave still pending: the flush failed, then Save validated the **stale stored draft**, showed phantom errors and jumped back to step 1, and the Save button disappeared. Answers were kept in memory, but the CHW could not tell. | E2E `storage full during Save` failed deterministically after the app got faster (the 400 ms autosave no longer completed before the disk "filled") | Save stops after a failed flush, keeps the CHW on the step, and shows the storage notice. |
| P5-3 | Medium | Non-field failures showed the CHW a raw code ("Reason: template_retired") | Edge-case review (E13) | Plain-language reasons per code; generic text otherwise, with the support code |
| P5-4 | Medium | *Fix and send again* for a retired template reopened the form on the same retired version, so it could never succeed | Edge-case review (E13) | Moves the answers to the newest published version on the phone, dropping answers to removed questions (which would otherwise block saving as `unknown`) |
| P5-5 | Medium (test reliability, demo credibility) | The seed only created time-relative device reports in an empty database, so ~52 h after the first seed the demo's "Needs attention" facility aged into "Not syncing", and leftover E2E devices polluted the dashboard | Full E2E failure on a long-lived database | States refreshed on every seed; `--reset-device-states` for test stacks (`make e2e`, CI). Regression test with `freeze_time`. |
| P5-6 | Medium | No route error boundary: a lazy screen that failed to download (first visit, signal lost) left a blank screen | Review of the lazy-loading experiment | `RouteError` screen: answers are safe, *Try again* / *Go to Home* |
| P5-7 | Medium (operations) | Escrow-key rotation could never retire an old key: nothing re-sealed devices that do not sign in again | Writing the Maintenance Guide runbook | `manage.py rotate_escrow` (+ `--dry-run`), idempotent, refuses unknown key ids; tested |
| P5-8 | Low (accessibility) | On desktop the sync banner was rendered twice (one hidden), giving two live regions | E2E empty-state test picked the hidden one | Rendered once, based on a media query |
| P5-9 | Low (efficiency) | Every Prometheus scrape ran the national aggregation (~0.3 s at scale) | Scale test | 60 s per-process memo (`SYNC_METRICS_CACHE_SECONDS`) |
| P5-10 | Low (training tool) | Simulator actions that failed (for example a chunk that could not download offline on a first visit) did nothing visible: an unhandled rejection | Perf run (real-API drain) | The simulator shows *That did not work…* with the reason to stay online until offline-ready |

---

## 7. Self-code review

### 7.1 Bottlenecks

| Ref | Where | Finding (measured) | Status |
|---|---|---|---|
| **B1** | `Vault.applyMany`, `Vault.logMany` | IndexedDB requests awaited one by one (~3 event-loop round trips per item, plus one transaction and one `count()` per log entry). `applyMany` was two-thirds of a 4× drain. | **Fixed:** all reads issued, then all writes, one await (requests on a transaction execute in order); log entries in one transaction with amortised trimming. Drain 29.6 s → 8.5 s at 4×. |
| **B2** | `Vault.listDue` | Read **every** due record (with ciphertext) and sorted it, every round: O(queue) per batch, O(queue²) per drain | **Fixed:** at most `limit` records per state from the `[state, nextAttemptAt]` index |
| **B3** | `computeDeviceState` per batch | A full outbox read per batch | **Fixed:** once per drain (and P5-1) |
| **B4** | UI count refresh | ~1,000 bus events in a 500-item drain each re-read the outbox (~60 ms at 4×) | **Fixed:** coalesced (trailing 150 ms, at most 1 s); `recentLog` now walks the index backwards instead of loading 1,000 entries |
| **B5** | SW registration at boot | Precache (~570 KB) competed with the first paint on 3G | **Fixed:** after `load` + idle. Cold load 8.9 s → 6.0–6.2 s, which is *at* the 6 s budget. Next candidates (not yet measured): skip the boot-time session-restore request when the boot database has no known user; preload the critical CSS; trim icon and manifest requests from the critical path |
| B6 | Bundle | Lazy-loading the form route group saves 3.5 KB gz | **Rejected** (adds an offline failure mode); route error boundary added anyway (P5-6) |
| B7 | PBKDF2-600k | 0.5–0.9 s at 4× desktop CPU. Older phones can be 2–3× slower than that proxy. | **Open risk:** iterations are stored per keyring, so they can be tuned per device class after field measurement (checklist 1.3/5.2); floor 310k (OWASP) |
| **B8** | API upsert | ~30 ms/request, 8 statements, mostly ORM/DRF CPU; batches do not amortise it (~28 ms/item) | **Partly fixed** (−2 queries, −20 %). R1 for the rest |
| **B9** | `sync_status` | Four set-based aggregates (no N+1), but the submissions aggregate scans each facility's full history: 314 ms at national scale and growing with data | Scrape memoised; **R2** for the dashboard |
| B10 | Autosave p95 at 4× | 20.8 ms vs 20 ms budget. A single seal + put with no slack left; GC pauses dominate p95. | Accept: debounced 400 ms and off the input path, so the CHW never waits on it; watch on devices |
| B11 | `listOutbox` / `listDue` | Outbox records carry the encrypted payload, so every scan structured-clones ciphertext (`listDue` ~19 ms/call at 1× with 1.5 KB forms) | **R4** |

### 7.2 Refactor proposals (ordered by value)

**R1 — Set-based batch upsert (server).** Today `/submissions/batch` calls the single-item
upsert 25 times. For the common case (all new `client_uuid`s, valid payloads), the batch
could run one `SELECT … WHERE client_uuid = ANY(%s) FOR UPDATE`, then `bulk_create` for
submissions, versions and sync events, falling back to today's per-item path only for
items that already exist or fail validation. That is about 5 statements per batch instead of
~8 per item. Expected effect: several-fold less CPU per form at peak. The safety net already
exists (property test over interleavings, concurrency test, replay and conflict tests), so
the change can be made with confidence. *Why not now:* it rewrites the idempotency core late
in the project; the current capacity already exceeds a national average load of ~1 form/s.

**R2 — Per-facility rollup for sync health.** Maintain `facility_sync_rollup`
(`last_received_at`, `rejected_open`, 7-day ack counters in day buckets), updated in the
upsert transaction or by a periodic job. `sync_status` then reads 800 small rows instead of
aggregating history. Cheaper first step: a partial index on `submissions (facility_id) WHERE
status = 'rejected'` and an index on `(facility_id, received_at DESC)`, then measure again.

**R3 — Outbox counts projection on the device.** Keep per-state counts in a `meta` record
updated inside the same transactions (`enqueue`, `applyMany`). The UI would then read one
record instead of the outbox, making B4's debounce unnecessary and the Home banner O(1).

**R4 — Split payloads out of the outbox store.** Store ciphertext in `outbox_payloads`
keyed by `client_uuid`; the outbox keeps only state and metadata. Scans (`listDue`, counts,
device state) stop cloning ciphertext. This needs an IndexedDB schema migration (version
bump plus copy) and must preserve the "draft → outbox → receipt in one transaction" rule.

**R5 — JWT key identifiers.** Sign with a `kid` and accept a list of verification keys, so
`JWT_SIGNING_KEY` can rotate without signing everyone out (MAINTENANCE §6.2 today
documents a forced re-sign-in).

**R6 — Device management in the PWA.** Supervisors can revoke devices only through the API
or the Django admin. Add a device list with *Remove this phone* to the supervisor dashboard,
with the same scope rules as the API.

**R7 — Hermetic E2E database.** E2E runs against the long-lived demo database (P5-5 was a
symptom). Use a per-run compose project or a template database so every run starts from the
same state, and run the opt-in perf suite on dedicated hardware in CI to turn §5 into a
regression gate.

**R8 — Server-in-the-loop core benchmarks.** The in-browser drain benchmark uses the in-page
fake server; the real-API drain is measured separately. Merging them (fake latency
injected at the transport) would attribute time between device and network more precisely.

### 7.3 Code-quality observations

- **Strengths worth keeping:**
  - The outbox transition table is exhaustive and pure, and is tested over every legal and
    illegal transition.
  - The sync core has no DOM dependencies and compiles under the service-worker tsconfig.
  - One machine-readable error contract drives both server responses and phone behaviour.
  - Validation is a single DSL with a shared conformance suite.
  - Metric labels are bounded, with no PHI anywhere in logs or metrics.
- **Risks to watch:**
  - `runtime.ts` (~550 lines) mixes session lifecycle, sync actions and simulator hooks. If it
    grows, split it into `session-actions`, `sync-actions` and `simulator-actions`.
  - The per-process template cache (B8) relies on all lifecycle changes going through
    `publish()`/`retire()`. A future bulk admin action using `QuerySet.update()` must
    invalidate the cache too (documented in code).
  - `contracts:check` compares generated files with git. It only becomes meaningful once the
    repository has commits (nothing is committed yet), so in this phase OpenAPI drift was
    verified by regenerating and diffing directly.

---

## 8. Not covered, and why

| Area | Status |
|---|---|
| Real low-end Android phones, real 2G, TalkBack, sunlight | Manual checklist ([TESTING-CHECKLIST.md](TESTING-CHECKLIST.md)); requires a pilot |
| iOS Safari | Supported only installed; no Background Sync; not automated (Playwright WebKit is not iOS Safari) |
| Firefox | Browser floor documented; not in the E2E matrix |
| Penetration test | Threat model in ADD §11.1; automated tests cover authz scope, token handling, gzip bombs and headers; an independent test is needed before real data |
| Load on target hardware | `scripts/loadtest.py` is ready; must be run on the target environment |
