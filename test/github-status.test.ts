import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { defaultConfig, saveConfig } from "../src/config.ts";
import { statusRepos } from "../src/github.ts";

const run = promisify(execFile);
const REAL_GIT = "/usr/bin/git";
const FAKE_TOKEN = "ghp_FakeStatusTokenValue123456";

async function withTempHome<T>(fn: (home: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ctx-status-"));
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

async function setupBareAndClone(home: string, root: string, owner: string, repo: string) {
  const bareDir = join(root, `${repo}-origin.git`);
  const seedDir = join(root, `${repo}-seed`);
  const cloneDir = join(home, "code/github", owner, repo);

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
  await git(cloneDir, "fetch", "-q", "origin");

  return { bareDir, seedDir, cloneDir };
}

async function advanceBareAndFetch(seedDir: string, bareDir: string, cloneDir: string, count: number) {
  for (let i = 1; i <= count; i += 1) {
    await writeFile(join(seedDir, `remote-${i}.txt`), `remote ${i}\n`);
    await git(seedDir, "add", `remote-${i}.txt`);
    await git(seedDir, "commit", "-q", "-m", `remote ${i}`);
  }
  await run(REAL_GIT, ["--git-dir", bareDir, "fetch", "-q", seedDir, "refs/heads/main:refs/heads/main"]);
  await git(cloneDir, "fetch", "-q", "origin");
}

async function createStubBin(opts: { prJson?: string; ghFail?: boolean; callLog?: string } = {}): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), "ctx-status-bin-"));
  const ghPath = join(binDir, "gh");
  const callLog = opts.callLog ?? join(binDir, "calls.log");
  const prJson = (opts.prJson ?? "[]").replace(/'/g, "'\\''");

  await writeFile(
    ghPath,
    `#!/bin/sh
echo "gh $*" >> "${callLog}"
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  ${opts.ghFail ? "exit 1" : `printf '%s\\n' '${prJson}'\n  exit 0`}
fi
exit 1
`,
  );
  await chmod(ghPath, 0o755);

  const gitPath = join(binDir, "git");
  await writeFile(
    gitPath,
    `#!/bin/sh
echo "git $*" >> "${callLog}"
exec "${REAL_GIT}" "$@"
`,
  );
  await chmod(gitPath, 0o755);
  return binDir;
}

async function snapshotGitMetadata(repoDir: string): Promise<Map<string, Buffer>> {
  const snap = new Map<string, Buffer>();
  const gitDir = join(repoDir, ".git");
  snap.set("HEAD", await readFile(join(gitDir, "HEAD")));
  snap.set("index", await readFile(join(gitDir, "index")));
  async function walkRefs(dir: string, prefix: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walkRefs(full, rel);
      else snap.set(rel, await readFile(full));
    }
  }
  await walkRefs(join(gitDir, "refs"), "refs");
  return snap;
}

test("clean and up to date repo is reported up to date, shows PR and last poll, and is byte-identical", async () => {
  await withTempHome(async (home, root) => {
    const { cloneDir } = await setupBareAndClone(home, root, "owner", "alpha");
    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(logPath, "2026-11-25T10:00:00.000Z repo=all action=pull outcome=ok\n");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/alpha"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const callLog = join(root, "calls.log");
    const prJson = JSON.stringify([{ number: 7, title: `ctx: shared context update`, url: "https://github.com/owner/alpha/pull/7" }]);
    const binDir = await createStubBin({ prJson, callLog });
    const env = { ...process.env, PATH: `${binDir}:${dirname(process.execPath)}` };

    const before = await snapshotGitMetadata(cloneDir);
    const res = await statusRepos({ configPath, home, logPath, env });
    const after = await snapshotGitMetadata(cloneDir);

    assert.equal(res.entries[0]?.state, "up_to_date");
    assert.equal(res.entries[0]?.dirty, false);
    assert.equal(res.lastSuccessfulPoll, "2026-11-25T10:00:00.000Z");
    assert.match(res.entries[0]?.line ?? "", /up to date \[clean\]/);
    assert.match(res.entries[0]?.line ?? "", /PR #7 ctx: shared context update/);
    assert.match(res.summary, /1 up to date, 0 behind, 0 ahead, 0 diverged, 0 dirty, 0 missing/);

    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [k, buf] of before) {
      assert.equal(after.get(k)?.equals(buf), true, `Expected ${k} to be byte-identical`);
    }
    const calls = await readFile(callLog, "utf8");
    assert.equal(calls.includes(FAKE_TOKEN), false);
    assert.match(calls, /gh pr list --head ctx\/auto-update --state open --json url,number,title/);
  });
});

test("behind repo reports behind count without modifying repo", async () => {
  await withTempHome(async (home, root) => {
    const { bareDir, seedDir, cloneDir } = await setupBareAndClone(home, root, "owner", "beta");
    await advanceBareAndFetch(seedDir, bareDir, cloneDir, 2);
    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/beta"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const binDir = await createStubBin({ ghFail: true });
    const env = { ...process.env, PATH: `${binDir}:${dirname(process.execPath)}` };
    const before = await snapshotGitMetadata(cloneDir);
    const res = await statusRepos({ configPath, home, logPath, env });
    const after = await snapshotGitMetadata(cloneDir);

    assert.equal(res.entries[0]?.state, "behind");
    assert.equal(res.entries[0]?.behind, 2);
    assert.equal(res.entries[0]?.pr, "PR unknown");
    assert.match(res.entries[0]?.line ?? "", /behind 2 .* PR unknown/);
    for (const [k, buf] of before) assert.equal(after.get(k)?.equals(buf), true);
  });
});

test("ahead repo reports ahead count", async () => {
  await withTempHome(async (home, root) => {
    const { cloneDir } = await setupBareAndClone(home, root, "owner", "gamma");
    await writeFile(join(cloneDir, "local.txt"), "ahead\n");
    await git(cloneDir, "add", "local.txt");
    await git(cloneDir, "commit", "-q", "-m", "local 1");

    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/gamma"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const binDir = await createStubBin();
    const env = { ...process.env, PATH: `${binDir}:${dirname(process.execPath)}` };
    const res = await statusRepos({ configPath, home, logPath, env });

    assert.equal(res.entries[0]?.state, "ahead");
    assert.equal(res.entries[0]?.ahead, 1);
    assert.match(res.summary, /0 up to date, 0 behind, 1 ahead, 0 diverged, 0 dirty, 0 missing/);
  });
});

test("diverged repo reports diverged", async () => {
  await withTempHome(async (home, root) => {
    const { bareDir, seedDir, cloneDir } = await setupBareAndClone(home, root, "owner", "delta");
    await advanceBareAndFetch(seedDir, bareDir, cloneDir, 1);
    await writeFile(join(cloneDir, "local.txt"), "local\n");
    await git(cloneDir, "add", "local.txt");
    await git(cloneDir, "commit", "-q", "-m", "local commit");

    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/delta"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const binDir = await createStubBin();
    const env = { ...process.env, PATH: `${binDir}:${dirname(process.execPath)}` };
    const res = await statusRepos({ configPath, home, logPath, env });

    assert.equal(res.entries[0]?.state, "diverged");
    assert.equal(res.entries[0]?.ahead, 1);
    assert.equal(res.entries[0]?.behind, 1);
    assert.match(res.summary, /0 up to date, 0 behind, 0 ahead, 1 diverged, 0 dirty, 0 missing/);
  });
});

test("dirty tracked and untracked non-.DS_Store files report dirty, while untracked .DS_Store only is clean", async () => {
  await withTempHome(async (home, root) => {
    const { cloneDir: trackedDirty } = await setupBareAndClone(home, root, "owner", "tracked");
    await writeFile(join(trackedDirty, "README.md"), "modified\n");

    const { cloneDir: untrackedDirty } = await setupBareAndClone(home, root, "owner", "untracked");
    await writeFile(join(untrackedDirty, "extra.txt"), "new\n");

    const { cloneDir: dsOnly } = await setupBareAndClone(home, root, "owner", "dsonly");
    await writeFile(join(dsOnly, ".DS_Store"), "finder\n");
    await mkdir(join(dsOnly, "nested dir"), { recursive: true });
    await writeFile(join(dsOnly, "nested dir/.DS_Store"), "finder\n");

    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      {
        ...defaultConfig,
        github: { ...defaultConfig.github, repos: ["owner/tracked", "owner/untracked", "owner/dsonly"], cloneRoot: "~/code/github" },
      },
      configPath,
    );

    const binDir = await createStubBin();
    const env = { ...process.env, PATH: `${binDir}:${dirname(process.execPath)}` };
    const res = await statusRepos({ configPath, home, logPath, env });

    assert.equal(res.entries[0]?.dirty, true);
    assert.equal(res.entries[1]?.dirty, true);
    assert.equal(res.entries[2]?.dirty, false);
    assert.match(res.summary, /3 up to date, 0 behind, 0 ahead, 0 diverged, 2 dirty, 0 missing/);
  });
});

test("missing directory is reported missing on disk without creating it", async () => {
  await withTempHome(async (home) => {
    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/missing"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const res = await statusRepos({ configPath, home, logPath });
    assert.equal(res.entries[0]?.state, "missing");
    assert.equal(res.entries[0]?.line, "owner/missing: missing on disk");
    await assert.rejects(() => stat(join(home, "code/github/owner/missing")), { code: "ENOENT" });
  });
});

test("status invokes no mutating git subcommands and source is clean", async () => {
  await withTempHome(async (home, root) => {
    await setupBareAndClone(home, root, "owner", "readonly");
    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/readonly"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const callLog = join(root, "calls.log");
    const binDir = await createStubBin({ callLog });
    const env = { ...process.env, PATH: `${binDir}:${dirname(process.execPath)}` };
    await statusRepos({ configPath, home, logPath, env });

    const calls = await readFile(callLog, "utf8");
    const forbiddenSubcommands = ["fetch", "pull", "merge", "checkout", "push", "reset", "stash"];
    for (const line of calls.split(/\r?\n/).filter(Boolean)) {
      if (!line.startsWith("git ")) continue;
      for (const sub of forbiddenSubcommands) {
        assert.equal(new RegExp(`\\b${sub}\\b`).test(line), false, `status invoked forbidden git subcommand "${sub}": ${line}`);
      }
    }

    const githubSrc = await readFile(join(process.cwd(), "src/github.ts"), "utf8");
    const statusBody = githubSrc.slice(githubSrc.indexOf("export async function statusRepos"));
    for (const sub of forbiddenSubcommands) {
      assert.equal(new RegExp(`["']${sub}["']`).test(statusBody), false, `statusRepos references forbidden git command "${sub}"`);
    }
  });
});
