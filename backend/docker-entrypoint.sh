#!/bin/sh
set -eu

# Prometheus multiprocess mode needs an empty directory per container start. /tmp is a
# tmpfs in compose (emptied whenever the container stops), so only ensure it exists.
if [ -n "${PROMETHEUS_MULTIPROC_DIR:-}" ]; then
  mkdir -p "${PROMETHEUS_MULTIPROC_DIR}"
fi

if [ "${RUN_MIGRATIONS:-0}" = "1" ]; then
  python manage.py migrate --noinput
fi

exec "$@"
