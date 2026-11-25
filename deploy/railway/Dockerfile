# syntax=docker/dockerfile:1.7
# ── FieldSync API image for Railway (build context: repository root) ──────────
# Same build as backend/Dockerfile, plus deploy/railway/start.py, which provisions
# secrets, runs migrations and seeds demo data on boot. See deploy/railway/README.md.
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

FROM base AS deps
COPY backend/requirements.lock ./
RUN pip install --prefix=/install --require-hashes -r requirements.lock

FROM base AS runtime
RUN groupadd --system --gid 10001 fieldsync \
    && useradd --system --uid 10001 --gid fieldsync --home-dir /app --shell /usr/sbin/nologin fieldsync
COPY --from=deps /install /usr/local
COPY --chown=fieldsync:fieldsync backend/manage.py backend/gunicorn.conf.py ./
COPY --chown=fieldsync:fieldsync backend/config ./config
COPY --chown=fieldsync:fieldsync backend/fieldsync ./fieldsync
COPY --chown=fieldsync:fieldsync contracts ./contracts
COPY --chown=fieldsync:fieldsync deploy/railway/start.py ./railway_start.py
RUN DJANGO_SETTINGS_MODULE=config.settings.build FIELDSYNC_CONTRACTS_DIR=/app/contracts \
    python manage.py collectstatic --noinput -v 0 \
    && chown -R fieldsync:fieldsync /app/staticfiles
USER fieldsync
ENV DJANGO_SETTINGS_MODULE=config.settings.demo \
    PROMETHEUS_MULTIPROC_DIR=/tmp/prometheus \
    FIELDSYNC_CONTRACTS_DIR=/app/contracts
EXPOSE 8000
CMD ["python", "/app/railway_start.py"]
