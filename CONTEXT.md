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

**Mobile Library**:
A browser-persisted Library mode for the mobile PWA containing retained
imported PGN sources, zero or one active source, and each source's Index/Game
record data in a versioned IndexedDB snapshot. The current snapshot schema is
v3; v1 and v2 snapshots migrate on restore. Importing another valid source
retains existing sources and makes the imported source active. Sources may
contain any number of Game records. This constraint applies only to the Mobile
Library; the server-side Library remains multi-source.
_Avoid_: Mobile collection, mobile catalog, server Index when naming mobile state

**Imported source**:
A PGN source selected by the user and taken into the Mobile Library for reading, independent of the source file's original device location.
_Avoid_: Linked file, watched file

**Source name**:
The user-visible filename retained for an Imported source. It is stored
separately from the original device location; mobile imports require a `.pgn`
suffix and reject a case-insensitive duplicate name.
_Avoid_: Source path, linked file

**Active source**:
The PGN source currently selected from the retained sources in the Mobile
Library and available to its Reader, or no source when the selection is empty.
A candidate import is not active until its Scan and snapshot save both succeed.
_Avoid_: Replacement source for a candidate that has not been committed

**Resume bookmark**:
The one automatic bookmark retained for a source after a Game record successfully
opens. It identifies only the source and Game record and always reopens that Game
record from its starting position.
_Avoid_: Reading position, move bookmark, node bookmark

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
