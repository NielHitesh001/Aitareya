import { withinTokenBudget } from "../rank.ts";
import { scrub } from "../scrub.ts";
import type { Store } from "../store.ts";

export function agentsMarkdown(store: Store, project: string): string {
  const chunks = store.contextChunks(project).map(({ content, ...chunk }) => ({ ...chunk, text: content }));
  const text = withinTokenBudget({ fts: chunks }).map((chunk) => `## ${chunk.sourceType}: ${chunk.path}:${chunk.startLine}-${chunk.endLine}\n${chunk.text}`).join("\n\n");
  return scrub(text).text;
}
