import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { indexGitHistory } from "../src/git-history.ts";
import { scanRepository } from "../src/scanner.ts";
import { Store } from "../src/store.ts";
const run = promisify(execFile);

async function fixture() { const dir = await mkdtemp(join(tmpdir(), "ctx-scan-")); const repo = join(dir, "repo"); await cp(join(process.cwd(), "test/fixtures/scanner-repo"), repo, { recursive: true }); return { dir, repo, store: new Store({ path: join(dir, "index.db") }) }; }

test("scans incrementally and removes deleted files without reading excluded paths", async () => {
  const { dir, repo, store } = await fixture(); try {
    await mkdir(join(repo, "node_modules")); await writeFile(join(repo, "node_modules/a.js"), "skip"); await writeFile(join(repo, ".env"), "skip"); await writeFile(join(repo, "id_rsa"), "skip"); await writeFile(join(repo, "credentials.json"), "skip"); await writeFile(join(repo, "ignored.txt"), "skip"); await writeFile(join(repo, "big.txt"), "x".repeat(600000)); await symlink("/etc/hosts", join(repo, "outside"));
    const reads: string[] = []; const first = await scanRepository(repo, { store, readFile: async (path) => { reads.push(String(path)); return Buffer.from(await (await import("node:fs/promises")).readFile(path)); } });
    assert.deepEqual(first.indexed, [".gitignore", "keep.md"]); assert.equal(reads.some((path) => /\.env|id_rsa|credentials/.test(path)), false);
    await writeFile(join(repo, "keep.md"), "changed context\n"); const second = await scanRepository(repo, { store }); assert.deepEqual(second.indexed, ["keep.md"]);
    await rm(join(repo, "keep.md")); const third = await scanRepository(repo, { store }); assert.deepEqual(third.removed, ["keep.md"]);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("indexes local git history only", async () => {
  const { dir, repo, store } = await fixture(); try {
    await run("git", ["init", "-q", repo]); await run("git", ["-C", repo, "add", "."]); await run("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture subject"]);
    assert.equal(await indexGitHistory(repo, store, 300), 1); assert.equal(store.searchDocuments("fixture").length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
