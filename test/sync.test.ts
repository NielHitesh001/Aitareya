import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { syncFile } from "../src/sync.ts";
async function path() { return join(await mkdtemp(join(tmpdir(), "ctx-sync-")), "AGENTS.md"); }
test("appends markers without changing outside content", async () => { const file = await path(); await writeFile(file, "outside\n"); await syncFile(file, "rules", { yes: true }); assert.equal(await readFile(file, "utf8"), "outside\n<!-- ctx:begin -->\nrules\n<!-- ctx:end -->\n"); });
test("dry run and declined confirmation never write", async () => { const file = await path(); await writeFile(file, "old\n"); const dry = await syncFile(file, "new", { dryRun: true }); assert.match(dry.diff, /\nnew\n/); assert.equal(await readFile(file, "utf8"), "old\n"); await syncFile(file, "new", { confirm: async () => false }); assert.equal(await readFile(file, "utf8"), "old\n"); });
test("yes writes once, is idempotent, and scrubs generated content", async () => { const file = await path(); const generated = "token=not-a-real-secret"; await syncFile(file, generated, { yes: true }); const text = await readFile(file, "utf8"); assert.match(text, /\[REDACTED:assignment\]/); assert.equal((await syncFile(file, generated, { yes: true })).action, "unchanged"); });
test("failed temporary write leaves the original file intact", async () => { const file = await path(); await writeFile(file, "original\n"); await assert.rejects(() => syncFile(file, "changed", { yes: true, writeFile: async () => { throw new Error("disk failure"); } })); assert.equal(await readFile(file, "utf8"), "original\n"); });
