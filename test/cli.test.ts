import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
const run = promisify(execFile); const cli = join(process.cwd(), "src/cli.ts");
async function command(cwd: string, home: string, ...args: string[]) { return run(process.execPath, [cli, ...args], { cwd, env: { ...process.env, CTX_HOME: home } }); }
async function repo() { const root = await mkdtemp(join(tmpdir(), "ctx-cli-")); await run("git", ["init", "-q", root]); await writeFile(join(root, "readme.md"), "searchable project text\n"); return { root, home: join(root, ".ctx-test") }; }
test("init rejects non-git directories", async () => { const root = await mkdtemp(join(tmpdir(), "ctx-no-git-")); await assert.rejects(() => command(root, join(root, "home"), "init"), /git repository/); });
test("init creates context, preserves rules, and is idempotent", async () => { const { root, home } = await repo(); await mkdir(join(root, "context"), { recursive: true }); await writeFile(join(root, "context/rules.md"), "existing\n"); await command(root, home, "init"); await command(root, home, "init"); assert.equal(await readFile(join(root, "context/rules.md"), "utf8"), "existing\n"); assert.equal((await readFile(join(home, "config.json"), "utf8")).match(/"projects"/g)?.length, 1); });
test("scan is incremental and search has provenance with keyword fallback", async () => { const { root, home } = await repo(); await command(root, home, "init"); const second = await command(root, home, "scan"); assert.equal(second.stdout, ""); const result = await command(root, home, "search", "searchable"); assert.match(result.stdout, /readme\.md:1-2 \[doc\]\nsearchable project text/); });
