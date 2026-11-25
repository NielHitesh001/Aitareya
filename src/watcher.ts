import { watch, type FSWatcher } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { scanRepository, type ScanResult } from "./scanner.ts";
import type { Store } from "./store.ts";

const ignored = new Set([".git", "node_modules", "dist", "build", "target", ".venv"]);
export type WatchOptions = { projects: readonly string[]; ctxHome: string; store: Store; debounceMs?: number; autoSync?: boolean; yes?: boolean; scan?: typeof scanRepository; sync?: (project: string) => Promise<void>; enqueuePendingSync?: (project: string) => Promise<void>; log?: (message: string) => void; projectProvider?: () => Promise<readonly string[]>; refreshMs?: number };
export type WatchService = { close: () => Promise<void> };

function shouldIgnore(project: string, path: string, ctxHome: string, gitIgnored: ReadonlySet<string>): boolean {
  const absolute = resolve(project, path); if (absolute.startsWith(resolve(ctxHome))) return true;
  const relativePath = relative(project, absolute); return gitIgnored.has(relativePath) || relativePath.split("/").some((part) => ignored.has(part));
}

export async function watchProjects(options: WatchOptions): Promise<WatchService> {
  const debounce = options.debounceMs ?? 500; const timers = new Map<string, NodeJS.Timeout>(); const watchers = new Map<string, FSWatcher>();
  const scanner = options.scan ?? scanRepository;
  const flush = async (project: string) => { timers.delete(project); try { const result = await scanner(project, { store: options.store, log: options.log }); options.log?.(`${project}: scanned ${result.indexed.length}`); if (options.autoSync && options.yes) await options.sync?.(project); else if (options.autoSync) options.log?.(`${project}: pending sync`); else await options.enqueuePendingSync?.(project); } catch (error) { options.log?.(`${project}: ${error instanceof Error ? error.name : "ScanError"}`); } };
  const start = async (project: string) => {
    try { if (!(await lstat(project)).isDirectory()) throw new Error("missing"); let gitIgnored = new Set<string>(); try { gitIgnored = new Set((await readFile(resolve(project, ".gitignore"), "utf8")).split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))); } catch { /* no ignore file */ } const watcher = watch(project, { recursive: true }, (_event, name) => { const path = String(name ?? ""); if (shouldIgnore(project, path, options.ctxHome, gitIgnored)) return; const active = timers.get(project); if (active) clearTimeout(active); timers.set(project, setTimeout(() => void flush(project), debounce)); }); watchers.set(project, watcher); }
    catch { options.log?.(`${project}: stopped watching`); }
  };
  for (const project of options.projects) await start(project);
  const refresher = options.projectProvider ? setInterval(() => void options.projectProvider!().then(async (projects) => { const active = new Set(projects); for (const [project, watcher] of watchers) if (!active.has(project)) { watcher.close(); watchers.delete(project); options.log?.(`${project}: stopped watching`); } for (const project of active) if (!watchers.has(project)) await start(project); }), options.refreshMs ?? 1000) : undefined;
  return { close: async () => { if (refresher) clearInterval(refresher); for (const watcher of watchers.values()) watcher.close(); const pending = [...timers.entries()]; for (const [, timer] of pending) clearTimeout(timer); await Promise.all(pending.map(([project]) => flush(project))); } };
}
