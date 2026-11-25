# ADR 0007: Approvals store and stale-hash rule

Pending rules-file syncs detected by `ctx watch` when `autoSync` is `false` are queued in `~/.ctx/approvals.db` (SQLite, WAL mode, schema version `1`), separate from `index.db`.

- **Table `approvals`**: `(id, kind, project_path, target_file, diff_text, diff_hash, status, created_at, decided_at, secret_scan_kinds)`.
- **Scrubbing**: `scrub()` runs before any diff is stored or returned; only scrubbed diff text and redaction kind names are persisted.
- **Idempotency**: Enqueueing the same `(kind, project_path, target_file, diff_hash)` while `pending` returns the existing item without creating duplicates.
- **Stale-hash rule**: `approvals.accept` recomputes the dry-run sync diff and compares its SHA-256 hash against `diff_hash`. If it differs, the item is marked `stale` and no file is written. If it matches, `syncFile(..., { yes: true })` applies the change atomically before marking `accepted`. A second accept on a decided item is a no-op returning `already_decided`.
- **Audit log**: Accept, reject, and stale transitions append one non-sensitive line to `~/.ctx/logs/approvals.log`.
