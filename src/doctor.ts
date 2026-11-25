import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadConfig, type CtxConfig } from "./config.ts";

export type DoctorReport = {
  config: { valid: boolean; allowlistedRepoCount?: number; issue?: string };
  socket: { path: string; state: "missing" | "secure" | "unsafe" };
  githubToken: "keychain-only";
  pushMode: "pr";
};

export async function doctor(
  configLoader: () => Promise<CtxConfig> = loadConfig,
  socketPath = process.env.CTX_SOCKET_PATH ?? resolve(homedir(), ".ctx/ctx.sock"),
): Promise<DoctorReport> {
  let config: DoctorReport["config"];
  try { config = { valid: true, allowlistedRepoCount: (await configLoader()).allowlist.length }; }
  catch (error) { config = { valid: false, issue: error instanceof Error ? error.message : "Invalid configuration." }; }
  let socket: DoctorReport["socket"] = { path: socketPath, state: "missing" };
  try {
    const info = await lstat(socketPath);
    socket.state = info.isSocket() && (info.mode & 0o777) === 0o600 && info.uid === process.getuid?.() ? "secure" : "unsafe";
  } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") socket.state = "unsafe"; }
  return { config, socket, githubToken: "keychain-only", pushMode: "pr" };
}
