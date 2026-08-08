"""Reset command tests use the same service protection as the HTTP API."""

from __future__ import annotations

import pgnreader.__main__ as cli
from pgnreader import SCHEMA_VERSION
from pgnreader.config import Settings
from pgnreader.db import Database
from pgnreader.service import ServiceError


def isolated_settings(tmp_path):
    return Settings(
        data_dir=tmp_path / "data",
        watch_dirs=[],
        upload_dir=tmp_path / "library",
    )


def test_reset_command_recreates_the_index_in_isolated_data(monkeypatch, tmp_path, capsys):
    settings = isolated_settings(tmp_path)
    monkeypatch.setattr(cli, "settings", settings)
    database = Database(settings.db_path)
    database.initialize()
    with database.connect() as conn:
        conn.execute("INSERT INTO files(path, name) VALUES (?, ?)", ("/tmp/source.pgn", "source.pgn"))

    assert cli.main(["reset"]) == 0
    assert "Index reset:" in capsys.readouterr().out
    with database.connect() as conn:
        assert conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()["value"] == str(SCHEMA_VERSION)
        assert conn.execute("SELECT COUNT(*) FROM files").fetchone()[0] == 0


def test_reset_command_returns_nonzero_for_service_conflict(monkeypatch, tmp_path, capsys):
    settings = isolated_settings(tmp_path)
    monkeypatch.setattr(cli, "settings", settings)

    def reject_reset(_service):
        raise ServiceError("cannot reset while a scan is running", status=409)

    monkeypatch.setattr(cli.LibraryService, "reset_index", reject_reset)

    assert cli.main(["reset"]) == 1
    assert "cannot reset while a scan is running" in capsys.readouterr().err
