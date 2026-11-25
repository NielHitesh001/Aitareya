import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { defaultConfig, saveConfig } from "../src/config.ts";
import { statusRepos } from "../src/github.ts";
import { createReposPullProvider, createReposStatusProvider, startApiServer } from "../src/api/server.ts";

const run = promisify(execFile);
const REAL_GIT = "/usr/bin/git";

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

async function withTempHome<T>(fn: (home: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ctx-api-repos-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home, root);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(REAL_GIT, ["-C", cwd, ...args]);
  return stdout.trim();
}

test("repos.status counts match statusRepos and repos.pull enforces allowlist and logs audit line", async () => {
  await withTempHome(async (home, root) => {
    const bareDir = join(root, "alpha-origin.git");
    const seedDir = join(root, "alpha-seed");
    const cloneDir = join(home, "code/github/owner/alpha");

    await run(REAL_GIT, ["init", "-q", "-b", "main", seedDir]);
    await git(seedDir, "config", "user.name", "Test User");
    await git(seedDir, "config", "user.email", "test@example.com");
    await writeFile(join(seedDir, "README.md"), "v1\n");
    await git(seedDir, "add", "README.md");
    await git(seedDir, "commit", "-q", "-m", "initial");
    await run(REAL_GIT, ["clone", "--bare", "-q", seedDir, bareDir]);
    await mkdir(dirname(cloneDir), { recursive: true });
    await run(REAL_GIT, ["clone", "-q", bareDir, cloneDir]);
    await git(cloneDir, "config", "user.name", "Test User");
    await git(cloneDir, "config", "user.email", "test@example.com");
    await git(cloneDir, "remote", "set-head", "origin", "main");

    await writeFile(join(seedDir, "README.md"), "v2\n");
    await git(seedDir, "add", "README.md");
    await git(seedDir, "commit", "-q", "-m", "remote update");
    await run(REAL_GIT, ["--git-dir", bareDir, "fetch", "-q", seedDir, "refs/heads/main:refs/heads/main"]);
    await git(cloneDir, "fetch", "-q", "origin");

    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    const socketPath = join(root, "ctx.sock");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/alpha", "owner/missing"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const cliStatus = await statusRepos({ configPath, home, logPath });
    const server = await startApiServer(socketPath, {
      reposStatus: createReposStatusProvider({ configPath, home, logPath }),
      reposPull: createReposPullProvider({ configPath, home, logPath }),
    });

    try {
      const statusRes = await request(socketPath, '{"v":1,"id":"rs1","method":"repos.status","params":{}}');
      assert.equal(statusRes.ok, true);
      const result = statusRes.result as {
        repos: Array<{ name: string; state: string; behind: number }>;
        counts: { upToDate: number; behind: number; ahead: number; diverged: number; dirty: number; missing: number };
      };
      assert.deepEqual(result.counts, { upToDate: 0, behind: 1, ahead: 0, diverged: 0, dirty: 0, missing: 1 });
      assert.match(cliStatus.summary, /0 up to date, 1 behind, 0 ahead, 0 diverged, 0 dirty, 1 missing/);
      assert.equal(result.repos[0]?.name, "owner/alpha");
      assert.equal(result.repos[0]?.state, "behind");
      assert.equal(result.repos[1]?.name, "owner/missing");
      assert.equal(result.repos[1]?.state, "missing");

      const rejected = await request(socketPath, '{"v":1,"id":"rp0","method":"repos.pull","params":{"repo":"owner/not-listed"}}');
      assert.equal(rejected.ok, false);
      assert.equal((rejected.error as { code: string }).code, "NOT_ALLOWED");

      const pulled = await request(socketPath, '{"v":1,"id":"rp1","method":"repos.pull","params":{"repo":"owner/alpha"}}');
      assert.equal(pulled.ok, true);
      assert.equal((pulled.result as { status: string }).status, "updated");

      const logContent = await readFile(logPath, "utf8");
      assert.match(logContent, /repo=owner\/alpha action=api\.repos\.pull outcome=fast-forwarded/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
