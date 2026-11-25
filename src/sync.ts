import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { scrub } from "./scrub.ts";

const begin = "<!-- ctx:begin -->"; const end = "<!-- ctx:end -->";
export type SyncOptions = { dryRun?: boolean; yes?: boolean; confirm?: () => Promise<boolean>; log?: (message: string) => void; writeFile?: typeof writeFile; rename?: typeof rename };
export type SyncResult = { action: "unchanged" | "dry-run" | "declined" | "written"; diff: string };
export function applyBlock(current: string, generated: string): string {
  const block = `${begin}\n${generated}\n${end}`; const start = current.indexOf(begin); const finish = current.indexOf(end);
  if (start >= 0 && finish >= start) return `${current.slice(0, start)}${block}${current.slice(finish + end.length)}`;
  return `${current}${current && !current.endsWith("\n") ? "\n" : ""}${block}\n`;
}
function diff(path: string, before: string, after: string): string { return before === after ? "" : `--- ${path}\n+++ ${path}\n@@\n-${before}\n+${after}\n`; }
export async function syncFile(path: string, generated: string, options: SyncOptions = {}): Promise<SyncResult> {
  let current = ""; let exists = true; try { current = await readFile(path, "utf8"); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
  let safe: string; try { safe = scrub(generated).text; } catch (error) { options.log?.(`${basename(path)}: ${error instanceof Error ? error.name : "ScrubError"}`); return { action: "declined", diff: "" }; }
  const next = applyBlock(current, safe); const patch = diff(path, current, next); if (!patch) return { action: "unchanged", diff: "" };
  if (options.dryRun) return { action: "dry-run", diff: patch };
  if (!options.yes && !(await options.confirm?.() ?? false)) return { action: "declined", diff: patch };
  await mkdir(dirname(path), { recursive: true }); const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try { await (options.writeFile ?? writeFile)(temporary, next, "utf8"); await (options.rename ?? rename)(temporary, path); } finally { /* a failed temp write never touches the destination */ }
  options.log?.(`${path}: written`); return { action: "written", diff: patch };
}
