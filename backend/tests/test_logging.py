from __future__ import annotations

import logging
import logging.config

import pytest
import structlog

from fieldsync.common.logging import REDACTED, build_logging_config, drop_phi, scrub


def test_scrub_redacts_sensitive_keys_at_any_depth() -> None:
    data = {
        "client_uuid": "0193",
        "items": [{"payload": {"name": "Ama"}, "outcome": "created"}],
        "nested": {"patient_name": "Ama", "Authorization": "Bearer x", "ok": 1},
    }
    assert scrub(data) == {
        "client_uuid": "0193",
        "items": [{"payload": REDACTED, "outcome": "created"}],
        "nested": {"patient_name": REDACTED, "Authorization": REDACTED, "ok": 1},
    }


def test_drop_phi_processor_on_top_level_and_nested() -> None:
    event = {"event": "x", "payload": {"a": 1}, "detail": {"password": "p"}, "count": 2}
    assert drop_phi(None, "info", event) == {
        "event": "x",
        "payload": REDACTED,
        "detail": {"password": REDACTED},
        "count": 2,
    }


def test_rendered_json_log_never_contains_phi(capsys: pytest.CaptureFixture[str]) -> None:
    logging.config.dictConfig(build_logging_config(level="INFO", json_output=True))
    try:
        structlog.get_logger("t").info(
            "submission.received", client_uuid="0193", payload={"patient_name": "Ama Kollie"}
        )
        logging.getLogger("django.foreign").warning("x", extra={"patient_ref": "HH-0042-03"})
    finally:
        logging.config.dictConfig(build_logging_config(level="WARNING", json_output=False))
    out = capsys.readouterr().err
    assert '"client_uuid": "0193"' in out
    assert "Ama Kollie" not in out
    assert "HH-0042-03" not in out
