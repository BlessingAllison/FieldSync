# Deploying the FieldSync API on Railway

The PWA (frontend) is hosted on Vercel. Vercel forwards `/api/*` to the API on Railway
(`frontend/vercel.json`), so the browser sees one origin and the `SameSite=Strict` refresh cookie
keeps working, as it does behind `infra/nginx/default.conf`. Because requests reach Django
addressed to the Railway host while the browser's `Origin` is the Vercel site, that site is listed
in `FIELDSYNC_TRUSTED_ORIGIN_HOSTS` (checked by the `/auth/refresh` same-origin guard).

The local Docker Compose stack (`docker-compose.yml`, `make bootstrap`, `make up`) is unchanged.

## Services

| Railway service | What it is |
|---|---|
| **Postgres** | Railway PostgreSQL (default `railway` database). |
| **FieldSync** | This repo, built with `deploy/railway/Dockerfile`. |

## Variables on the FieldSync service

```
RAILWAY_DOCKERFILE_PATH=deploy/railway/Dockerfile
DATABASE_URL=${{Postgres.DATABASE_URL}}
PORT=8000
```

Nothing secret is stored in Railway variables. On first boot `start.py` creates a random seed in
the `railway_deploy` schema of the database and derives `DJANGO_SECRET_KEY`, `JWT_SIGNING_KEY`,
`ESCROW_KEKS` and `METRICS_TOKEN` from it, so sessions survive restarts and redeploys. It also
sets `DJANGO_ALLOWED_HOSTS` (Vercel host + the Railway domain), `FIELDSYNC_TRUSTED_ORIGIN_HOSTS`
and `NUM_PROXIES=2`, then runs `migrate`. Any variable you set yourself overrides these defaults.

## Demo logins

The first deploy runs `manage.py seed_demo` once and prints the accounts table (usernames and
passwords) in the **Deploy Logs** of that deployment.

To seed again, delete the `demo_seeded` row from `railway_deploy.state` and redeploy, or run
`python manage.py seed_demo` from the service's console.
