# FieldSync — Maintenance Guide

For the developers and system administrators who run, change and support FieldSync.
Architecture and the reasons behind it are in [ADD.md](ADD.md); measured behaviour and
known weaknesses are in [QA-REPORT.md](QA-REPORT.md).

> FieldSync is a demonstration project. "Production" below describes what a real deployment
> would need. Nothing in this repository has been deployed for real use.

Contents:

1. System at a glance
2. Configuration and secrets
3. Deploying and upgrading
4. Database migrations
5. Backups and restore
6. Key and secret rotation
7. Form templates: publishing a new version
8. Translations
9. People and devices: accounts, password resets, lost phones
10. Data retention
11. Monitoring, metrics and alerts
12. Troubleshooting by support code
13. Common problems
14. Dependency updates
15. Capacity and scaling

---

## 1. System at a glance

| Component | What it is | Where |
|---|---|---|
| `web` | nginx (unprivileged) serving the built PWA and proxying `/api` to `api`. Sets the security headers and the CSP. | `infra/web.Dockerfile`, `infra/nginx/` |
| `api` | Django 5 + DRF under gunicorn (`gthread`), read-only root filesystem, non-root user. | `backend/` |
| `db` | PostgreSQL 16. The only stateful server component. | `docker-compose.yml` |
| Phones | The PWA keeps an **encrypted IndexedDB database per user** and an outbox of unsent forms. Unsent forms exist **only on the phone**. | `frontend/src/core/` |

One origin serves everything (`https://<host>/` for the app, `/api/v1/` for the API).
The refresh-token cookie is `SameSite=Strict` and scoped to `/api/v1/auth/`, so **the PWA
and API must stay on the same origin**.

---

## 2. Configuration and secrets

All configuration comes from environment variables. `.env.example` documents each one;
`make bootstrap` (or `scripts/bootstrap_env.py`) writes `.env` with fresh random secrets and
mode 600. Never commit `.env`.

| Variable | Purpose | Notes |
|---|---|---|
| `FIELDSYNC_ENV` | Settings module: `dev`, `demo` or `prod` | `prod` refuses to start with unsafe settings (DEBUG, demo mode, default secrets, missing `ALLOWED_HOSTS`, insecure cookies). |
| `DJANGO_SECRET_KEY` | Django signing (admin sessions, CSRF) | Not used for API tokens. |
| `JWT_SIGNING_KEY` | HS256 key for access and refresh tokens | See §6.2 before changing. |
| `JWT_ACCESS_TTL_SECONDS` / `JWT_REFRESH_TTL_DAYS` / `JWT_REFRESH_ABSOLUTE_DAYS` | Session lengths: 10 min / 14 days sliding / 30 days absolute | The PWA also locks itself after 12 h without the password. |
| `ESCROW_KEKS`, `ESCROW_ACTIVE_KEY_ID` | Server keys that protect each phone's escrow secret | See §6.3. Losing every key breaks password-reset recovery of unsent forms. |
| `METRICS_TOKEN` | Bearer token for `/api/v1/metrics` | Mandatory in `prod`. |
| `GUNICORN_WORKERS` / `GUNICORN_THREADS` | API concurrency (default 2 × 4) | One worker per vCPU; see §15. |
| `DB_CONN_MAX_AGE` | Persistent DB connections (s) | 60 by default. |
| `THROTTLE_LOGIN`, `THROTTLE_USER`, … | Rate limits | Login: 10/min/IP. Raise only for test stacks. |
| `TEMPLATE_ACCEPT_GRACE_DAYS` | How long a superseded/retired template still accepts forms | 30 by default. See §7. |
| `SYNC_EVENT_RETENTION_DAYS` | Retention of the `sync_events` log | 180 by default. See §10. |
| `SYNC_METRICS_CACHE_SECONDS` | Memo for scrape-time sync gauges | 60 by default; 0 disables it. |
| `FIELDSYNC_DEMO_MODE` | Simulator fault injection and demo routes | Must be off in production (enforced). |

Store production secrets in the platform's secret store (for example Kubernetes Secrets
or a vault), not in files on servers.

---

## 3. Deploying and upgrading

### 3.1 First deployment

```bash
make bootstrap                       # or provide the variables from your secret store
docker compose up -d --build --wait  # db → api (migrates, see §4) → web
docker compose exec api python manage.py createsuperuser   # national admin
```

For TLS, terminate HTTPS at nginx (see `infra/nginx/tls.conf.example`) or at the ingress,
and keep `Host` forwarding as `$http_host` (the refresh endpoint checks same-origin; `$host`
drops the port and refuses every session restore behind a non-443 port).

### 3.2 Upgrades

1. Read the changelog for migrations and contract changes (`contracts/`).
2. Back up the database (§5).
3. `docker compose build && docker compose up -d --wait`. The API runs migrations on start
   when `RUN_MIGRATIONS=1` (the compose default).
4. Check `GET /api/v1/health/ready` and the dashboard.

**Phones update themselves safely.** A new service worker installs in the background and
waits; the PWA offers **Update now** and never activates an update while a form is open
(update holds). Phones that are offline keep the old version until they reconnect. Therefore:

- **API changes must stay backward-compatible for at least one release.** Old app versions
  keep calling the API for days or weeks. Add fields; do not remove or rename them; never
  change the meaning of an error code (`contracts/error-codes.json` drives the phone's retry
  decisions).
- **Never change the on-device database schema without an IndexedDB migration** in
  `frontend/src/core/db/schema.ts` (bump the version, migrate in `upgrade`). Unsent forms
  live there.

### 3.3 Rollback

Roll back the images (`docker compose up -d` with the previous tags). Roll back migrations
only if the previous release cannot run against the new schema; write migrations so that it
can (add columns nullable, drop them a release later).

---

## 4. Database migrations

- Models are the source of truth; generate with `python manage.py makemigrations`.
  CI fails if a migration is missing (`makemigrations --check`).
- The API container migrates on start (`RUN_MIGRATIONS=1`). With more than one API replica,
  run migrations once as a separate job instead and set `RUN_MIGRATIONS=0` on the replicas.
- Published template definitions are immutable, enforced by a database trigger
  (`form_templates_immutable`). A migration that must change such rows has to disable and
  re-enable the trigger explicitly and say why. `submission_versions` and `sync_events` are
  append-only by convention (no code path updates them); keep it that way.
- Large tables (`submissions`, `submission_versions`, `sync_events`): add indexes with
  `AddIndexConcurrently` (non-atomic migration) to avoid long write locks.

---

## 5. Backups and restore

PostgreSQL holds every accepted form, its versions and the audit trail. Phones hold
**unsent** forms only; a server backup cannot restore those.

Minimum for a real deployment:

- Managed PostgreSQL with point-in-time recovery (PITR), or `pg_basebackup` + WAL archiving.
- A nightly logical dump kept off-site and encrypted:

  ```bash
  docker compose exec -T db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" \
    | gpg --encrypt -r ops@example.org > fieldsync-$(date +%F).dump.gpg
  ```

- **Test restores monthly** into a scratch database:

  ```bash
  createdb fieldsync_restore_test
  gpg --decrypt fieldsync-YYYY-MM-DD.dump.gpg | pg_restore -d fieldsync_restore_test --no-owner
  ```

  Then run `python manage.py check --database default` against it and compare row counts.
- **Back up the secrets separately** (`ESCROW_KEKS`, `JWT_SIGNING_KEY`, `DJANGO_SECRET_KEY`).
  A database restored without its escrow keys cannot help a CHW whose password was reset.

After restoring to an earlier point in time, phones may re-send forms the restored database
no longer has. That is safe: the upsert is idempotent by `client_uuid`, so they are simply
created again. Forms edited by supervisors after the restore point are lost from the server;
tell supervisors.

---

## 6. Key and secret rotation

### 6.1 `DJANGO_SECRET_KEY`, `METRICS_TOKEN`, `POSTGRES_PASSWORD`

Replace and restart. Rotating `DJANGO_SECRET_KEY` signs admin users out of the Django admin.
Update the Prometheus scrape configuration together with `METRICS_TOKEN`.

### 6.2 `JWT_SIGNING_KEY`

There is one active HS256 key. Changing it **invalidates every access and refresh token at
once**:

- Every user must sign in again **online**. Phones show *Sign in again to send your saved
  forms*. Unsent forms are safe: they are encrypted with the phone's own key, not the JWT.
- Offline work continues (unlock uses the local password, not the server).

Do it at a quiet time, announce it to supervisors, and avoid doing it during a campaign.
Rotate immediately if the key may have leaked.

### 6.3 Escrow keys (`ESCROW_KEKS`)

Each phone's escrow secret is stored encrypted under a server key (AES-256-GCM, bound to
the device id). It lets a CHW whose password was reset recover the unsent forms on their
phone. Rotation:

1. Generate a key: `python3 -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"`.
2. **Add** it: `ESCROW_KEKS=1:<old>,2:<new>` and set `ESCROW_ACTIVE_KEY_ID=2`. Deploy.
   New and re-signing-in devices are sealed under key 2 from now on.
3. Re-seal the rest:

   ```bash
   docker compose exec api python manage.py rotate_escrow --dry-run   # "N device(s) not sealed under active key 2"
   docker compose exec api python manage.py rotate_escrow
   docker compose exec api python manage.py rotate_escrow --dry-run   # must report 0
   ```

   The command is idempotent and safe to interrupt; it re-seals one device per transaction.
4. Only when the dry run reports 0: remove key 1 from `ESCROW_KEKS` and deploy.

The command refuses to run if any device is sealed under a key that is no longer
configured; restore that key from the secrets backup first.

---

## 7. Form templates: publishing a new version

Templates are versioned and **immutable once published** (a database trigger enforces it).
Phones may hold forms for older versions for days, so the server keeps accepting a superseded
version for `TEMPLATE_ACCEPT_GRACE_DAYS` (30).

1. Write the definition in the DSL (`contracts/form-template.schema.json`; examples in
   `contracts/examples/`). Every label, hint, option and **unit word** is an i18n map
   (`{"en": "...", "kpe": "..."}`); a bare-string `unit` is a language-neutral symbol
   (`"mm"`, `"°C"`).
2. Create a draft as a national admin: `POST /api/v1/form-templates` with the definition.
   The server validates it against the meta-schema **and** semantic rules (duplicate ids,
   rule/type mismatches, `showIf` pointing forward, min > max, unknown cross-rule fields).
3. Review the draft: open it in a test phone/browser against a staging server, fill it in,
   and check validation messages in every language.
4. Publish: `POST /api/v1/form-templates/<id>/publish`. The previous version becomes
   *superseded* and is accepted for the grace window. Phones download the new version the
   next time they refresh reference data (sign-in or app start while online).
5. If a version must stop being accepted earlier (for example a clinical error),
   `POST /api/v1/form-templates/<id>/retire`. Forms still queued on phones for that version
   are then refused with `template_retired`; the CHW sees *This form type has been replaced
   by a newer version* and **Fix and send again** moves the answers to the newest version on
   the phone (answers to removed questions are dropped; new required questions must be
   answered).

**Validation rules live in two engines** (Python on the server, TypeScript on the phone).
Any change to the DSL or a rule must be added to `contracts/validation-cases.json`; both test
suites run every case and must agree.

---

## 8. Translations

- UI text lives in `frontend/src/i18n/locales/en.json` (the source). Keys are referenced in
  code with a typed `t('key')`; a missing key fails `tsc`.
- `kpe.json` is a **pseudo-locale placeholder** generated from `en.json`
  (`npm run gen:i18n`): every string reads `⟦kpe⟧ <English> ··`. It exists to prove that
  every visible string is translatable and that layouts survive ~30 % longer text. **It is
  not Kpelle.** CI fails if it is stale.
- The E2E test *every visible UI string goes through the catalogue* switches to the
  pseudo-locale and fails if any visible text on any screen lacks the marker. Keep it green.

To add a real language (for example Liberian English plain-language variants, Kpelle, Bassa):

1. Commission translation by a qualified translator **and review with CHWs** — health terms
   must be understood by the people using them, not just be dictionary-correct.
2. Add `<lang>.json` with the same keys (keep `{placeholders}` exactly; a unit test checks
   them), register the locale in `frontend/src/i18n/index.ts`, and stop generating it from
   `en.json`.
3. Add the language to every template's i18n maps (labels, hints, options, unit words) and
   publish new template versions (§7).
4. Run the pseudo-locale coverage test and the 320 px reflow test with the new language.

---

## 9. People and devices

### 9.1 Accounts and roles

Accounts are created by a national admin in the Django admin (`/api/admin/`). Roles:
`chw` (assigned facilities), `supervisor` (one county), `admin` (national). The server
enforces scope on every query; the phone only decides what to display.

### 9.2 Password reset — keeping a CHW's unsent forms

1. In the Django admin, set a new password for the user.
2. The CHW signs in **online** with the new password on their own phone. The server returns
   the device's escrow secret; the phone re-wraps its data key under the new password.
   **Unsent forms are kept.**
3. Until that online sign-in, the phone still unlocks offline with the **old** password.

If the CHW cannot get online and has forgotten the old password, their unsent forms cannot
be read on that phone until they reach network. Do not erase the app.

### 9.3 Lost or stolen phones

A supervisor (for their county) or an admin revokes the device:

- `POST /api/v1/devices/<device_id>/revoke` with a reason (find the device in
  `GET /api/v1/devices`, which lists the devices in the caller's scope with their user and
  last-seen time, or in the Django admin's device list). There is no
  revoke button in the PWA yet (QA report, refactor R6).
- From then on the device cannot refresh tokens or submit (`device_revoked`). When the phone
  next reaches the server, the app **crypto-shreds** the local data (keys first, then the
  database) and shows *This phone was removed from FieldSync*.
- Unsent forms on a revoked phone are lost by design: on a stolen phone they are protected
  by the user's password and are then destroyed.

Revocation cannot be undone; a recovered phone signs in again and registers as a new device.

### 9.4 A CHW changes facility

Update facility assignments in the Django admin. Forms queued on the phone for a facility the
CHW no longer has are refused with `facility_forbidden` (*You are not assigned to this
facility any more*). Re-assign temporarily so they can send, or have a supervisor collect them.

---

## 10. Data retention

| Data | Where | Retention | Mechanism |
|---|---|---|---|
| Unsent forms | Phone (encrypted) | Until sent or deliberately deleted | Never auto-deleted |
| Payload of a sent form | Phone | Removed on acknowledgement | Engine purges on ack |
| Receipts (no answers, just status) | Phone | 30 days after sending | `pruneReceipts` |
| Sync log (no PII) | Phone | Last 1,000 entries | Ring buffer |
| Submissions + versions | Server | Policy decision for MoH (not automated) | — |
| `sync_events` (operational log) | Server | 180 days (`SYNC_EVENT_RETENTION_DAYS`) | `prune_sync_events` |

Schedule the prune daily (cron or a Kubernetes CronJob):

```bash
docker compose exec -T api python manage.py prune_sync_events            # uses the setting
docker compose exec -T api python manage.py prune_sync_events --dry-run  # how many would go
```

It deletes in chunks of 5,000 rows to avoid long locks and is safe to re-run.

---

## 11. Monitoring, metrics and alerts

Endpoints: `GET /api/v1/health/live` (process up), `GET /api/v1/health/ready` (database
reachable), `GET /api/v1/metrics` (Prometheus, `Authorization: Bearer $METRICS_TOKEN`).

Key metrics (all labels are bounded: no user, facility, device or patient labels):

| Metric | Meaning |
|---|---|
| `fieldsync_http_request_duration_seconds{route,method,status_class}` | API latency by route template |
| `fieldsync_http_requests_rejected_total{reason}` | Rejected before a view (size, gzip, …) |
| `fieldsync_submission_upserts_total{outcome,op}` | created / updated / replayed / conflict / rejected / forbidden / invalid |
| `fieldsync_duplicates_prevented_total` | Resends answered as replays (lost acknowledgements) |
| `fieldsync_client_attempts_bucket{outcome}` | Attempt number at which forms were acknowledged |
| `fieldsync_conflicts_total{resolution}` | detected / merge / override |
| `fieldsync_sync_batch_size_bucket` | Items per batch |
| `fieldsync_auth_events_total{event}` | login_ok, login_invalid_credentials, refresh_token_expired, … |
| `fieldsync_queue_depth_reported{county}` | Forms waiting on phones (last device report) |
| `fieldsync_stuck_items_reported{county}` | Forms stuck on phones (≥ 8 tries or 48 h) |
| `fieldsync_sync_success_ratio{county}` | First-attempt success, 7 days |
| `fieldsync_facilities{health}` | Facilities by health (healthy/degraded/stale/unknown) |

The last four are computed from the database at scrape time and memoised for 60 s.

Suggested alerts (tune thresholds to the deployment):

| Alert | Rule (PromQL sketch) | Why |
|---|---|---|
| API errors | `sum(rate(fieldsync_http_request_duration_seconds_count{status_class="5xx"}[5m])) / sum(rate(fieldsync_http_request_duration_seconds_count[5m])) > 0.02` for 10 m | Phones retry 5xx; sustained errors grow queues. |
| Slow upserts | p95 of `route="/api/v1/submissions/batch"` > 2 s for 15 m | Batches time out on 2G at ~30 s. |
| Stuck forms | `sum(fieldsync_stuck_items_reported) > 0` for 24 h | Something a CHW cannot fix alone. |
| Stale facilities | `fieldsync_facilities{health="stale"}` rising day on day | Phones not syncing (network, lost phones, people). |
| Retry pressure | `fieldsync_sync_success_ratio < 0.6` for a county | Poor network or a server problem. |
| Auth failures | spike in `fieldsync_auth_events_total{event=~"login_invalid.*"}` | Password guessing; check the throttle. |
| Readiness | `/health/ready` failing for 2 m | Database unreachable. |

Logs are JSON on stdout, one line per request, with `request_id`, route template, status and
`duration_ms`. A scrubber replaces sensitive values (passwords, tokens, payload fields) with
`[redacted]`. **Never log payloads**, and never add per-patient identifiers to log lines.

---

## 12. Troubleshooting by support code

Every error the app shows carries a **support code** such as `FS-1A2B3C`. It is the last six
hex digits of the request's `X-Request-ID`, which appears in every server log line for that
request. It contains no patient information, so a CHW can read it out on the phone.

```bash
# FS-1A2B3C  →  search for request ids ending in 1a2b3c
docker compose logs api --since 72h | grep -i '1a2b3c"'
```

Then use the `request_id` to find the sync events:

```sql
SELECT occurred_at, event_type, client_uuid, client_attempt, detail
FROM sync_events WHERE request_id::text LIKE '%1a2b3c' ORDER BY occurred_at;
```

What the codes mean is in `contracts/error-codes.json` (HTTP status and the phone's reaction:
`transient` → retry with backoff, `auth` → pause until sign-in, `revoked` → erase,
`conflict` → ask the CHW, `permanent` → *Needs fixing*).

---

## 13. Common problems

| Symptom | Likely cause | What to do |
|---|---|---|
| Dashboard shows a facility **Not syncing** | Phone off, no network for days, lost phone, CHW left | Call the CHW. The facility card shows pending count and how old the oldest form is. |
| **Many forms needed retries** for a county | Poor network, or server errors | Check 5xx rate and latency; if the server is fine, it is the network — no action. |
| A CHW's form is **Needs fixing** with field errors | Server validation stricter than phone validation (should not happen) | Compare the two engines with `contracts/validation-cases.json`; add the failing case. |
| Every phone shows *Sign in again* | `JWT_SIGNING_KEY` changed, or the refresh cookie is blocked | Check nginx forwards `Host: $http_host`; check same-origin deployment. |
| Sign-in fails with HTTP 403 from `/auth/refresh` | Origin/Host mismatch behind a proxy | As above. |
| Phone shows **Phone storage is full** | Device storage full | CHW sends forms (payloads are purged on ack) and frees space; data is not lost. |
| Forms sent twice? | Not possible by design | Check `fieldsync_duplicates_prevented_total`; one row per `client_uuid`. |
| API CPU at 100 % at peak | Sync burst after a network outage | See §15; add workers/replicas. Phones back off automatically. |

---

## 14. Dependency updates

- **Backend:** runtime dependencies are pinned **with hashes** in `backend/requirements.lock`.
  Update `pyproject.toml`, run `make lock`, then `make check`. CI runs `pip-audit --strict`.
- **Frontend:** `npm update` / `npm install <pkg>@<version>`, then `npm run lint typecheck
  test`, `npm run build:bundle && npm run size` (bundle budgets), and `make e2e`.
- **Keep the browser floor:** Chrome/WebView ≥ 87. Do not raise Vite's build target or add
  syntax/APIs beyond it (no top-level await) without checking the device inventory.
- **Base images:** rebuild monthly for OS security fixes (`docker compose build --pull`).
- After any upgrade touching crypto, IndexedDB, or the service worker, run the full E2E
  suite including `shell.spec.ts` (offline cold start) and `edge.spec.ts`.

---

## 15. Capacity and scaling

Measured on a development laptop (see QA report §5). The figures are indicative, not
a capacity guarantee:

- A single upsert costs ~30 ms of API time (~20 ms CPU, 8 SQL statements). A batch costs
  ~28 ms per item.
- Two gunicorn workers saturate at roughly 40–45 single upserts per second on that host.

What the load looks like: if 4,000 CHWs each send 20 forms a day, that is ~80,000 forms a
day — about 1 form per second on average. The real peak is the **morning burst** after
network returns, when phones drain their queues in batches of up to 25. Phones back off with
jitter and honour `Retry-After`, so overload stretches the drain rather than losing data.

To scale:

1. One gunicorn worker per vCPU (`GUNICORN_WORKERS`), 4 threads each.
2. Add API replicas behind the load balancer (stateless; run migrations once, §4).
3. Put PostgreSQL on its own host with enough memory for the `submissions` working set.
4. If batch CPU becomes the limit, implement the set-based batch upsert described in the
   QA report (refactor R1).
