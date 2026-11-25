#!/usr/bin/env python3
"""Create .env from .env.example, replacing generation markers with fresh secrets.

    __GENERATE__         → 48 random bytes, URL-safe base64 (safe inside postgres:// URLs)
    __GENERATE_B64_32__  → 32 random bytes, standard base64 (AES-256 key material)

Refuses to overwrite an existing .env unless --force is given. Writes mode 0600.
"""

from __future__ import annotations

import argparse
import base64
import os
import secrets
import sys
from pathlib import Path


def render(template: str) -> str:
    lines = []
    for line in template.splitlines():
        while "__GENERATE_B64_32__" in line:
            line = line.replace(
                "__GENERATE_B64_32__", base64.b64encode(secrets.token_bytes(32)).decode(), 1
            )
        while "__GENERATE__" in line:
            line = line.replace("__GENERATE__", secrets.token_urlsafe(48), 1)
        lines.append(line)
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--example", type=Path, default=Path(".env.example"))
    parser.add_argument("--out", type=Path, default=Path(".env"))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if args.out.exists() and not args.force:
        print(f"{args.out} exists; refusing to overwrite (use --force).", file=sys.stderr)
        return 1
    content = render(args.example.read_text(encoding="utf-8"))
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(content)
    os.chmod(args.out, 0o600)
    print(f"Wrote {args.out} with freshly generated secrets.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
