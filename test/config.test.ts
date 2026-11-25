import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, parseConfig } from "../src/config.ts";

test("config supplies secure defaults", () => {
  assert.equal(parseConfig({}, "/Users/test").embedding.url, "http://localhost:11434");
});

test("config rejects non-local embedding URLs", () => { assert.throws(() => parseConfig({ embedding: { url: "https://localhost" } }, "/Users/test"), /local HTTP/); assert.throws(() => parseConfig({ embedding: { url: "http://example.com" } }, "/Users/test"), /local HTTP/); });
test("autoSync defaults false and rejects non-booleans", () => { assert.equal(parseConfig({}, "/Users/test").autoSync, false); assert.throws(() => parseConfig({ autoSync: "yes" }, "/Users/test"), /autoSync/); });

test("configured projects are realpath-resolved git directories", async () => { const root = await mkdtemp(join(tmpdir(), "ctx-config-")); await mkdir(join(root, ".git")); const config = join(root, "config.json"); await writeFile(config, JSON.stringify({ projects: [root] })); assert.deepEqual((await loadConfig(config)).projects, [await (await import("node:fs/promises")).realpath(root)]); });

test("config rejects tokens, unsafe paths, and invalid polling", () => {
  assert.throws(() => parseConfig({ githubToken: "secret" }, "/Users/test"), /Keychain/);
  assert.throws(() => parseConfig({ allowlist: ["/tmp/repo"] }, "/Users/test"), /inside/);
  assert.throws(() => parseConfig({ pollIntervalMinutes: 4 }, "/Users/test"), /at least 5/);
});
