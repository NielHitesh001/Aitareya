import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scrub } from "./scrub.ts";
import { Store } from "./store.ts";

const run = promisify(execFile);
export async function indexGitHistory(project: string, store: Store, limit = 300): Promise<number> {
  const { stdout } = await run("git", ["-C", project, "log", `-n${limit}`, "--format=%H%x1f%s%x1f%b%x1e", "--name-only"]);
  let count = 0;
  for (const record of stdout.split("\x1e")) {
    const [sha, subject = "", body = "", ...files] = record.trim().split("\x1f"); if (!/^[0-9a-f]{40}$/i.test(sha)) continue;
    const safe = scrub([subject, body, files.join("\n")].join("\n"));
    store.upsertChunk({ project, path: `.git/commits/${sha}`, content: safe.text, startLine: 1, endLine: safe.text.split("\n").length, sourceType: "commit", hash: createHash("sha256").update(safe.text).digest("hex"), commitSha: sha }); count++;
  }
  return count;
}
