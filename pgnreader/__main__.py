"""CLI entry point.

    python -m pgnreader serve            # start the local server
    python -m pgnreader index PATH...    # index PGN file(s) from the terminal
    python -m pgnreader reset            # drop and recreate the index cache
"""

from __future__ import annotations

import argparse
import sys

from .config import settings
from .db import Database
from .logging_setup import configure_logging
from .service import LibraryService, ServiceError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pgnreader", description="Offline PGN reader")
    sub = parser.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve", help="run the local web server")
    serve.add_argument("--host", default=settings.host)
    serve.add_argument("--port", type=int, default=settings.port)
    serve.add_argument("--reload", action="store_true", help="dev auto-reload")

    index = sub.add_parser("index", help="register and scan PGN files")
    index.add_argument("paths", nargs="+", help=".pgn file paths")
    index.add_argument("--force", action="store_true", help="re-scan even if unchanged")

    sub.add_parser("reset", help="delete and recreate the index database")

    args = parser.parse_args(argv)
    configure_logging(settings)

    if args.cmd == "serve":
        import uvicorn

        print(f"Offline PGN Reader → http://{args.host}:{args.port}")
        uvicorn.run(
            "pgnreader.api:create_app",
            factory=True,
            host=args.host,
            port=args.port,
            reload=args.reload,
            log_level="debug" if settings.debug else "info",
        )
        return 0

    if args.cmd == "index":
        db = Database(settings.db_path)
        db.initialize()
        svc = LibraryService(db, settings)
        for p in args.paths:
            info = svc.register_file(p, scan=False)
            info = svc.scan_file_sync(info["id"], force=args.force)
            print(
                f"{info['name']}: {info['game_count']} games, "
                f"{info['warning_count']} warnings, status={info['scan_status']}"
            )
        return 0

    if args.cmd == "reset":
        db = Database(settings.db_path)
        db.initialize()
        service = LibraryService(db, settings)
        try:
            service.reset_index()
        except ServiceError as exc:
            print(f"Reset failed: {exc}", file=sys.stderr)
            return 1
        print(f"Index reset: {settings.db_path}")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
