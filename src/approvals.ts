import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.ts";
import { scrub } from "./scrub.ts";
import { Store } from "./store.ts";
import { syncFile } from "./sync.ts";
import { agentsMarkdown } from "./writers/agents-md.ts";
import { claudeMarkdown } from "./writers/claude-md.ts";
import { cursorRules } from "./writers/cursorrules.ts";

export const approvalsSchemaVersion = 1;

export type ApprovalStatus = "pending" | "accepted" | "rejected" | "stale";

export type ApprovalRecord = {
  id: string;
  kind: "rules";
  projectPath: string;
  projectName: string;
  targetFile: string;
  diffText: string;
  diffHash: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  secretScanKinds: string[];
};

export type ApprovalDecisionResult = {
  id: string;
  status: "accepted" | "rejected" | "stale" | "already_decided";
  message: string;
};

type ApprovalRow = {
  id: string;
  kind: "rules";
  project_path: string;
  target_file: string;
  diff_text: string;
  diff_hash: string;
  status: ApprovalStatus;
  created_at: string;
  decided_at: string | null;
  secret_scan_kinds: string;
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function rowToRecord(row: ApprovalRow): ApprovalRecord {
  let kinds: string[] = [];
  if (row.secret_scan_kinds) {
    try {
      const parsed = JSON.parse(row.secret_scan_kinds) as unknown;
      if (Array.isArray(parsed)) kinds = parsed.filter((k): k is string => typeof k === "string");
    } catch {
      kinds = [];
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    projectPath: row.project_path,
    projectName: basename(row.project_path),
    targetFile: row.target_file,
    diffText: row.diff_text,
    diffHash: row.diff_hash,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    secretScanKinds: kinds,
  };
}

export class ApprovalsStore {
  private readonly database: DatabaseSync;

  constructor(options: { path?: string } = {}) {
    const dbPath = options.path ?? process.env.CTX_APPROVALS_PATH ?? resolve(homedir(), ".ctx/approvals.db");
    this.database = new DatabaseSync(dbPath);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.initialize();
  }

  close(): void {
    this.database.close();
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('rules')),
        project_path TEXT NOT NULL,
        target_file TEXT NOT NULL,
        diff_text TEXT NOT NULL,
        diff_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','stale')),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        secret_scan_kinds TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
    `);
    const version = this.database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (!version) {
      this.database.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(String(approvalsSchemaVersion));
    } else if (Number(version.value) !== approvalsSchemaVersion) {
      throw new Error(`Incompatible approvals schema ${version.value}. Expected ${approvalsSchemaVersion}.`);
    }
  }

  enqueue(input: { kind: "rules"; projectPath: string; targetFile: string; diff: string; secretScanKinds?: string[] }): ApprovalRecord {
    const scrubbed = scrub(input.diff);
    const diffText = scrubbed.text;
    const diffHash = sha256(diffText);
    const redactedMarkers = [...diffText.matchAll(/\[REDACTED:([a-z0-9_-]+)\]/g)].map((m) => m[1]);
    const kinds = [...new Set([...(input.secretScanKinds ?? []), ...scrubbed.redactions.map((r) => r.kind), ...redactedMarkers])];

    const existing = this.database
      .prepare(
        "SELECT * FROM approvals WHERE kind = ? AND project_path = ? AND target_file = ? AND diff_hash = ? AND status = 'pending' LIMIT 1",
      )
      .get(input.kind, input.projectPath, input.targetFile, diffHash) as ApprovalRow | undefined;
    if (existing) return rowToRecord(existing);

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const kindsJson = JSON.stringify(kinds);
    this.database
      .prepare(
        "INSERT INTO approvals(id, kind, project_path, target_file, diff_text, diff_hash, status, created_at, decided_at, secret_scan_kinds) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?)",
      )
      .run(id, input.kind, input.projectPath, input.targetFile, diffText, diffHash, createdAt, kindsJson);

    return {
      id,
      kind: input.kind,
      projectPath: input.projectPath,
      projectName: basename(input.projectPath),
      targetFile: input.targetFile,
      diffText,
      diffHash,
      status: "pending",
      createdAt,
      decidedAt: null,
      secretScanKinds: kinds,
    };
  }

  getById(id: string): ApprovalRecord | null {
    const row = this.database.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(status: ApprovalStatus | "all" = "pending"): ApprovalRecord[] {
    const rows =
      status === "all"
        ? (this.database.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all() as ApprovalRow[])
        : (this.database
            .prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC")
            .all(status) as ApprovalRow[]);
    return rows.map(rowToRecord);
  }

  markStatus(id: string, status: Exclude<ApprovalStatus, "pending">): void {
    this.database
      .prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }
}

const RULES_TARGETS = [
  ["AGENTS.md", agentsMarkdown],
  ["CLAUDE.md", claudeMarkdown],
  [".cursorrules", cursorRules],
] as const;

export async function enqueueRulesApprovals(
  projectPath: string,
  store: Store,
  approvalsStore: ApprovalsStore,
): Promise<ApprovalRecord[]> {
  const created: ApprovalRecord[] = [];
  for (const [name, writer] of RULES_TARGETS) {
    const targetPath = join(projectPath, name);
    const generated = writer(store, projectPath);
    const preScanKinds = [...new Set(scrub(generated).redactions.map((r) => r.kind))];
    const result = await syncFile(targetPath, generated, { dryRun: true });
    if (result.action === "dry-run" && result.diff) {
      created.push(
        approvalsStore.enqueue({
          kind: "rules",
          projectPath,
          targetFile: name,
          diff: result.diff,
          secretScanKinds: preScanKinds,
        }),
      );
    }
  }
  return created;
}

async function appendApprovalAudit(
  logPath: string,
  id: string,
  action: "accept" | "reject",
  outcome: string,
  projectName: string,
  targetFile: string,
): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  const line = `${new Date().toISOString()} id=${id} action=${action} outcome=${outcome} project=${scrub(projectName).text} target=${scrub(targetFile).text}\n`;
  await appendFile(logPath, line, { mode: 0o600 });
}

async function resolveVerifiedTarget(
  record: ApprovalRecord,
  configPath?: string,
): Promise<{ projectPath: string; targetPath: string }> {
  const config = await loadConfig(configPath);
  const projectReal = await realpath(record.projectPath).catch(() => resolve(record.projectPath));
  if (!config.projects.includes(projectReal)) {
    throw new Error(`Project "${record.projectPath}" is not in registered config.projects.`);
  }
  const targetPath = resolve(projectReal, record.targetFile);
  const rel = relative(projectReal, targetPath);
  if (!rel || rel.startsWith("..") || rel === "..") {
    throw new Error(`Target file "${record.targetFile}" is outside project root.`);
  }
  return { projectPath: projectReal, targetPath };
}

export async function acceptApproval(
  id: string,
  options: {
    approvalsPath?: string;
    storePath?: string;
    configPath?: string;
    logPath?: string;
  } = {},
): Promise<ApprovalDecisionResult> {
  const ctxHome = process.env.CTX_HOME ?? join(homedir(), ".ctx");
  const approvalsPath = options.approvalsPath ?? process.env.CTX_APPROVALS_PATH ?? join(ctxHome, "approvals.db");
  const storePath = options.storePath ?? join(ctxHome, "index.db");
  const logPath = options.logPath ?? join(ctxHome, "logs", "approvals.log");

  const approvals = new ApprovalsStore({ path: approvalsPath });
  try {
    const record = approvals.getById(id);
    if (!record) throw new Error(`Approval "${id}" not found.`);

    const { projectPath, targetPath } = await resolveVerifiedTarget(record, options.configPath);

    if (record.status === "accepted" || record.status === "rejected") {
      return { id, status: "already_decided", message: "already decided" };
    }
    if (record.status === "stale") {
      return { id, status: "stale", message: "Approval is stale." };
    }

    const writerEntry = RULES_TARGETS.find(([name]) => name === record.targetFile);
    if (!writerEntry) {
      throw new Error(`Unsupported rules target "${record.targetFile}".`);
    }

    const store = new Store({ path: storePath });
    try {
      const generated = writerEntry[1](store, projectPath);
      const dry = await syncFile(targetPath, generated, { dryRun: true });
      const currentHash = sha256(scrub(dry.diff).text);
      if (dry.action !== "dry-run" || currentHash !== record.diffHash) {
        approvals.markStatus(id, "stale");
        await appendApprovalAudit(logPath, id, "accept", "stale", record.projectName, record.targetFile);
        return { id, status: "stale", message: "Approval is stale; diff changed since enqueue." };
      }

      const applied = await syncFile(targetPath, generated, { yes: true });
      if (applied.action !== "written") {
        throw new Error(`Expected write for "${record.targetFile}", got "${applied.action}".`);
      }

      approvals.markStatus(id, "accepted");
      await appendApprovalAudit(logPath, id, "accept", "accepted", record.projectName, record.targetFile);
      return { id, status: "accepted", message: "Applied rules update." };
    } finally {
      store.close();
    }
  } finally {
    approvals.close();
  }
}

export async function rejectApproval(
  id: string,
  options: {
    approvalsPath?: string;
    configPath?: string;
    logPath?: string;
  } = {},
): Promise<ApprovalDecisionResult> {
  const ctxHome = process.env.CTX_HOME ?? join(homedir(), ".ctx");
  const approvalsPath = options.approvalsPath ?? process.env.CTX_APPROVALS_PATH ?? join(ctxHome, "approvals.db");
  const logPath = options.logPath ?? join(ctxHome, "logs", "approvals.log");

  const approvals = new ApprovalsStore({ path: approvalsPath });
  try {
    const record = approvals.getById(id);
    if (!record) throw new Error(`Approval "${id}" not found.`);

    await resolveVerifiedTarget(record, options.configPath);

    if (record.status === "accepted" || record.status === "rejected") {
      return { id, status: "already_decided", message: "already decided" };
    }
    if (record.status === "stale") {
      return { id, status: "stale", message: "Approval is stale." };
    }

    approvals.markStatus(id, "rejected");
    await appendApprovalAudit(logPath, id, "reject", "rejected", record.projectName, record.targetFile);
    return { id, status: "rejected", message: "Rejected rules update." };
  } finally {
    approvals.close();
  }
}
