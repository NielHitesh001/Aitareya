import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startApiServer } from "../src/api/server.ts";

async function withServer(run: (socketPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ctx-api-"));
  const socketPath = join(dir, "ctx.sock");
  const server = await startApiServer(socketPath, () => ({ state: "attention", lastPollAt: "2026-11-25T00:00:00Z", allowlistedRepoCount: 2, pendingApprovalCount: 1, errorCount: 0 }));
  try { await run(socketPath); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function request(socketPath: string, body: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let raw = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => { raw += chunk; if (raw.includes("\n")) { socket.end(); resolve(JSON.parse(raw)); } });
    socket.on("connect", () => socket.write(`${body}\n`));
  });
}

test("status returns the versioned engine status", async () => withServer(async (path) => {
  const actual = await request(path, '{"v":1,"id":"one","method":"status"}');
  assert.deepEqual(actual, { v: 1, id: "one", ok: true, result: { state: "attention", lastPollAt: "2026-11-25T00:00:00Z", allowlistedRepoCount: 2, pendingApprovalCount: 1, errorCount: 0 } });
}));

test("socket is owner-only", async () => withServer(async (path) => {
  assert.equal((await stat(path)).mode & 0o777, 0o600);
}));

test("refuses to replace a live socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-api-live-"));
  const socketPath = join(dir, "ctx.sock");
  const first = await startApiServer(socketPath);
  try {
    await assert.rejects(() => startApiServer(socketPath), /live socket/);
  } finally {
    await new Promise<void>((resolve) => first.close(() => resolve()));
  }
});

test("rejects malformed requests and unknown versions", async () => withServer(async (path) => {
  assert.equal((await request(path, "not json")).error?.code, "INVALID_JSON");
  assert.equal((await request(path, '{"v":2,"id":"x","method":"status"}')).error?.code, "UNSUPPORTED_VERSION");
  assert.equal((await request(path, '{"v":1,"id":"x","method":"repos.allow"}')).error?.code, "UNKNOWN_METHOD");
}));
