import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const labels = { watch: "sh.ctx.watch", api: "sh.ctx.api" } as const;
type Kind = keyof typeof labels;
export type DaemonOptions = { ctxHome?: string; launchAgents?: string; binaryPath?: string; nodePath?: string; home?: string; execute?: (file: string, args: string[]) => Promise<unknown> };
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function plist(label: string, args: string[], environment: Record<string, string>, log: string): string {
  const array = (values: string[]) => values.map((value) => `<string>${escape(value)}</string>`).join("");
  const env = Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${escape(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${array(args)}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict>${env}</dict><key>StandardOutPath</key><string>${escape(log)}</string><key>StandardErrorPath</key><string>${escape(log)}</string></dict></plist>`;
}
function paths(options: DaemonOptions) { const home = options.home ?? homedir(); const ctxHome = resolve(options.ctxHome ?? process.env.CTX_HOME ?? join(home, ".ctx")); return { home, ctxHome, agents: resolve(options.launchAgents ?? process.env.CTX_LAUNCH_AGENTS ?? join(home, "Library/LaunchAgents")), binary: resolve(options.binaryPath ?? process.env.CTX_BIN ?? fileURLToPath(new URL("../bin/ctx", import.meta.url))), node: resolve(options.nodePath ?? "/opt/homebrew/bin/node") }; }
async function execute(options: DaemonOptions, args: string[]) { return (options.execute ?? ((file, params) => run(file, params)))("launchctl", args); }
export function agentPaths(options: DaemonOptions = {}): Record<Kind, string> { const { agents } = paths(options); return { watch: join(agents, `${labels.watch}.plist`), api: join(agents, `${labels.api}.plist`) }; }
export function renderedPlists(options: DaemonOptions = {}): Record<Kind, string> { const { home, ctxHome, binary, node } = paths(options); const environment = { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, CTX_HOME: ctxHome }; const log = join(ctxHome, "logs/daemon.log"); return { watch: plist(labels.watch, [node, binary, "watch"], environment, log), api: plist(labels.api, [node, binary, "api", "serve"], environment, log) }; }
export async function installDaemon(options: DaemonOptions = {}): Promise<string[]> { const requestedBinary = options.binaryPath ?? process.env.CTX_BIN ?? process.argv[1]; const { ctxHome, agents, binary } = paths(options); if (!requestedBinary.startsWith("/")) throw new Error(`ctx binary must be an existing absolute path: ${requestedBinary}`); try { await access(binary); } catch { throw new Error(`ctx binary must be an existing absolute path: ${binary}`); } await mkdir(agents, { recursive: true }); await mkdir(join(ctxHome, "logs"), { recursive: true, mode: 0o700 }); const files = agentPaths(options); const contents = renderedPlists(options); const domain = `gui/${process.getuid?.() ?? 0}`; for (const kind of Object.keys(labels) as Kind[]) { await writeFile(files[kind], contents[kind], { mode: 0o644 }); await chmod(files[kind], 0o644); try { await execute(options, ["bootout", `${domain}/${labels[kind]}`]); } catch { /* not loaded yet */ } await execute(options, ["bootstrap", domain, files[kind]]); } return Object.values(files); }
export async function uninstallDaemon(options: DaemonOptions = {}): Promise<string[]> { const files = agentPaths(options); const domain = `gui/${process.getuid?.() ?? 0}`; for (const kind of Object.keys(labels) as Kind[]) { try { await execute(options, ["bootout", `${domain}/${labels[kind]}`]); } catch { /* already unloaded */ } await rm(files[kind], { force: true }); } return Object.values(files); }
