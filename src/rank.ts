export type SourceType = "rule" | "decision" | "doc" | "code" | "commit";
export type RankedChunk = { id: string; project: string; path: string; startLine: number; endLine: number; sourceType: SourceType; text: string };
export type RankOptions = { fts: readonly RankedChunk[]; vectors?: readonly RankedChunk[]; editedPaths?: ReadonlySet<string>; editBoost?: number; rrfK?: number; tokenBudget?: number };
export type RankedResult = RankedChunk & { score: number; estimatedTokens: number };

const tiers: Record<SourceType, number> = { rule: 5, decision: 4, doc: 3, code: 2, commit: 1 };

function validate(chunk: RankedChunk): void {
  if (!chunk.project || !chunk.path || !Number.isInteger(chunk.startLine) || chunk.startLine < 1 || !Number.isInteger(chunk.endLine) || chunk.endLine < chunk.startLine || !chunk.sourceType) throw new Error("Ranked result is missing required provenance.");
}

export function rank(options: RankOptions): RankedResult[] {
  const k = options.rrfK ?? 60; const scores = new Map<string, { chunk: RankedChunk; score: number }>();
  const add = (items: readonly RankedChunk[]) => items.forEach((chunk, index) => { validate(chunk); const previous = scores.get(chunk.id) ?? { chunk, score: 0 }; previous.score += 1 / (k + index + 1); scores.set(chunk.id, previous); });
  add(options.fts); if (options.vectors) add(options.vectors);
  const boost = options.editBoost ?? 0;
  return [...scores.values()].map(({ chunk, score }) => ({ ...chunk, score: score + (options.editedPaths?.has(chunk.path) ? boost : 0), estimatedTokens: Math.ceil(chunk.text.length / 4) }))
    .sort((left, right) => right.score - left.score || tiers[right.sourceType] - tiers[left.sourceType] || left.path.localeCompare(right.path));
}

export function withinTokenBudget(options: RankOptions): RankedResult[] {
  const budget = options.tokenBudget ?? 4000; let used = 0; const selected: RankedResult[] = [];
  for (const result of rank(options)) if (used + result.estimatedTokens <= budget) { selected.push(result); used += result.estimatedTokens; }
  return selected;
}
