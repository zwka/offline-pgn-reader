# PGN Library

This context describes a local library for discovering, indexing, and reading chess games stored in Portable Game Notation (PGN) sources.

## Language

**PGN source**:
A file or managed copy containing one or more PGN games that belongs to the library.
_Avoid_: Input file, corpus

**Source bytes**:
The original byte sequence of a PGN source, treated as authoritative for source offsets and raw views.
_Avoid_: Normalized text, raw string

**Source text**:
The decoded textual view of source bytes used for a human-readable PGN response.
_Avoid_: Raw source, canonical source

**Source fingerprint**:
A summary used to detect whether the source bytes have changed since the Index was built.
_Avoid_: File version, cache key

**Tag pair**:
An ordered name and value from a PGN source header; duplicate names and their source order may be meaningful.
_Avoid_: Header object, metadata map

**Library**:
The managed collection of PGN sources and the game records discovered within them.
_Avoid_: Database, repository

**Scan**:
The process of reading a PGN source to discover its games and update the library's index.
_Avoid_: Import, parse

**Index**:
The searchable record of the games discovered in the library's PGN sources.
_Avoid_: Catalog, cache

**Game record**:
The indexed identity and metadata for one chess game in a PGN source.
_Avoid_: Game row, match

**GameDocument**:
The complete representation of one chess game, including its metadata and navigable move tree.
_Avoid_: Parsed game, game object

**Node**:
A point in a GameDocument's move tree that represents a chess position or move together with its annotations and continuations.
_Avoid_: Move, tree item

**Variation**:
An alternate continuation from a node in a GameDocument's move tree.
_Avoid_: Line, branch
