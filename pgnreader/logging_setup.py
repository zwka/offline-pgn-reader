"""Structured logging: concise console output plus a rotating debug file."""

from __future__ import annotations

import logging
import logging.handlers

from .config import Settings

_CONFIGURED = False


def configure_logging(settings: Settings) -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    _CONFIGURED = True

    settings.ensure_dirs()
    root = logging.getLogger("pgnreader")
    root.setLevel(logging.DEBUG)

    console = logging.StreamHandler()
    console.setLevel(logging.DEBUG if settings.debug else logging.INFO)
    console.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s"))
    root.addHandler(console)

    filehandler = logging.handlers.RotatingFileHandler(
        settings.log_path, maxBytes=2_000_000, backupCount=3, encoding="utf-8"
    )
    filehandler.setLevel(logging.DEBUG)
    filehandler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)-7s %(name)s [%(threadName)s]: %(message)s")
    )
    root.addHandler(filehandler)
