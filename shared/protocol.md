# ctx local API protocol

The ctx engine exposes a local, newline-delimited JSON API over a Unix domain
socket. The default socket is `~/.ctx/ctx.sock`. The server creates it with
mode `0600`; it is never a network listener.

## Envelope

Every request and response carries protocol version `1` (step 3 adds `repos.status` and `repos.pull`, and step 4 adds `approvals.list`, `approvals.accept`, and `approvals.reject` under version `1`; breaking changes will increment `v`):

```json
{"v":1,"id":"request-id","method":"status","params":{}}
```

```json
{"v":1,"id":"request-id","ok":true,"result":{}}
```

Failures keep the request ID when available and use a stable, non-sensitive
code. Errors must never include credentials, secret values, or transcript
content.

```json
{"v":1,"id":"request-id","ok":false,"error":{"code":"UNKNOWN_METHOD","message":"Unsupported method."}}
```

The server rejects invalid JSON, non-object envelopes, missing IDs, and any
version other than `1`. A request is exactly one JSON object terminated by a
newline. Messages larger than 64 KiB are rejected.

## Methods available in step 1

### `status` (read-only)

`params` must be an empty object or omitted. It returns engine status only:

```json
{
  "v": 1,
  "id": "a1",
  "ok": true,
  "result": {
    "state": "healthy",
    "lastPollAt": null,
    "allowlistedRepoCount": 0,
    "pendingApprovalCount": 0,
    "errorCount": 0
  }
}
```

### `repos.status` (read-only, step 3)

`params` must be an empty object or omitted. Returns per-repo status from the engine (same data as `ctx github status`):

```json
{
  "v": 1,
  "id": "r1",
  "ok": true,
  "result": {
    "repos": [
      {
        "name": "NielHitesh001/HERMES",
        "path": "/Users/nielhitesh/code/github/HERMES",
        "branch": "main",
        "state": "upToDate",
        "ahead": 0,
        "behind": 0,
        "dirty": false,
        "lastFetch": "2026-11-25T17:33:55.122Z",
        "prState": "none"
      }
    ],
    "counts": {
      "upToDate": 1,
      "behind": 0,
      "ahead": 0,
      "diverged": 0,
      "dirty": 0,
      "missing": 0
    },
    "lastSuccessfulPoll": "2026-11-25T17:33:58.497Z"
  }
}
```

### `repos.pull` (write, step 3)

`params` must be `{"repo": "<owner/repo>"}` where `repo` is in `github.repos`. Runs a fast-forward-only pull for that single repository and writes an audit line to `~/.ctx/logs/github.log`. Rejects any repository not in `github.repos` with `NOT_ALLOWED`.

```json
{
  "v": 1,
  "id": "p1",
  "ok": true,
  "result": {
    "repo": "NielHitesh001/HERMES",
    "status": "up_to_date",
    "line": "NielHitesh001/HERMES: up to date"
  }
}
```

### `approvals.list` (read-only, step 4)

`params` may be omitted, `{}`, or `{"status": "pending" | "accepted" | "rejected" | "stale" | "all"}` (defaults to `"pending"`). Returns scrubbed pending/filtered approval items:

```json
{
  "v": 1,
  "id": "a1",
  "ok": true,
  "result": {
    "approvals": [
      {
        "id": "uuid",
        "projectName": "HERMES",
        "targetFile": "AGENTS.md",
        "createdAt": "2026-11-26T00:00:00.000Z",
        "diffText": "--- ...",
        "secretScanKinds": []
      }
    ]
  }
}
```

### `approvals.accept` (write, step 4)

`params` must be `{"id": "<approval-id>"}`. Re-runs the sync dry-run; if the scrubbed diff hash changed, marks `stale` and refuses to write. Otherwise applies atomically via `ctx sync` and marks `accepted`. A second accept returns `status: "already_decided"` (`"already decided"`).

### `approvals.reject` (write, step 4)

`params` must be `{"id": "<approval-id>"}`. Marks the approval `rejected` without writing any files.

Future methods are added here before either the engine or app exposes them.
