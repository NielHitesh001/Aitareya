import { createHash } from "node:crypto";
import { lstat, opendir, readFile as defaultReadFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { scrub } from "./scrub.ts";
import { Store } from "./store.ts";

const ignoredDirectories = new Set(["node_modules", ".git", "dist", "build", "target", ".venv"]);
const lockfile = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$/i;
const secretName = /(?:^|\/)(?:\.env[^/]*|[^/]*\.pem|[^/]*\.key|id_rsa[^/]*|[^/]*\.p12|[^/]*\.pfx|credentials[^/]*|[^/]*secrets[^/]*)$/i;

export type ScanOptions = { store: Store; maxFileBytes?: number; readFile?: typeof defaultReadFile; log?: (message: string) => void };
export type ScanResult = { indexed: string[]; skipped: string[]; removed: string[] };

function hash(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }
function sourceType(path: string): "rule" | "decision" | "doc" | "code" {
  if (/^context\/rules\.md$/i.test(path)) return "rule";
  if (/^context\/decisions\//i.test(path)) return "decision";
  return /\.md$/i.test(path) ? "doc" : "code";
}

export function chunkText(text: string, maximum = 1500): Array<{ text: string; startLine: number; endLine: number }> {
  const lines = text.split("\n"); const chunks: Array<{ text: string; startLine: number; endLine: number }> = [];
  let start = 0; let current: string[] = [];
  const flush = (end: number) => { if (current.length) chunks.push({ text: current.join("\n"), startLine: start + 1, endLine: end }); };
  for (let index = 0; index < lines.length; index++) {
    if (current.join("\n").length + lines[index].length + 1 > maximum && current.length) { flush(index); start = Math.max(0, index - 1); current = lines.slice(start, index); }
    current.push(lines[index]);
    if (!lines[index].trim() && current.join("\n").length > maximum * 0.6) { flush(index + 1); start = index + 1; current = []; }
  }
  flush(lines.length); return chunks;
}

async function collect(root: string, current: string, output: string[], max: number): Promise<void> {
  for await (const entry of await opendir(current)) {
    const full = resolve(current, entry.name); const relativePath = relative(root, full);
    if (entry.isSymbolicLink() || secretName.test(relativePath) || lockfile.test(relativePath)) continue;
    if (entry.isDirectory()) { if (!ignoredDirectories.has(entry.name)) await collect(root, full, output, max); continue; }
    if (!entry.isFile() || (await lstat(full)).size > max) continue;
    output.push(relativePath);
  }
}

export async function scanRepository(root: string, options: ScanOptions): Promise<ScanResult> {
  const project = resolve(root); const max = options.maxFileBytes ?? 512 * 1024; const files: string[] = [];
  await collect(project, project, files, max);
  let gitIgnored = new Set<string>();
  try { gitIgnored = new Set((await defaultReadFile(resolve(project, ".gitignore"), "utf8")).split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))); } catch { /* no ignore file */ }
  const indexed: string[] = []; const skipped: string[] = []; const reader = options.readFile ?? defaultReadFile;
  for (const path of files.sort()) {
    if (gitIgnored.has(path)) { skipped.push(path); continue; }
    const full = resolve(project, path); let bytes: Buffer;
    try { bytes = await reader(full) as Buffer; } catch { skipped.push(path); continue; }
    if (bytes.includes(0)) { skipped.push(path); continue; }
    const digest = hash(bytes); if (options.store.fileHash(project, path) === digest) continue;
    options.store.removeFile(project, path);
    for (const part of chunkText(bytes.toString("utf8"))) {
      try { const safe = scrub(part.text); options.store.upsertChunk({ project, path, content: safe.text, startLine: part.startLine, endLine: part.endLine, sourceType: sourceType(path), hash: digest }); }
      catch (error) { options.log?.(`${path}: ${error instanceof Error ? error.name : "ScrubError"}`); }
    }
    options.store.setFileHash(project, path, digest); indexed.push(path);
  }
  const removed: string[] = [];
  for (const path of options.store.indexedPaths(project)) if (!files.includes(path)) { options.store.removeFile(project, path); removed.push(path); }
  return { indexed, skipped, removed };
}
