# ADR 0001: Store schema v2 for scanner provenance

## Decision

The derived SQLite index moves to schema version 2. Documents now retain line
range, source type, content hash, and optional commit SHA. File hashes are
scoped by project and path.

## Rationale

The scanner needs this metadata for incremental removal, provenance, chunked
indexing, and local git-history documents. The index remains derived; version
mismatches require rebuilding rather than in-place migration.

## Consequence

Existing v1 indexes must be rebuilt. Until `ctx scan --rebuild` exists, the
error instructs users to delete `~/.ctx/index.db`.
