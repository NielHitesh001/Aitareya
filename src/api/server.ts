import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  failure,
  maximumMessageBytes,
  protocolVersion,
  type ApiRequest,
  type ApiResponse,
  type StatusResult,
} from "./protocol.ts";

export type StatusProvider = () => Promise<StatusResult> | StatusResult;

export const defaultStatus: StatusProvider = () => ({
  state: "healthy",
  lastPollAt: null,
  allowlistedRepoCount: 0,
  pendingApprovalCount: 0,
  errorCount: 0,
});

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

async function handleLine(line: string, getStatus: StatusProvider): Promise<ApiResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return failure(null, "INVALID_JSON", "Request must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failure(null, "INVALID_REQUEST", "Request must be a JSON object.");
  }
  const candidate = parsed as Partial<ApiRequest>;
  const id = typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id : null;
  if (candidate.v !== protocolVersion) {
    return failure(id, "UNSUPPORTED_VERSION", "Unsupported protocol version.");
  }
  if (!id) return failure(null, "INVALID_REQUEST", "Request ID is required.");
  if (candidate.method !== "status") return failure(id, "UNKNOWN_METHOD", "Unsupported method.");
  if (candidate.params !== undefined && (typeof candidate.params !== "object" || candidate.params === null || Array.isArray(candidate.params) || Object.keys(candidate.params).length !== 0)) {
    return failure(id, "INVALID_PARAMS", "status does not accept parameters.");
  }
  return { v: protocolVersion, id, ok: true, result: await getStatus() };
}

export async function startApiServer(socketPath: string, getStatus: StatusProvider = defaultStatus): Promise<Server> {
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
        void handleLine(line, getStatus).then((result) => response(socket, result)).catch(() => response(socket, failure(null, "INTERNAL", "Request could not be completed.")));
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
