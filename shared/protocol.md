# ctx local API protocol

The ctx engine exposes a local, newline-delimited JSON API over a Unix domain
socket. The default socket is `~/.ctx/ctx.sock`. The server creates it with
mode `0600`; it is never a network listener.

## Envelope

Every request and response carries protocol version `1`:

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

Future methods are added here before either the engine or app exposes them.
