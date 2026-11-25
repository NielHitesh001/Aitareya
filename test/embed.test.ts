import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { embed } from "../src/embed.ts";
import { Store } from "../src/store.ts";

async function withServer(handler: Parameters<typeof createServer>[0], run: (url: string, store: Store) => Promise<void>) { const server = createServer(handler); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port; const store = new Store({ path: join(await mkdtemp(join(tmpdir(), "ctx-embed-")), "db") }); try { await run(`http://127.0.0.1:${port}`, store); } finally { store.close(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
test("caches embeddings by hash", async () => { let requests = 0; await withServer((_req, res) => { requests++; res.end(JSON.stringify({ embeddings: [[1, 2]] })); }, async (url, store) => { assert.equal((await embed("ordinary text", { store, hash: "same", url })).cached, false); assert.equal((await embed("ordinary text", { store, hash: "same", url })).cached, true); assert.equal(requests, 1); }); });
test("down, timeout, and missing model are unavailable", async () => { const store = new Store({ path: join(await mkdtemp(join(tmpdir(), "ctx-embed-")), "db") }); assert.equal((await embed("x", { store, hash: "down", url: "http://127.0.0.1:1" })).available, false); store.close(); await withServer((_req, _res) => {}, async (url, store) => assert.equal((await embed("x", { store, hash: "time", url, timeoutMs: 20 })).available, false)); await withServer((_req, res) => { res.statusCode = 404; res.end(); }, async (url, store) => assert.equal((await embed("x", { store, hash: "missing", url })).available, false)); });
test("keyword FTS remains available", async () => { const store = new Store({ path: join(await mkdtemp(join(tmpdir(), "ctx-embed-")), "db") }); store.upsertDocument("doc", "keyword fallback"); assert.equal((await embed("x", { store, hash: "none", url: "http://127.0.0.1:1" })).available, false); assert.equal(store.searchDocuments("keyword").length, 1); store.close(); });
