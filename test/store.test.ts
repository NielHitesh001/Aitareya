import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store, storeSchemaVersion } from "../src/store.ts";

async function temporaryDatabase(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "ctx-store-")), "index.db");
}

test("creates and reopens a WAL-mode index", async () => {
  const path = await temporaryDatabase();
  const first = new Store({ path });
  first.close();
  const reopened = new Store({ path });
  reopened.close();
});

test("rejects an incompatible schema with rebuild guidance", async () => {
  const path = await temporaryDatabase();
  const store = new Store({ path });
  store.close();
  const database = new DatabaseSync(path);
  database.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(storeSchemaVersion + 1));
  database.close();
  assert.throws(() => new Store({ path }), /Delete ~\/\.ctx\/index\.db/);
});

test("stores scanner provenance and hashes per project", async () => {
  const store = new Store({ path: await temporaryDatabase() });
  store.upsertChunk({ project: "/repo-a", path: "src/a.ts", content: "const answer = 42;", startLine: 1, endLine: 1, sourceType: "code", hash: "file-hash", commitSha: "abc123" });
  store.setFileHash("/repo-a", "src/a.ts", "file-hash");
  store.setFileHash("/repo-b", "src/a.ts", "other-hash");
  assert.equal(store.fileHash("/repo-a", "src/a.ts"), "file-hash");
  assert.equal(store.fileHash("/repo-b", "src/a.ts"), "other-hash");
  assert.deepEqual(store.searchDocuments("answer"), [{ path: "src/a.ts", content: "const answer = 42;" }]);
  store.removeFile("/repo-a", "src/a.ts");
  assert.deepEqual(store.searchDocuments("answer"), []);
  store.close();
});

test("indexes and queries document content with FTS5", async () => {
  const store = new Store({ path: await temporaryDatabase() });
  store.upsertDocument("/Users/test/code/github/example/rules.md", "Persistent context helps agents make better decisions.");
  assert.deepEqual(store.searchDocuments("context"), [{
    path: "/Users/test/code/github/example/rules.md",
    content: "Persistent context helps agents make better decisions.",
  }]);
  store.close();
});

test("returns existing V2 provenance with search results", async () => {
  const store = new Store({ path: await temporaryDatabase() });
  store.upsertChunk({ project: "/repo", path: "context/rules.md", content: "search provenance", startLine: 2, endLine: 3, sourceType: "rule", hash: "h" });
  assert.deepEqual(store.searchChunks("provenance"), [{ id: 1, project: "/repo", path: "context/rules.md", content: "search provenance", startLine: 2, endLine: 3, sourceType: "rule" }]);
  store.close();
});

test("context query excludes code and commit chunks", async () => {
  const store = new Store({ path: await temporaryDatabase() });
  store.upsertChunk({ project: "/repo", path: "context/rules.md", content: "rule", startLine: 1, endLine: 1, sourceType: "rule", hash: "1" });
  store.upsertChunk({ project: "/repo", path: "src/a.ts", content: "code", startLine: 1, endLine: 1, sourceType: "code", hash: "2" });
  assert.deepEqual(store.contextChunks("/repo").map((chunk) => chunk.sourceType), ["rule"]); store.close();
});

test("decision and project status reads preserve existing metadata", async () => {
  const store = new Store({ path: await temporaryDatabase() }); store.upsertChunk({ project: "/repo", path: "context/decisions/one.md", content: "decision", startLine: 1, endLine: 1, sourceType: "decision", hash: "d" });
  assert.equal(store.decisionChunks()[0].sourceType, "decision"); assert.equal(store.projectStatuses(["/repo"])[0].project, "/repo"); store.close();
});
