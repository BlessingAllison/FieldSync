# syntax=docker/dockerfile:1.7
# ── FieldSync API image ──────────────────────────────────────────────────────
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

# Dependencies only (layer cached until requirements.lock changes).
FROM base AS deps
COPY backend/requirements.lock ./
RUN pip install --prefix=/install --require-hashes -r requirements.lock

FROM base AS runtime
RUN groupadd --system --gid 10001 fieldsync \
 && useradd --system --uid 10001 --gid fieldsync --home-dir /app --shell /usr/sbin/nologin fieldsync
COPY --from=deps /install /usr/local
COPY --chown=fieldsync:fieldsync backend/manage.py backend/gunicorn.conf.py backend/docker-entrypoint.sh ./
COPY --chown=fieldsync:fieldsync backend/config ./config
COPY --chown=fieldsync:fieldsync backend/fieldsync ./fieldsync
COPY --chown=fieldsync:fieldsync contracts ./contracts
# Self-hosted Swagger/Redoc assets (no CDN): collected at build time, served by WhiteNoise.
RUN DJANGO_SETTINGS_MODULE=config.settings.build FIELDSYNC_CONTRACTS_DIR=/app/contracts \
    python manage.py collectstatic --noinput -v 0 \
 && chown -R fieldsync:fieldsync /app/staticfiles
USER fieldsync
ENV DJANGO_SETTINGS_MODULE=config.settings.prod \
    PROMETHEUS_MULTIPROC_DIR=/tmp/prometheus \
    FIELDSYNC_CONTRACTS_DIR=/app/contracts
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health/live', timeout=2)"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["gunicorn", "-c", "gunicorn.conf.py", "config.wsgi:application"]
