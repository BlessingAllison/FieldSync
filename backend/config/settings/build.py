"""Used only inside ``docker build`` for ``collectstatic`` — no database, no secrets."""

from __future__ import annotations

import os

os.environ.setdefault("JWT_SIGNING_KEY", "build-only-jwt-key-never-used-at-runtime-0000000000")
os.environ.setdefault("ESCROW_KEKS", "1:i1JCrcHgDo4pAGUmFpMI+dVuUljOyV4+cbsKn8Nq0fM=")
os.environ.setdefault("DJANGO_SECRET_KEY", "build-only-secret-never-used-at-runtime-0000000000000")
os.environ.setdefault("DATABASE_URL", "postgres://build:build@localhost:5432/build")

from config.settings.base import *
