import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.ts";
import { allowRepo, assertAllowedRepo, denyRepo, discoverRepos } from "../src/github.ts";

const run = promisify(execFile);
const REAL_GIT = "/usr/bin/git";
const FAKE_TOKEN = "ghp_FakeAllowlistTokenValue123456";

const FORBIDDEN_MUTATIONS = [
  "push --force",
  "branch -D",
  "repo delete",
  "gh repo delete",
  "gh repo create",
  "gh repo edit",
  "gh repo rename",
  "gh repo archive",
  "gh repo transfer",
  "gh repo set-default",
];

async function withTempHome<T>(fn: (home: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ctx-gh-home-"));
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

async function createBareRemote(baseDir: string, name: string): Promise<string> {
  const workDir = join(baseDir, `${name}-seed`);
  const bareDir = join(baseDir, `${name}.git`);
  await run(REAL_GIT, ["init", "-q", "-b", "main", workDir]);
  await run(REAL_GIT, ["-C", workDir, "config", "user.name", "Test User"]);
  await run(REAL_GIT, ["-C", workDir, "config", "user.email", "test@example.com"]);
  await writeFile(join(workDir, "README.md"), `# ${name}\n`);
  await run(REAL_GIT, ["-C", workDir, "add", "README.md"]);
  await run(REAL_GIT, ["-C", workDir, "commit", "-q", "-m", "initial commit"]);
  await run(REAL_GIT, ["clone", "--bare", "-q", workDir, bareDir]);
  return bareDir;
}

async function createStubBin(opts: { bareRemote?: string; reposJson?: string; callLog?: string }): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), "ctx-gh-allowlist-bin-"));
  const ghPath = join(binDir, "gh");
  const reposJson = opts.reposJson ?? "[]";
  const callLog = opts.callLog ?? join(binDir, "calls.log");

  await writeFile(
    ghPath,
    `#!/bin/sh
echo "gh $*" >> "${callLog}"
if [ "$1" = "--version" ]; then echo "gh version 2.100.0"; exit 0; fi
if [ "$1" = "repo" ] && [ "$2" = "list" ]; then
  printf '%s\n' '${reposJson.replace(/'/g, "'\\''")}'
  exit 0
fi
exit 1
`,
  );
  await chmod(ghPath, 0o755);

  const gitPath = join(binDir, "git");
  if (opts.bareRemote) {
    await writeFile(
      gitPath,
      `#!/bin/sh
echo "git $*" >> "${callLog}"
for arg in "$@"; do
  case "$arg" in
    https://github.com/*.git)
      exec "${REAL_GIT}" -c "url.${opts.bareRemote}.insteadOf=$arg" "$@"
      ;;
  esac
done
exec "${REAL_GIT}" "$@"
`,
    );
  } else {
    await writeFile(
      gitPath,
      `#!/bin/sh
echo "git $*" >> "${callLog}"
exec "${REAL_GIT}" "$@"
`,
    );
  }
  await chmod(gitPath, 0o755);
  return binDir;
}

test("discover prints new repos, counts private repos when disallowed, and clones nothing", async () => {
  await withTempHome(async (home, root) => {
    const cloneRootDir = join(home, "code/github");
    const configPath = join(home, ".ctx/config.json");
    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/existing"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const callLog = join(root, "calls.log");
    const reposJson = JSON.stringify([
      { nameWithOwner: "owner/existing", isPrivate: false },
      { nameWithOwner: "owner/new-public", isPrivate: false },
      { nameWithOwner: "owner/new-private", isPrivate: true },
    ]);
    const binDir = await createStubBin({ reposJson, callLog });
    const env = { ...process.env, PATH: `${binDir}:${dirname(process.execPath)}` };

    const result = await discoverRepos({ configPath, env });
    assert.deepEqual(result.lines, [
      "owner/existing (allowlisted)",
      "owner/new-public (new)",
      "1 private new repository (names hidden).",
    ]);
    assert.equal(result.lines.join("\n").includes("owner/new-private"), false);

    const calls = await readFile(callLog, "utf8");
    assert.match(calls, /gh repo list --limit 1000 --json nameWithOwner/);
    assert.equal(calls.includes("git clone"), false);
    await assert.rejects(() => stat(cloneRootDir), { code: "ENOENT" });
  });
});

test("allow adds the repo, clones into temp cloneRoot via bare remote, and runs init", async () => {
  await withTempHome(async (home, root) => {
    const ctxHome = join(home, ".ctx");
    const configPath = join(ctxHome, "config.json");
    const storePath = join(ctxHome, "index.db");
    const cloneRootDir = join(home, "code/github");

    const bareRemote = await createBareRemote(root, "sample");
    const callLog = join(root, "calls.log");
    const binDir = await createStubBin({ bareRemote, callLog });
    const env = { ...process.env, PATH: `${binDir}:${dirname(process.execPath)}`, CTX_HOME: ctxHome };

    await saveConfig({ ...defaultConfig, github: { ...defaultConfig.github, cloneRoot: "~/code/github" } }, configPath);

    const result = await allowRepo("owner/sample", { configPath, storePath, home, env });
    assert.equal(result.cloned, true);
    assert.equal(result.targetDir, join(cloneRootDir, "owner", "sample"));

    await access(join(result.targetDir, ".git"));
    await access(join(result.targetDir, "context/rules.md"));
    await access(join(result.targetDir, "context/decisions"));

    const updated = await loadConfig(configPath);
    assert.deepEqual(updated.github.repos, ["owner/sample"]);
    assert.equal(updated.projects.includes(await realpath(result.targetDir)), true);

    const calls = await readFile(callLog, "utf8");
    assert.match(calls, /credential\.helper=!gh auth git-credential clone https:\/\/github\.com\/owner\/sample\.git/);
    assert.equal(calls.includes(FAKE_TOKEN), false);
  });
});

test("allow on an existing directory does not re-clone", async () => {
  await withTempHome(async (home, root) => {
    const ctxHome = join(home, ".ctx");
    const configPath = join(ctxHome, "config.json");
    const storePath = join(ctxHome, "index.db");
    const existingDir = join(home, "code/github", "owner", "sample");
    await mkdir(existingDir, { recursive: true });
    await writeFile(join(existingDir, "marker.txt"), "keep-me\n");

    const callLog = join(root, "calls.log");
    const binDir = await createStubBin({ callLog });
    const env = { ...process.env, PATH: `${binDir}:${dirname(process.execPath)}`, CTX_HOME: ctxHome };

    await saveConfig({ ...defaultConfig, github: { ...defaultConfig.github, cloneRoot: "~/code/github" } }, configPath);

    const result = await allowRepo("owner/sample", { configPath, storePath, home, env });
    assert.equal(result.cloned, false);
    assert.match(result.message, /already exists/);
    assert.equal(await readFile(join(existingDir, "marker.txt"), "utf8"), "keep-me\n");

    const calls = await readFile(callLog, "utf8").catch(() => "");
    assert.equal(calls.includes("clone"), false);
  });
});

test("deny removes the entry from github.repos and leaves the clone on disk", async () => {
  await withTempHome(async (home) => {
    const ctxHome = join(home, ".ctx");
    const configPath = join(ctxHome, "config.json");
    const clonedDir = join(home, "code/github", "owner", "sample");
    await mkdir(clonedDir, { recursive: true });
    await writeFile(join(clonedDir, "README.md"), "still here\n");

    await saveConfig(
      { ...defaultConfig, github: { ...defaultConfig.github, repos: ["owner/sample", "owner/other"], cloneRoot: "~/code/github" } },
      configPath,
    );

    const result = await denyRepo("owner/sample", { configPath });
    assert.match(result.message, /Local clone was not deleted/);

    const updated = await loadConfig(configPath);
    assert.deepEqual(updated.github.repos, ["owner/other"]);
    assert.equal(await readFile(join(clonedDir, "README.md"), "utf8"), "still here\n");
  });
});

test("invalid owner/repo format and non-allowlisted actions are rejected", async () => {
  await withTempHome(async (home) => {
    const configPath = join(home, ".ctx/config.json");
    await saveConfig({ ...defaultConfig, github: { ...defaultConfig.github, cloneRoot: "~/code/github" } }, configPath);

    await assert.rejects(() => allowRepo("bad-format", { configPath, home }), /Invalid repository format/);
    await assert.rejects(() => allowRepo("../escape", { configPath, home }), /Invalid repository format/);
    await assert.rejects(() => denyRepo("bad-format", { configPath }), /Invalid repository format/);
    await assert.rejects(() => denyRepo("owner/not-allowed", { configPath }), /not in github\.repos allowlist/);

    const cfg = await loadConfig(configPath);
    assert.throws(() => assertAllowedRepo(cfg, "owner/not-allowed"), /not in github\.repos allowlist/);
  });
});

test("allowlist source and tests contain no repo mutation commands", async () => {
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
    const content = raw.replace(/const FORBIDDEN_MUTATIONS = \[[\s\S]*?\];/g, "");
    for (const pattern of FORBIDDEN_MUTATIONS) {
      assert.equal(content.includes(pattern), false, `Forbidden pattern "${pattern}" found in ${file}`);
    }
  }
});
