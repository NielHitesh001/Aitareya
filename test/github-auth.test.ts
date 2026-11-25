import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { defaultConfig } from "../src/config.ts";
import { doctor } from "../src/doctor.ts";

const run = promisify(execFile);
const cli = join(process.cwd(), "src/cli.ts");
const FAKE_TOKEN = "ghp_FakeTestTokenValueDoNotExpose123456";

async function makeStubBin(scriptBody: string, includeGit = true): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), "ctx-gh-stub-"));
  const ghPath = join(binDir, "gh");
  await writeFile(ghPath, `#!/bin/sh\n${scriptBody}\n`);
  await chmod(ghPath, 0o755);
  if (includeGit) {
    const gitPath = join(binDir, "git");
    await writeFile(gitPath, "#!/bin/sh\necho 'git version 2.40.0'\n");
    await chmod(gitPath, 0o755);
  }
  return binDir;
}

function envWithPath(binDir: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: binDir };
}

test("doctor reports gh not installed", async () => {
  const emptyBin = await mkdtemp(join(tmpdir(), "ctx-no-gh-"));
  const gitPath = join(emptyBin, "git");
  await writeFile(gitPath, "#!/bin/sh\necho 'git version 2.40.0'\n");
  await chmod(gitPath, 0o755);

  const report = await doctor(async () => defaultConfig, "/path/that/does/not/exist", { env: envWithPath(emptyBin) });
  assert.equal(report.git.status, "pass");
  assert.equal(report.github.ghInstalled, "fail");
  assert.equal(report.github.authenticated, "fail");
  assert.equal(report.github.scopes.status, "fail");
});

test("doctor reports gh not authenticated", async () => {
  const binDir = await makeStubBin(`
if [ "$1" = "--version" ]; then echo "gh version 2.100.0"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo "You are not logged into any GitHub hosts." >&2; exit 1; fi
exit 1
`);
  const report = await doctor(async () => defaultConfig, "/path/that/does/not/exist", { env: envWithPath(binDir) });
  assert.equal(report.github.ghInstalled, "pass");
  assert.equal(report.github.authenticated, "fail");
  assert.equal(report.github.scopes.status, "fail");
  assert.equal(JSON.stringify(report).includes(FAKE_TOKEN), false);
});

test("doctor warns on broad scopes and never exposes token", async () => {
  const binDir = await makeStubBin(`
if [ "$1" = "--version" ]; then echo "gh version 2.100.0"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo "github.com"
  echo "  - Token: ${FAKE_TOKEN}"
  echo "  - Token scopes: 'repo', 'admin:org', 'delete_repo'"
  exit 0
fi
exit 1
`);
  const report = await doctor(async () => defaultConfig, "/path/that/does/not/exist", { env: envWithPath(binDir) });
  assert.equal(report.github.ghInstalled, "pass");
  assert.equal(report.github.authenticated, "pass");
  assert.equal(report.github.scopes.status, "warn");
  assert.deepEqual(report.github.scopes.broad, ["admin:org", "delete_repo"]);
  assert.equal(report.github.scopes.writeAccess, true);
  assert.equal(JSON.stringify(report).includes(FAKE_TOKEN), false);
});

test("doctor passes on documented scopes and never exposes token", async () => {
  const binDir = await makeStubBin(`
if [ "$1" = "--version" ]; then echo "gh version 2.100.0"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo "github.com"
  echo "  - Token: ${FAKE_TOKEN}"
  echo "  - Token scopes: 'repo'"
  exit 0
fi
exit 1
`);
  const report = await doctor(async () => defaultConfig, "/path/that/does/not/exist", { env: envWithPath(binDir) });
  assert.equal(report.github.ghInstalled, "pass");
  assert.equal(report.github.authenticated, "pass");
  assert.equal(report.github.scopes.status, "pass");
  assert.deepEqual(report.github.scopes.names, ["repo"]);
  assert.equal(report.github.scopes.writeAccess, true);
  assert.equal(JSON.stringify(report).includes(FAKE_TOKEN), false);
});

test("doctor warns on classic extra scopes admin:public_key, gist, and read:org", async () => {
  const binDir = await makeStubBin(`
if [ "$1" = "--version" ]; then echo "gh version 2.100.0"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo "github.com"
  echo "  - Token: ${FAKE_TOKEN}"
  echo "  - Token scopes: 'repo', 'admin:public_key', 'gist', 'read:org'"
  exit 0
fi
exit 1
`);
  const report = await doctor(async () => defaultConfig, "/path/that/does/not/exist", { env: envWithPath(binDir) });
  assert.equal(report.github.ghInstalled, "pass");
  assert.equal(report.github.authenticated, "pass");
  assert.equal(report.github.scopes.status, "warn");
  assert.deepEqual(report.github.scopes.broad, ["admin:public_key", "gist", "read:org"]);
  assert.match(report.github.scopes.message ?? "", /admin:public_key, gist, read:org/);
  assert.equal(report.github.scopes.writeAccess, true);
  assert.equal(JSON.stringify(report).includes(FAKE_TOKEN), false);
});

test("doctor warns when token lacks write access", async () => {
  const binDir = await makeStubBin(`
if [ "$1" = "--version" ]; then echo "gh version 2.100.0"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo "  - Token scopes: 'metadata:read'"
  exit 0
fi
exit 1
`);
  const report = await doctor(async () => defaultConfig, "/path/that/does/not/exist", { env: envWithPath(binDir) });
  assert.equal(report.github.scopes.status, "warn");
  assert.equal(report.github.scopes.writeAccess, false);
  assert.match(report.github.scopes.message ?? "", /pushes will be skipped\. Reads continue\./);
});

test("ctx github login runs gh auth login --scopes repo only if auth status fails", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "ctx-gh-login-state-"));
  const logFile = join(stateDir, "calls.log");
  const authedFlag = join(stateDir, "authed");

  const binDir = await makeStubBin(`
echo "$@" >> "${logFile}"
if [ "$1" = "--version" ]; then echo "gh version 2.100.0"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -f "${authedFlag}" ]; then
    echo "Token: ${FAKE_TOKEN}"
    echo "Token scopes: 'repo'"
    exit 0
  fi
  exit 1
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  : > "${authedFlag}"
  echo "Logged in with ${FAKE_TOKEN}"
  exit 0
fi
exit 1
`);

  const env = { ...process.env, PATH: `${binDir}:${dirname(process.execPath)}` };
  const first = await run(process.execPath, [cli, "github", "login"], { env });
  assert.equal(first.stdout.includes(FAKE_TOKEN), false);
  assert.equal(first.stderr.includes(FAKE_TOKEN), false);
  assert.match(first.stdout, /GitHub authentication verified \(scopes: repo\)/);

  const second = await run(process.execPath, [cli, "github", "login"], { env });
  assert.equal(second.stdout.includes(FAKE_TOKEN), false);
  assert.equal(second.stderr.includes(FAKE_TOKEN), false);

  const calls = (await readFile(logFile, "utf8")).trim().split("\n");
  const loginCalls = calls.filter((line) => line.startsWith("auth login"));
  assert.deepEqual(loginCalls, ["auth login --scopes repo"]);
});

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

test("source and tests contain no repo mutation commands", async () => {
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
