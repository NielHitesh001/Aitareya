import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  acceptApproval,
  ApprovalsStore,
  rejectApproval,
  type ApprovalDecisionResult,
  type ApprovalStatus,
} from "../approvals.ts";
import { isValidOwnerRepo, loadConfig } from "../config.ts";
import { assertAllowedRepo, pullRepos, statusRepos, type RepoStatusEntry } from "../github.ts";
import {
  failure,
  maximumMessageBytes,
  protocolVersion,
  type ApiRequest,
  type ApiResponse,
  type ApprovalsListResult,
  type ReposPullResult,
  type ReposStatusResult,
  type RepoSocketState,
  type StatusResult,
} from "./protocol.ts";

export type StatusProvider = () => Promise<StatusResult> | StatusResult;
export type ReposStatusProvider = () => Promise<ReposStatusResult> | ReposStatusResult;
export type ReposPullProvider = (repo: string) => Promise<ReposPullResult> | ReposPullResult;
export type ApprovalsListProvider = (status?: ApprovalStatus | "all") => Promise<ApprovalsListResult> | ApprovalsListResult;
export type ApprovalsDecisionProvider = (id: string) => Promise<ApprovalDecisionResult> | ApprovalDecisionResult;

export type ApiHandlers = {
  status?: StatusProvider;
  reposStatus?: ReposStatusProvider;
  reposPull?: ReposPullProvider;
  approvalsList?: ApprovalsListProvider;
  approvalsAccept?: ApprovalsDecisionProvider;
  approvalsReject?: ApprovalsDecisionProvider;
};

export const defaultStatus: StatusProvider = () => ({
  state: "healthy",
  lastPollAt: null,
  allowlistedRepoCount: 0,
  pendingApprovalCount: 0,
  errorCount: 0,
});

function mapSocketState(entry: RepoStatusEntry): RepoSocketState {
  if (entry.state === "missing") return "missing";
  if (entry.state === "diverged") return "diverged";
  if (entry.dirty) return "dirty";
  if (entry.state === "behind") return "behind";
  if (entry.state === "ahead") return "ahead";
  return "upToDate";
}

export function createReposStatusProvider(options: Parameters<typeof statusRepos>[0] = {}): ReposStatusProvider {
  return async () => {
    const result = await statusRepos(options);
    const repos = result.entries.map((entry) => ({
      name: entry.repo,
      path: entry.path,
      branch: entry.branch,
      state: mapSocketState(entry),
      ahead: entry.ahead,
      behind: entry.behind,
      dirty: entry.dirty,
      lastFetch: entry.lastFetch,
      prState: entry.prState,
    }));
    return {
      repos,
      counts: {
        upToDate: result.entries.filter((e) => e.state === "up_to_date").length,
        behind: result.entries.filter((e) => e.state === "behind").length,
        ahead: result.entries.filter((e) => e.state === "ahead").length,
        diverged: result.entries.filter((e) => e.state === "diverged").length,
        dirty: result.entries.filter((e) => e.dirty).length,
        missing: result.entries.filter((e) => e.state === "missing").length,
      },
      lastSuccessfulPoll: result.lastSuccessfulPoll,
    };
  };
}

export function createReposPullProvider(options: Parameters<typeof pullRepos>[0] = {}): ReposPullProvider {
  return async (repo: string) => {
    const config = await loadConfig(options.configPath);
    assertAllowedRepo(config, repo);
    const result = await pullRepos({ ...options, repos: [repo], auditAction: "api.repos.pull" });
    const outcome = result.outcomes[0];
    if (!outcome) throw new Error(`No pull outcome returned for "${repo}".`);
    return { repo: outcome.repo, status: outcome.status, line: outcome.line };
  };
}

export function createApprovalsListProvider(approvalsPath?: string): ApprovalsListProvider {
  return (status: ApprovalStatus | "all" = "pending") => {
    const store = new ApprovalsStore({ path: approvalsPath });
    try {
      const records = store.list(status);
      return {
        approvals: records.map((r) => ({
          id: r.id,
          projectName: r.projectName,
          targetFile: r.targetFile,
          createdAt: r.createdAt,
          diffText: r.diffText,
          secretScanKinds: r.secretScanKinds,
        })),
      };
    } finally {
      store.close();
    }
  };
}

export function createApprovalsAcceptProvider(
  options: Parameters<typeof acceptApproval>[1] = {},
): ApprovalsDecisionProvider {
  return (id: string) => acceptApproval(id, options);
}

export function createApprovalsRejectProvider(
  options: Parameters<typeof rejectApproval>[1] = {},
): ApprovalsDecisionProvider {
  return (id: string) => rejectApproval(id, options);
}

function response(socket: Socket, value: ApiResponse): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const info = await lstat(socketPath);
    if (!info.isSocket() || info.uid !== process.getuid?.()) throw new Error(`Refusing to replace an untrusted socket path: ${socketPath}`);
    const active = await new Promise<boolean>((resolve) => {
      const probe = createConnection(socketPath);
      probe.once("connect", () => { probe.end(); resolve(true); });
      probe.once("error", () => resolve(false));
    });
    if (active) throw new Error(`Refusing to replace a live socket: ${socketPath}`);
    await rm(socketPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function hasEmptyParams(params: unknown): boolean {
  return params === undefined || (typeof params === "object" && params !== null && !Array.isArray(params) && Object.keys(params).length === 0);
}

const VALID_APPROVAL_FILTERS = new Set(["pending", "accepted", "rejected", "stale", "all"]);

function mapApprovalError(id: string, error: unknown): ApiResponse {
  const message = error instanceof Error ? error.message : "Approval request failed.";
  if (message.includes("not found")) return failure(id, "NOT_FOUND", message);
  if (message.includes("outside") || message.includes("not in registered config.projects")) {
    return failure(id, "NOT_ALLOWED", message);
  }
  return failure(id, "APPROVAL_FAILED", message);
}

async function handleLine(line: string, handlers: Required<ApiHandlers>): Promise<ApiResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return failure(null, "INVALID_JSON", "Request must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failure(null, "INVALID_REQUEST", "Request must be a JSON object.");
  }
  const candidate = parsed as Partial<ApiRequest> & { params?: unknown };
  const id = typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id : null;
  if (candidate.v !== protocolVersion) {
    return failure(id, "UNSUPPORTED_VERSION", "Unsupported protocol version.");
  }
  if (!id) return failure(null, "INVALID_REQUEST", "Request ID is required.");

  if (candidate.method === "status") {
    if (!hasEmptyParams(candidate.params)) return failure(id, "INVALID_PARAMS", "status does not accept parameters.");
    return { v: protocolVersion, id, ok: true, result: await handlers.status() };
  }
  if (candidate.method === "repos.status") {
    if (!hasEmptyParams(candidate.params)) return failure(id, "INVALID_PARAMS", "repos.status does not accept parameters.");
    return { v: protocolVersion, id, ok: true, result: await handlers.reposStatus() };
  }
  if (candidate.method === "repos.pull") {
    const params = candidate.params as Record<string, unknown> | undefined;
    if (!params || typeof params !== "object" || Array.isArray(params) || typeof params.repo !== "string" || !isValidOwnerRepo(params.repo)) {
      return failure(id, "INVALID_PARAMS", "repos.pull requires params.repo in owner/repo format.");
    }
    try {
      return { v: protocolVersion, id, ok: true, result: await handlers.reposPull(params.repo) };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Pull failed.";
      if (message.includes("not in github.repos allowlist")) return failure(id, "NOT_ALLOWED", message);
      return failure(id, "PULL_FAILED", message);
    }
  }
  if (candidate.method === "approvals.list") {
    const params = candidate.params as Record<string, unknown> | undefined;
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
      return failure(id, "INVALID_PARAMS", "approvals.list params must be an object.");
    }
    const filter = params?.status;
    if (filter !== undefined && (typeof filter !== "string" || !VALID_APPROVAL_FILTERS.has(filter))) {
      return failure(id, "INVALID_PARAMS", "Invalid approvals.list status filter.");
    }
    return { v: protocolVersion, id, ok: true, result: await handlers.approvalsList((filter as ApprovalStatus | "all" | undefined) ?? "pending") };
  }
  if (candidate.method === "approvals.accept") {
    const params = candidate.params as Record<string, unknown> | undefined;
    if (!params || typeof params !== "object" || Array.isArray(params) || typeof params.id !== "string" || !params.id) {
      return failure(id, "INVALID_PARAMS", "approvals.accept requires params.id.");
    }
    try {
      return { v: protocolVersion, id, ok: true, result: await handlers.approvalsAccept(params.id) };
    } catch (error: unknown) {
      return mapApprovalError(id, error);
    }
  }
  if (candidate.method === "approvals.reject") {
    const params = candidate.params as Record<string, unknown> | undefined;
    if (!params || typeof params !== "object" || Array.isArray(params) || typeof params.id !== "string" || !params.id) {
      return failure(id, "INVALID_PARAMS", "approvals.reject requires params.id.");
    }
    try {
      return { v: protocolVersion, id, ok: true, result: await handlers.approvalsReject(params.id) };
    } catch (error: unknown) {
      return mapApprovalError(id, error);
    }
  }
  return failure(id, "UNKNOWN_METHOD", "Unsupported method.");
}

export async function startApiServer(
  socketPath: string,
  statusOrHandlers: StatusProvider | ApiHandlers = defaultStatus,
): Promise<Server> {
  const handlers: Required<ApiHandlers> = typeof statusOrHandlers === "function"
    ? {
        status: statusOrHandlers,
        reposStatus: createReposStatusProvider(),
        reposPull: createReposPullProvider(),
        approvalsList: createApprovalsListProvider(),
        approvalsAccept: createApprovalsAcceptProvider(),
        approvalsReject: createApprovalsRejectProvider(),
      }
    : {
        status: statusOrHandlers.status ?? defaultStatus,
        reposStatus: statusOrHandlers.reposStatus ?? createReposStatusProvider(),
        reposPull: statusOrHandlers.reposPull ?? createReposPullProvider(),
        approvalsList: statusOrHandlers.approvalsList ?? createApprovalsListProvider(),
        approvalsAccept: statusOrHandlers.approvalsAccept ?? createApprovalsAcceptProvider(),
        approvalsReject: statusOrHandlers.approvalsReject ?? createApprovalsRejectProvider(),
      };

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(socketPath);
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maximumMessageBytes && !buffer.includes("\n")) {
        response(socket, failure(null, "MESSAGE_TOO_LARGE", "Request exceeds the 64 KiB limit."));
        socket.end();
        return;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        if (Buffer.byteLength(line) > maximumMessageBytes) {
          response(socket, failure(null, "MESSAGE_TOO_LARGE", "Request exceeds the 64 KiB limit."));
          continue;
        }
        void handleLine(line, handlers).then((result) => response(socket, result)).catch(() => response(socket, failure(null, "INTERNAL", "Request could not be completed.")));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const originalUmask = process.umask(0o077);
    const restoreUmask = () => process.umask(originalUmask);
    const onError = (error: Error) => { restoreUmask(); reject(error); };
    server.once("error", onError);
    server.listen(socketPath, () => { server.off("error", onError); restoreUmask(); resolve(); });
  });
  // umask creates the socket owner-only from bind; chmod verifies the invariant.
  await chmod(socketPath, 0o600);
  return server;
}
