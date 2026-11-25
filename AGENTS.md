# AGENTS.md: ctx (laptop-only)

## Purpose

`ctx` is a local-first context agent for a solo developer on a MacBook (16GB). It scans the user's git repos, maintains a shared context store, writes rules files (AGENTS.md, CLAUDE.md, .cursorrules), and exposes an MCP server so coding agents share the same project knowledge.

Out of scope for now: phone access, HTTP/SSE, Tailscale, PWA. Do not build them.

Related files:
- `GITHUB_SYNC.md`: GitHub sync rules (build-order step 12).
- `companion/`: the macOS menu bar app. It is a front end only. It talks to the engine over the socket and contains no business logic.
- `shared/protocol.md`: the socket protocol contract. Do not change it without asking.

## Core principles (non-negotiable)

1. **Files are truth; everything else is derived.**
   - `context/*.md` (rules, ADRs, summaries) inside each repo is the source of truth and lives in Git.
   - `~/.ctx/index.db` (SQLite) is a derived index. It must be deletable at any time, and `ctx scan` must rebuild it fully.
2. **No cloud dependency.** Nothing leaves the machine. No remote API calls for embeddings or LLMs.
3. **Approval gate.** Rules-file changes are never applied silently in the default mode.
4. **Secret safety first.** Secrets must never enter the index, logs, or rules files.
5. **Resource-polite.** Indexing must not starve the user's editor or agents. Cap concurrency (default 2 workers) and index one file at a time in the default path.

## Platform

- macOS (Apple Silicon), Node.js 20+, TypeScript.
- SQLite via `better-sqlite3`, with `sqlite-vec` and FTS5 for search.
- Embeddings: Ollama HTTP API at `http://localhost:11434`, model `nomic-embed-text`. If Ollama is unreachable, fall back to keyword-only (FTS5) search. Never fail hard because embeddings are unavailable.
- launchd for daemon mode.
- Xcode 27.2 is installed and active. Use XCTest for the Swift companion.

## Repository layout

```
ctx/
├── bin/ctx                 # CLI entry (shebang, calls dist/cli.js)
├── src/
│   ├── cli.ts              # command router
│   ├── config.ts           # ~/.ctx/config.json, defaults, validation
│   ├── doctor.ts           # environment checks (done)
│   ├── api.ts              # socket API (done)
│   ├── store.ts            # SQLite + FTS5 (done); sqlite-vec pending
│   ├── scrub.ts            # secret detection and redaction
│   ├── scanner.ts          # full + incremental, hash-based, .gitignore-aware
│   ├── git-history.ts      # mines last 300 commits
│   ├── embed.ts            # Ollama client with keyword-only fallback
│   ├── rank.ts             # tiered ranking + token budget + file-edit boost
│   ├── writers/
│   │   ├── agents-md.ts
│   │   ├── claude-md.ts
│   │   └── cursorrules.ts
│   ├── sync.ts             # diff-and-approve flow for rules files
│   ├── watcher.ts          # fs watcher, debounced
│   ├── mcp-server.ts       # stdio MCP server
│   └── daemon.ts           # launchd plist install/uninstall
├── test/                   # unit + fixture-repo tests
├── companion/              # SwiftUI menu bar app (separate build)
├── shared/protocol.md
├── package.json
├── AGENTS.md
└── GITHUB_SYNC.md
```

## Commands (all must exist)

| Command | Behavior |
|---|---|
| `ctx doctor` | Check Node version, Ollama reachable, `nomic-embed-text` pulled, SQLite and sqlite-vec loadable, `~/.ctx` writable, `gh` and `git` present. Print pass/fail per check with a fix hint. Never print token values. |
| `ctx init` | Register the current repo in `~/.ctx/config.json`. Create `context/rules.md` and `context/decisions/` if missing. Run a full scan. |
| `ctx scan` | Rebuild the index for all registered projects, or only the current one with `--project`. `--rebuild` drops and recreates the index. |
| `ctx sync` | Diff current rules-file blocks against generated content. Show the diff, ask `y/N`, then write. Only touch content between `<!-- ctx:begin -->` and `<!-- ctx:end -->`. `--dry-run` shows the diff only. `--yes` skips the prompt. |
| `ctx watch` | Watch registered repos. Incremental re-index on change, debounced ~500ms. Does NOT write rules files unless `autoSync: true`. |
| `ctx serve` | Start the stdio MCP server. Tools: `ctx_search`, `ctx_decisions`, `ctx_projects`. |
| `ctx api serve` | Start the Unix socket API for the companion app (see `shared/protocol.md`). |
| `ctx daemon install` / `uninstall` | Install or remove a launchd agent that runs `ctx watch` and `ctx api serve` at login. |
| `ctx github ...` | GitHub sync commands. See `GITHUB_SYNC.md`. |
| `ctx sessions ...` | Not built. Deferred. Do not implement. |
| `ctx export` | Not in scope. Do not implement. |

## Scanner rules

- Hash-based incremental scanning. Store a content hash per file. Re-index only files whose hash changed. Remove index entries for deleted files.
- Respect `.gitignore`.
- Always skip: `node_modules`, `.git`, `dist`, `build`, `target`, `.venv`, binary files, files over 512KB, and lockfiles.
- **Never read** `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `*.pfx`, `credentials*`, or anything with `secrets` in the name.
- Do not follow symlinks out of the repo.
- Git history: mine the last 300 commits (subject, body, files touched) using local `git log` only. Store as `commit` documents with `sha` provenance.
- Chunk code at blank-line boundaries, max ~1500 characters, with overlap. Tree-sitter is not in scope yet.
- Every chunk stores: project, path, start line, end line, source type (`rule` | `decision` | `doc` | `code` | `commit`), hash, updated_at.

## Store rules

- Single SQLite file at `~/.ctx/index.db`. WAL mode on. Path overridable for tests.
- Tables: `projects`, `documents`, `documents_fts` (FTS5), `file_hashes`, `meta` (schema version). `vec_documents` (sqlite-vec) is added with the embeddings step.
- Schema version is checked on open. On mismatch, fail with a message telling the user to run `ctx scan --rebuild`. No in-place migrations in v1.
- Embeddings are cached by content hash. Rebuilding must not re-embed unchanged chunks.

## Ranking and token budget

- Hybrid search: combine FTS5 BM25 and vector similarity with reciprocal rank fusion. If vectors are unavailable, use FTS5 alone.
- Priority tiers: `rule` > `decision` > `doc` > `code` > `commit`. A higher tier wins ties.
- Boost chunks from files the user is currently editing (from `git status` or recently modified files).
- Default budget: 4000 tokens per MCP response, estimated as characters / 4. Stop adding results when the budget is reached.
- **Every result carries provenance:** project, `path:startLine-endLine`, and source type.

## Secret scrubbing

- Run `scrub.ts` on every chunk before it is stored or embedded.
- Redact with `[REDACTED:<kind>]`: AWS keys (`AKIA...`), GitHub tokens (`ghp_`, `github_pat_`), Slack tokens (`xox[baprs]-`), Stripe keys (`sk_live_`, `sk_test_`), `password=` / `secret=` / `token=` assignments with values, PEM private key blocks, JWTs, and high-entropy strings next to key-like names.
- Scrubbing that throws means the chunk is skipped, never stored raw.
- Scrub results report kind and count only. Never return or log the matched value.
- Tests use obviously fake secrets, one per pattern.

## Approval gate (`ctx sync`)

- Generated content goes only inside the `ctx:begin` / `ctx:end` markers.
- If markers are missing, append them at the end of the file. Never delete content outside them.
- Show a unified diff before writing. Require confirmation unless `--yes`.
- Watch mode never writes these files unless `autoSync: true`.

## MCP server (stdio)

- Use the official MCP TypeScript SDK.
- `ctx_search(query, project?, limit?)`: ranked chunks with provenance, within the token budget.
- `ctx_decisions(project?)`: ADRs from `context/decisions/`, newest first.
- `ctx_projects()`: registered projects and last scan time.
- Read-only. Never writes files or modifies the index.
- Logs go to stderr only. Stdout is reserved for the protocol.

## Configuration

`~/.ctx/config.json` (created by `ctx init` if absent):

```json
{
  "projects": [],
  "autoSync": false,
  "embedding": { "provider": "ollama", "model": "nomic-embed-text", "url": "http://localhost:11434" },
  "indexing": { "concurrency": 2, "maxFileBytes": 524288 },
  "budget": { "defaultTokens": 4000 },
  "gitHistoryLimit": 300
}
```

Validate on load. Print a clear error for invalid fields. The GitHub block is defined in `GITHUB_SYNC.md`. Tokens never appear in this file.

## Testing requirements

- Unit tests: `scrub.ts` (each pattern), `rank.ts` (tier order, budget cutoff), `sync.ts` (marker handling), store (done), config and doctor (done), socket API (done).
- Fixture repo under `test/fixtures/` for integration tests: `init`, `scan` (incremental: change one file, only that file re-indexes), and `sync` (diff shown, markers respected).
- Keyword-only test: search with Ollama stopped still returns results.
- MCP test: spawn `ctx serve`, send `tools/list` and one `ctx_search` over stdio, verify the response.
- Grep test: source must not contain `push --force`, `branch -D`, `repo delete`, or `gh repo` mutation commands.

## Build order (follow strictly)

1. Scaffold, `ctx doctor`, config loader. **Done.**
2. Store (SQLite, FTS5) with schema versioning. **Done.**
3. Scrubber with tests.
4. Scanner (full + incremental), `.gitignore`, git history mining.
5. Embeddings client with keyword fallback.
6. Ranking and token budget.
7. `ctx init`, `ctx scan`, `ctx_search` via CLI.
8. Writers and `ctx sync` with the approval gate.
9. `ctx watch`.
10. MCP stdio server.
11. `ctx daemon install`.
12. GitHub sync (see `GITHUB_SYNC.md`).
13. Companion app steps (see `companion/` master prompt). Requires steps 1 to 12.

Do not start step N+1 until step N has passing tests.

## Out of scope (do not implement without an explicit request)

- Phone access, HTTP/SSE server, Tailscale, PWA, mobile Git sync.
- Session capture and auto-learned rules (`SESSIONS.md` not yet written).
- Staleness detection.
- Tree-sitter symbol scanning.
- Evals.
- Cross-project pattern library and impact analysis.
- Inbox and remote capture.
- `ctx export`.

If asked to build one of these, note that it is deferred and continue with the current build-order step.

## Working agreement

- Before writing files, list the files you will create.
- After each step, run its tests and report the exact command and result.
- Keep commits small, one per build-order step, e.g. `scrub: pattern-based redaction`.
- If a design decision is ambiguous, choose the option that keeps data local and the approval gate intact, and record it as an ADR in `context/decisions/`.
- Ask before changing the store schema, the marker format, the socket protocol, or MCP tool names.
- Never print secret values in logs, test output, or errors, including from fixtures.
- Do not create a second project. The CLI binary and package name are `ctx`.
