import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { defaultConfig, saveConfig } from "../src/config.ts";
import { pullRepos } from "../src/github.ts";

const run = promisify(execFile);
const REAL_GIT = "/usr/bin/git";

const FORBIDDEN_PULL_PATTERNS = [
  "git reset --hard",
  "git pull",
  "git rebase",
  "git stash",
  "git push",
  "branch -D",
];

async function withTempHome<T>(fn: (home: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ctx-pull-"));
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

  return { bareDir, seedDir, cloneDir };
}

async function pushRemoteCommit(seedDir: string, bareDir: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(join(seedDir, file), content);
  await git(seedDir, "add", file);
  await git(seedDir, "commit", "-q", "-m", message);
  const sha = await git(seedDir, "rev-parse", "HEAD");
  await run(REAL_GIT, ["--git-dir", bareDir, "fetch", "-q", seedDir, "refs/heads/main:refs/heads/main"]);
  return sha;
}

test("behind by one commit: pull fast-forwards and new SHA matches origin", async () => {
  await withTempHome(async (home, root) => {
    const { bareDir, seedDir, cloneDir } = await setupBareAndClone(home, root, "owner", "alpha");
    const remoteSha = await pushRemoteCommit(seedDir, bareDir, "README.md", "v2\n", "remote update");
    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/alpha"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const res = await pullRepos({ configPath, home, logPath });
    assert.equal(res.outcomes[0]?.status, "updated");
    assert.match(res.outcomes[0]?.line ?? "", /fast-forwarded/);
    assert.equal(await git(cloneDir, "rev-parse", "HEAD"), remoteSha);
    assert.equal(await readFile(join(cloneDir, "README.md"), "utf8"), "v2\n");
    const log = await readFile(logPath, "utf8");
    assert.match(log, /repo=owner\/alpha action=pull outcome=fast-forwarded/);
  });
});

test("up to date: reports up to date with no change", async () => {
  await withTempHome(async (home, root) => {
    const { cloneDir } = await setupBareAndClone(home, root, "owner", "beta");
    const beforeSha = await git(cloneDir, "rev-parse", "HEAD");
    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/beta"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const res = await pullRepos({ configPath, home, logPath });
    assert.equal(res.outcomes[0]?.status, "up_to_date");
    assert.equal(res.outcomes[0]?.line, "owner/beta: up to date");
    assert.equal(await git(cloneDir, "rev-parse", "HEAD"), beforeSha);
  });
});

test("dirty tracked file: skipped and file content unchanged", async () => {
  await withTempHome(async (home, root) => {
    const { bareDir, seedDir, cloneDir } = await setupBareAndClone(home, root, "owner", "gamma");
    await pushRemoteCommit(seedDir, bareDir, "other.txt", "remote\n", "remote commit");
    await writeFile(join(cloneDir, "README.md"), "local-edit\n");

    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/gamma"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const res = await pullRepos({ configPath, home, logPath });
    assert.equal(res.outcomes[0]?.status, "skipped");
    assert.equal(res.outcomes[0]?.line, "owner/gamma: dirty, skipped");
    assert.equal(await readFile(join(cloneDir, "README.md"), "utf8"), "local-edit\n");
  });
});

test("untracked non-.DS_Store file: skipped", async () => {
  await withTempHome(async (home, root) => {
    const { cloneDir } = await setupBareAndClone(home, root, "owner", "delta");
    await writeFile(join(cloneDir, "scratch.txt"), "untracked\n");

    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/delta"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const res = await pullRepos({ configPath, home, logPath });
    assert.equal(res.outcomes[0]?.status, "skipped");
    assert.equal(res.outcomes[0]?.line, "owner/delta: dirty, skipped");
  });
});

test("untracked .DS_Store only: not treated as dirty", async () => {
  await withTempHome(async (home, root) => {
    const { bareDir, seedDir, cloneDir } = await setupBareAndClone(home, root, "owner", "epsilon");
    const remoteSha = await pushRemoteCommit(seedDir, bareDir, "README.md", "v2\n", "remote update");
    await writeFile(join(cloneDir, ".DS_Store"), "finder\n");
    await mkdir(join(cloneDir, "sub dir"), { recursive: true });
    await writeFile(join(cloneDir, "sub dir/.DS_Store"), "finder-sub\n");

    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/epsilon"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const res = await pullRepos({ configPath, home, logPath });
    assert.equal(res.outcomes[0]?.status, "updated");
    assert.equal(await git(cloneDir, "rev-parse", "HEAD"), remoteSha);
  });
});

test("diverged: both sides have a commit; pull changes nothing and reports diverged", async () => {
  await withTempHome(async (home, root) => {
    const { bareDir, seedDir, cloneDir } = await setupBareAndClone(home, root, "owner", "zeta");
    await pushRemoteCommit(seedDir, bareDir, "remote.txt", "remote\n", "remote commit");

    await writeFile(join(cloneDir, "local.txt"), "local\n");
    await git(cloneDir, "add", "local.txt");
    await git(cloneDir, "commit", "-q", "-m", "local commit");
    const localSha = await git(cloneDir, "rev-parse", "HEAD");

    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/zeta"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const res = await pullRepos({ configPath, home, logPath });
    assert.equal(res.outcomes[0]?.status, "diverged");
    assert.equal(res.outcomes[0]?.line, "owner/zeta: diverged");
    assert.equal(await git(cloneDir, "rev-parse", "HEAD"), localSha);
  });
});

test("missing directory: reported and skipped, nothing created", async () => {
  await withTempHome(async (home) => {
    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/missing"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const res = await pullRepos({ configPath, home, logPath });
    assert.equal(res.outcomes[0]?.status, "skipped");
    assert.equal(res.outcomes[0]?.line, "owner/missing: missing, skipped");
    await assert.rejects(() => stat(join(home, "code/github/owner/missing")), { code: "ENOENT" });
  });
});

test("off-default branch: skipped and branch unchanged", async () => {
  await withTempHome(async (home, root) => {
    const { cloneDir } = await setupBareAndClone(home, root, "owner", "eta");
    await git(cloneDir, "checkout", "-q", "-b", "feature/work");

    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/eta"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const res = await pullRepos({ configPath, home, logPath });
    assert.equal(res.outcomes[0]?.status, "skipped");
    assert.match(res.outcomes[0]?.line ?? "", /off-default branch \(feature\/work\), skipped/);
    assert.equal(await git(cloneDir, "symbolic-ref", "--short", "HEAD"), "feature/work");
  });
});

test("network failure backs off and retries once before continuing", async () => {
  await withTempHome(async (home, root) => {
    const { cloneDir } = await setupBareAndClone(home, root, "owner", "theta");
    const binDir = await mkdtemp(join(tmpdir(), "ctx-pull-retry-bin-"));
    const flagFile = join(root, "fetch-failed-once");
    const gitWrapper = join(binDir, "git");
    await writeFile(
      gitWrapper,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "fetch" ]; then
    if [ ! -f "${flagFile}" ]; then
      : > "${flagFile}"
      echo "fatal: 429 too many requests" >&2
      exit 1
    fi
  fi
done
exec "${REAL_GIT}" "$@"
`,
    );
    await chmod(gitWrapper, 0o755);

    const configPath = join(home, ".ctx/config.json");
    const logPath = join(home, ".ctx/logs/github.log");
    await saveConfig(
      {
        ...defaultConfig,
        github: { ...defaultConfig.github, repos: ["owner/theta"], cloneRoot: "~/code/github", rateLimitBackoffSeconds: 42 },
      },
      configPath,
    );

    const slept: number[] = [];
    const env = { ...process.env, PATH: `${binDir}:${dirname(process.execPath)}` };
    const res = await pullRepos({
      configPath,
      home,
      logPath,
      env,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    assert.deepEqual(slept, [42_000]);
    assert.equal(res.outcomes[0]?.status, "up_to_date");
    assert.equal(await git(cloneDir, "symbolic-ref", "--short", "HEAD"), "main");
  });
});

test("source and tests contain no forbidden pull/reset/rebase/stash/push commands", async () => {
  async function collect(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".build") continue;
        files.push(...await collect(full));
      } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
        files.push(full);
      }
    }
    return files;
  }

  const files = [
    ...await collect(join(process.cwd(), "src")),
    ...await collect(join(process.cwd(), "scripts")),
    ...await collect(join(process.cwd(), "test")),
  ];

  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const content = raw.replace(/const FORBIDDEN_[A-Z_]+ = \[[\s\S]*?\];/g, "");
    for (const pattern of FORBIDDEN_PULL_PATTERNS) {
      assert.equal(content.includes(pattern), false, `Forbidden pattern "${pattern}" found in ${file}`);
    }
  }
});
