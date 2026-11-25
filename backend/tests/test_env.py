from __future__ import annotations

import pytest
from django.core.exceptions import ImproperlyConfigured

from fieldsync.common.env import env_bool, env_int, parse_database_url


def test_parse_database_url() -> None:
    parsed = parse_database_url("postgres://fs:p%40ss@db:5432/fieldsync")
    assert (parsed.user, parsed.password, parsed.host, parsed.port, parsed.name) == (
        "fs",
        "p@ss",
        "db",
        5432,
        "fieldsync",
    )


@pytest.mark.parametrize(
    "url", ["sqlite:///db.sqlite3", "postgres://db:5432/x", "postgres://u:p@db:5432/"]
)
def test_parse_database_url_rejects(url: str) -> None:
    with pytest.raises(ImproperlyConfigured):
        parse_database_url(url)


def test_env_bool_rejects_garbage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("X_FLAG", "maybe")
    with pytest.raises(ImproperlyConfigured):
        env_bool("X_FLAG", default=False)


def test_env_int_minimum(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("X_INT", "3")
    with pytest.raises(ImproperlyConfigured):
        env_int("X_INT", default=10, minimum=5)
