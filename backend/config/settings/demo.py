"""docker-compose demo stack: production-like hardening, demo/simulator features enabled.

Served over plain HTTP on localhost, so TLS-only settings (SSL redirect, HSTS) stay off;
browsers treat ``localhost`` as a secure context, so Secure cookies still work.
"""

from __future__ import annotations

from config.settings.base import *
from fieldsync.common.env import env_bool

DEBUG = False
FIELDSYNC_DEMO_MODE = env_bool("FIELDSYNC_DEMO_MODE", default=True)
