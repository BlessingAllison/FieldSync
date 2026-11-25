"""API error contract.

Mirrors ``contracts/error-codes.json`` exactly (enforced by ``tests/test_contracts.py``).
Views and services raise :class:`ApiError`; the DRF exception handler and the
Django-level handlers render it into the standard envelope.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any


class ErrorCode(StrEnum):
    MALFORMED_REQUEST = "malformed_request"
    TEMPLATE_UNKNOWN = "template_unknown"
    INVALID_CREDENTIALS = "invalid_credentials"
    TOKEN_INVALID = "token_invalid"
    TOKEN_EXPIRED = "token_expired"
    DEVICE_REVOKED = "device_revoked"
    ACCOUNT_LOCKED = "account_locked"
    PERMISSION_DENIED = "permission_denied"
    FACILITY_FORBIDDEN = "facility_forbidden"
    NOT_FOUND = "not_found"
    METHOD_NOT_ALLOWED = "method_not_allowed"
    NOT_ACCEPTABLE = "not_acceptable"
    CONFLICT_VERSION = "conflict_version"
    CLIENT_UUID_FOREIGN = "client_uuid_foreign"
    PAYLOAD_TOO_LARGE = "payload_too_large"
    UNSUPPORTED_MEDIA_TYPE = "unsupported_media_type"
    VALIDATION_FAILED = "validation_failed"
    TEMPLATE_RETIRED = "template_retired"
    RATE_LIMITED = "rate_limited"
    SERVER_ERROR = "server_error"
    UNAVAILABLE = "unavailable"


HTTP_STATUS: dict[ErrorCode, int] = {
    ErrorCode.MALFORMED_REQUEST: 400,
    ErrorCode.TEMPLATE_UNKNOWN: 400,
    ErrorCode.INVALID_CREDENTIALS: 401,
    ErrorCode.TOKEN_INVALID: 401,
    ErrorCode.TOKEN_EXPIRED: 401,
    ErrorCode.DEVICE_REVOKED: 401,
    ErrorCode.ACCOUNT_LOCKED: 403,
    ErrorCode.PERMISSION_DENIED: 403,
    ErrorCode.FACILITY_FORBIDDEN: 403,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.METHOD_NOT_ALLOWED: 405,
    ErrorCode.NOT_ACCEPTABLE: 406,
    ErrorCode.CONFLICT_VERSION: 409,
    ErrorCode.CLIENT_UUID_FOREIGN: 409,
    ErrorCode.PAYLOAD_TOO_LARGE: 413,
    ErrorCode.UNSUPPORTED_MEDIA_TYPE: 415,
    ErrorCode.VALIDATION_FAILED: 422,
    ErrorCode.TEMPLATE_RETIRED: 422,
    ErrorCode.RATE_LIMITED: 429,
    ErrorCode.SERVER_ERROR: 500,
    ErrorCode.UNAVAILABLE: 503,
}

# Default English messages. Clients localise by ``code``; these exist for logs
# and developer tooling. They must never interpolate submitted values.
DEFAULT_MESSAGE: dict[ErrorCode, str] = {
    ErrorCode.MALFORMED_REQUEST: "The request is not well-formed.",
    ErrorCode.TEMPLATE_UNKNOWN: "The form template does not exist.",
    ErrorCode.INVALID_CREDENTIALS: "Username or password is incorrect.",
    ErrorCode.TOKEN_INVALID: "Authentication credentials are missing or invalid.",
    ErrorCode.TOKEN_EXPIRED: "Your session has expired.",
    ErrorCode.DEVICE_REVOKED: "This device has been revoked.",
    ErrorCode.ACCOUNT_LOCKED: "Too many failed sign-in attempts. Try again later.",
    ErrorCode.PERMISSION_DENIED: "You do not have permission to perform this action.",
    ErrorCode.FACILITY_FORBIDDEN: "This facility is not assigned to you.",
    ErrorCode.NOT_FOUND: "Not found.",
    ErrorCode.METHOD_NOT_ALLOWED: "Method not allowed.",
    ErrorCode.NOT_ACCEPTABLE: "The requested response format is not available.",
    ErrorCode.CONFLICT_VERSION: "This submission was changed on the server.",
    ErrorCode.CLIENT_UUID_FOREIGN: "This submission identifier cannot be used.",
    ErrorCode.PAYLOAD_TOO_LARGE: "The request is too large.",
    ErrorCode.UNSUPPORTED_MEDIA_TYPE: "Unsupported content type or encoding.",
    ErrorCode.VALIDATION_FAILED: "Some answers are not valid.",
    ErrorCode.TEMPLATE_RETIRED: "This form version is no longer accepted.",
    ErrorCode.RATE_LIMITED: "Too many requests. Try again later.",
    ErrorCode.SERVER_ERROR: "Something went wrong on the server.",
    ErrorCode.UNAVAILABLE: "The service is temporarily unavailable.",
}


class ApiError(Exception):
    """A domain error with a stable machine-readable code.

    ``details`` must contain identifiers, field paths and rule codes only —
    never submitted values (they may be PHI and would leak into logs/proxies).
    ``data`` is for the rare responses that carry a result alongside an error,
    e.g. a quarantined submission returned with ``validation_failed``.
    """

    def __init__(
        self,
        code: ErrorCode,
        message: str | None = None,
        *,
        details: dict[str, Any] | None = None,
        data: Any = None,
        retry_after: int | None = None,
        status: int | None = None,
    ) -> None:
        self.code = code
        self.message = message or DEFAULT_MESSAGE[code]
        self.details = details
        self.data = data
        self.retry_after = retry_after
        self.status = status if status is not None else HTTP_STATUS[code]
        super().__init__(f"{code}: {self.message}")
