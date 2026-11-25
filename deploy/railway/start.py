"""Railway start script for the FieldSync API (the image's entrypoint on Railway).

Railway provides a Postgres (``DATABASE_URL``) but none of the local ``make bootstrap`` setup.
On every boot this script:

1. waits for Postgres and takes an advisory lock;
2. creates a random deployment seed once, kept in the ``railway_deploy`` schema of the database
   (never in Railway variables, logs or the repo);
3. derives the Django secret key, JWT signing key, escrow KEK and metrics token from it, so they
   are identical on every boot and sessions survive redeploys;
4. sets Railway-friendly defaults (allowed hosts, trusted Vercel origin, proxy count);
5. runs migrations, seeds demo data once (logins are printed to the deploy log);
6. execs gunicorn.

Any variable set in Railway takes precedence over the derived default.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import subprocess
import sys
import time

import psycopg

LOCK_ID = 7_314_000_002
VERCEL_HOST = "field-sync.vercel.app"


def log(message: str) -> None:
    print(f"[railway-start] {message}", flush=True)


def derive(seed: bytes, label: str) -> bytes:
    return hmac.new(seed, label.encode(), hashlib.sha256).digest()


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def connect(url: str, timeout_s: float = 180) -> psycopg.Connection:
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            return psycopg.connect(url, autocommit=True, connect_timeout=10)
        except psycopg.OperationalError as exc:
            if time.monotonic() > deadline:
                raise
            log(f"waiting for Postgres ({exc.__class__.__name__})")
            time.sleep(3)


def provision(url: str) -> bytes:
    with connect(url) as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (LOCK_ID,))
        try:
            conn.execute("CREATE SCHEMA IF NOT EXISTS railway_deploy")
            conn.execute("REVOKE ALL ON SCHEMA railway_deploy FROM PUBLIC")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS railway_deploy.state "
                "(key text PRIMARY KEY, value text NOT NULL)"
            )
            conn.execute(
                "INSERT INTO railway_deploy.state VALUES ('seed', %s) ON CONFLICT (key) DO NOTHING",
                (secrets.token_hex(32),),
            )
            row = conn.execute("SELECT value FROM railway_deploy.state WHERE key = 'seed'").fetchone()
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK_ID,))
    assert row is not None
    return bytes.fromhex(row[0])


def configure_env(seed: bytes) -> None:
    env = os.environ
    env.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.demo")
    env.setdefault("FIELDSYNC_DEMO_MODE", "1")
    env.setdefault("DJANGO_SECRET_KEY", b64url(derive(seed, "django-secret-key") + derive(seed, "django-secret-key-2")))
    env.setdefault("JWT_SIGNING_KEY", b64url(derive(seed, "jwt-signing-key") + derive(seed, "jwt-signing-key-2")))
    env.setdefault("ESCROW_KEKS", "1:" + base64.b64encode(derive(seed, "escrow-kek-1")).decode())
    env.setdefault("ESCROW_ACTIVE_KEY_ID", "1")
    env.setdefault("METRICS_TOKEN", b64url(derive(seed, "metrics-token")))

    hosts = [VERCEL_HOST, "healthcheck.railway.app", "localhost", "127.0.0.1"]
    for var in ("RAILWAY_PUBLIC_DOMAIN", "RAILWAY_PRIVATE_DOMAIN"):
        if env.get(var):
            hosts.append(env[var])
    env.setdefault("DJANGO_ALLOWED_HOSTS", ",".join(hosts))
    # The browser's Origin is the Vercel site; requests reach Django addressed to Railway.
    env.setdefault("FIELDSYNC_TRUSTED_ORIGIN_HOSTS", VERCEL_HOST)
    # Vercel rewrite + Railway edge both append to X-Forwarded-For.
    env.setdefault("NUM_PROXIES", "2")
    env.setdefault("DJANGO_LOG_FORMAT", "json")
    env.setdefault("PROMETHEUS_MULTIPROC_DIR", "/tmp/prometheus")
    os.makedirs(env["PROMETHEUS_MULTIPROC_DIR"], exist_ok=True)


def seed_demo_once(url: str) -> None:
    if os.environ.get("FIELDSYNC_RAILWAY_SEED_DEMO", "1") != "1":
        return
    with connect(url) as conn:
        if conn.execute("SELECT 1 FROM railway_deploy.state WHERE key = 'demo_seeded'").fetchone():
            return
        log("seeding demo data (first deploy only). Save the logins below:")
        result = subprocess.run([sys.executable, "manage.py", "seed_demo"], check=False, cwd="/app")
        if result.returncode == 0:
            conn.execute(
                "INSERT INTO railway_deploy.state VALUES ('demo_seeded', now()::text) "
                "ON CONFLICT (key) DO NOTHING"
            )
        else:
            log("demo seeding failed; the API will still start (see the error above)")


def main() -> None:
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        sys.exit("[railway-start] DATABASE_URL is not set. Add it in Railway (see deploy/railway/README.md).")
    seed = provision(url)
    configure_env(seed)
    log("running migrations")
    subprocess.run([sys.executable, "manage.py", "migrate", "--noinput"], check=True, cwd="/app")
    seed_demo_once(url)
    log("starting API on port 8000")
    os.execvp("gunicorn", ["gunicorn", "-c", "gunicorn.conf.py", "config.wsgi:application"])


if __name__ == "__main__":
    main()
