"""Offline PGN reader — local-only PGN indexing, parsing and study UI."""

__version__ = "1.1.0"

# Version of the SQLite cache schema. Bumping this causes the index database
# to be rebuilt on next startup (the DB is a disposable cache of source PGNs).
SCHEMA_VERSION = 1
