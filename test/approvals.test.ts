import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  acceptApproval,
  ApprovalsStore,
  enqueueRulesApprovals,
  rejectApproval,
} from "../src/approvals.ts";
import {
  createApprovalsAcceptProvider,
  createApprovalsListProvider,
  createApprovalsRejectProvider,
  startApiServer,
} from "../src/api/server.ts";
import { defaultConfig, saveConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const run = promisify(execFile);

const FORBIDDEN_APPROVAL_PATTERNS = [
  "git push",
  "git reset",
  "git stash",
  "branch -D",
  "--force",
];

function socketRequest(socketPath: string, body: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let raw = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      raw += chunk;
      if (raw.includes("\n")) {
        socket.end();
        resolve(JSON.parse(raw));
      }
    });
    socket.on("connect", () => socket.write(`${body}\n`));
  });
}

async function setupProjectFixture(opts: { ruleText?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ctx-approvals-"));
  const repoRaw = join(root, "repo");
  const ctxHome = join(root, ".ctx");
  await mkdir(join(repoRaw, "context", "decisions"), { recursive: true });
  await mkdir(ctxHome, { recursive: true });
  await run("git", ["init", "-q", repoRaw]);
  const repo = await realpath(repoRaw);

  await writeFile(join(repo, "context", "rules.md"), opts.ruleText ?? "Use strict local storage.\n");

  const configPath = join(ctxHome, "config.json");
  const storePath = join(ctxHome, "index.db");
  const approvalsPath = join(ctxHome, "approvals.db");
  const logPath = join(ctxHome, "logs", "approvals.log");
  const socketPath = join(ctxHome, "ctx.sock");

  await saveConfig({ ...defaultConfig, projects: [repo] }, configPath);

  const store = new Store({ path: storePath });
  store.upsertChunk({
    project: repo,
    path: "context/rules.md",
    content: opts.ruleText ?? "Use strict local storage.",
    startLine: 1,
    endLine: 1,
    sourceType: "rule",
    hash: "r1",
  });
  store.close();

  return { root, repo, ctxHome, configPath, storePath, approvalsPath, logPath, socketPath };
}

test("enqueue is idempotent for same diff hash and creates new item on changed diff", async () => {
  const fix = await setupProjectFixture();
  const store = new Store({ path: fix.storePath });
  const approvals = new ApprovalsStore({ path: fix.approvalsPath });

  try {
    const first = await enqueueRulesApprovals(fix.repo, store, approvals);
    assert.equal(first.length, 3);
    const second = await enqueueRulesApprovals(fix.repo, store, approvals);
    assert.equal(second.length, 3);
    assert.equal(approvals.list("pending").length, 3);
    assert.deepEqual(
      second.map((r) => r.id),
      first.map((r) => r.id),
    );

    store.upsertChunk({
      project: fix.repo,
      path: "context/rules.md",
      content: "Updated rule for new diff hash.",
      startLine: 1,
      endLine: 1,
      sourceType: "rule",
      hash: "r2",
    });
    const third = await enqueueRulesApprovals(fix.repo, store, approvals);
    assert.equal(third.length, 3);
    assert.equal(approvals.list("pending").length, 6);
  } finally {
    approvals.close();
    store.close();
  }
});

test("accept applies once, second accept is no-op, and audit line is written", async () => {
  const fix = await setupProjectFixture();
  const store = new Store({ path: fix.storePath });
  const approvals = new ApprovalsStore({ path: fix.approvalsPath });
  const queued = await enqueueRulesApprovals(fix.repo, store, approvals);
  store.close();
  approvals.close();

  const agentsApproval = queued.find((r) => r.targetFile === "AGENTS.md");
  assert.ok(agentsApproval);

  const first = await acceptApproval(agentsApproval.id, {
    approvalsPath: fix.approvalsPath,
    storePath: fix.storePath,
    configPath: fix.configPath,
    logPath: fix.logPath,
  });
  assert.equal(first.status, "accepted");

  const written = await readFile(join(fix.repo, "AGENTS.md"), "utf8");
  assert.match(written, /<!-- ctx:begin -->/);
  assert.match(written, /Use strict local storage\./);

  const second = await acceptApproval(agentsApproval.id, {
    approvalsPath: fix.approvalsPath,
    storePath: fix.storePath,
    configPath: fix.configPath,
    logPath: fix.logPath,
  });
  assert.equal(second.status, "already_decided");
  assert.equal(second.message, "already decided");

  const audit = await readFile(fix.logPath, "utf8");
  assert.match(audit, new RegExp(`id=${agentsApproval.id} action=accept outcome=accepted`));
});

test("accept with stale hash writes nothing and marks stale", async () => {
  const fix = await setupProjectFixture();
  const store = new Store({ path: fix.storePath });
  const approvals = new ApprovalsStore({ path: fix.approvalsPath });
  const queued = await enqueueRulesApprovals(fix.repo, store, approvals);
  approvals.close();

  store.upsertChunk({
    project: fix.repo,
    path: "context/rules.md",
    content: "Changed after enqueue.",
    startLine: 1,
    endLine: 1,
    sourceType: "rule",
    hash: "r-changed",
  });
  store.close();

  const target = queued.find((r) => r.targetFile === "AGENTS.md")!;
  const res = await acceptApproval(target.id, {
    approvalsPath: fix.approvalsPath,
    storePath: fix.storePath,
    configPath: fix.configPath,
    logPath: fix.logPath,
  });
  assert.equal(res.status, "stale");
  await assert.rejects(() => readFile(join(fix.repo, "AGENTS.md"), "utf8"), { code: "ENOENT" });

  const checkStore = new ApprovalsStore({ path: fix.approvalsPath });
  assert.equal(checkStore.getById(target.id)?.status, "stale");
  checkStore.close();
});

test("reject writes nothing and writes audit line", async () => {
  const fix = await setupProjectFixture();
  const store = new Store({ path: fix.storePath });
  const approvals = new ApprovalsStore({ path: fix.approvalsPath });
  const queued = await enqueueRulesApprovals(fix.repo, store, approvals);
  store.close();
  approvals.close();

  const target = queued.find((r) => r.targetFile === "CLAUDE.md")!;
  const res = await rejectApproval(target.id, {
    approvalsPath: fix.approvalsPath,
    configPath: fix.configPath,
    logPath: fix.logPath,
  });
  assert.equal(res.status, "rejected");
  await assert.rejects(() => readFile(join(fix.repo, "CLAUDE.md"), "utf8"), { code: "ENOENT" });

  const audit = await readFile(fix.logPath, "utf8");
  assert.match(audit, new RegExp(`id=${target.id} action=reject outcome=rejected`));
});

test("approvals.list scrubs secrets and accept rejects ids outside config.projects", async () => {
  const fakeSecret = "ghp_FakeApprovalSecretValue1234567890";
  const fix = await setupProjectFixture({ ruleText: `Token ${fakeSecret}\n` });
  const store = new Store({ path: fix.storePath });
  const approvals = new ApprovalsStore({ path: fix.approvalsPath });
  const queued = await enqueueRulesApprovals(fix.repo, store, approvals);
  store.close();

  const outside = approvals.enqueue({
    kind: "rules",
    projectPath: "/tmp/unregistered-project",
    targetFile: "AGENTS.md",
    diff: "--- a\n+++ b\n+test\n",
  });
  approvals.close();

  const server = await startApiServer(fix.socketPath, {
    approvalsList: createApprovalsListProvider(fix.approvalsPath),
    approvalsAccept: createApprovalsAcceptProvider({
      approvalsPath: fix.approvalsPath,
      storePath: fix.storePath,
      configPath: fix.configPath,
      logPath: fix.logPath,
    }),
    approvalsReject: createApprovalsRejectProvider({
      approvalsPath: fix.approvalsPath,
      configPath: fix.configPath,
      logPath: fix.logPath,
    }),
  });

  try {
    const listed = await socketRequest(fix.socketPath, '{"v":1,"id":"l1","method":"approvals.list","params":{}}');
    assert.equal(listed.ok, true);
    const rawJson = JSON.stringify(listed);
    assert.equal(rawJson.includes(fakeSecret), false);
    assert.match(rawJson, /\[REDACTED:github-token\]/);
    const items = (listed.result as { approvals: Array<{ id: string; secretScanKinds: string[] }> }).approvals;
    const match = items.find((item) => item.id === queued[0]?.id);
    assert.ok(match);
    assert.equal(match.secretScanKinds.includes("github-token"), true);

    const denied = await socketRequest(
      fix.socketPath,
      JSON.stringify({ v: 1, id: "a-out", method: "approvals.accept", params: { id: outside.id } }),
    );
    assert.equal(denied.ok, false);
    assert.equal((denied.error as { code: string }).code, "NOT_ALLOWED");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("approvals code contains no forbidden git or force commands", async () => {
  const src = await readFile(join(process.cwd(), "src/approvals.ts"), "utf8");
  for (const pattern of FORBIDDEN_APPROVAL_PATTERNS) {
    assert.equal(src.includes(pattern), false, `Forbidden pattern "${pattern}" found in src/approvals.ts`);
  }
});
