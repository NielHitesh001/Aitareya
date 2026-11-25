export type Redaction = { kind: string; count: number };
export type ScrubResult = { text: string; redactions: Redaction[] };

const replacements: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "pem-private-key", pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g },
  { kind: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github-token", pattern: /\b(?:ghp_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g },
  { kind: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "stripe-key", pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
];

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  return [...counts.values()].reduce((total, count) => {
    const probability = count / value.length;
    return total - probability * Math.log2(probability);
  }, 0);
}

function redactHighEntropy(text: string, count: (kind: string) => void): string {
  return text.replace(/\b(?:api[_-]?key|access[_-]?key|private[_-]?key|credential)\s*([:=])\s*(["']?)([A-Za-z0-9+/_=-]{32,})\2/gi, (match, separator: string, quote: string, value: string) => {
    if (entropy(value) < 3.5) return match;
    count("high-entropy-key");
    return `${match.slice(0, match.indexOf(separator) + 1)}${quote}[REDACTED:high-entropy-key]${quote}`;
  });
}

function redactAssignments(text: string, count: (kind: string) => void): string {
  return text.replace(/\b(password|secret|token)\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, (_match, name: string, separator: string) => {
    count("assignment");
    return `${name}${separator}[REDACTED:assignment]`;
  });
}

/** Redacts secrets locally. Match values are never returned or logged. */
export function scrub(text: string): ScrubResult {
  const counts = new Map<string, number>();
  const count = (kind: string) => counts.set(kind, (counts.get(kind) ?? 0) + 1);
  let sanitized = text;
  for (const { kind, pattern } of replacements) {
    sanitized = sanitized.replace(pattern, () => { count(kind); return `[REDACTED:${kind}]`; });
  }
  sanitized = redactHighEntropy(sanitized, count);
  sanitized = redactAssignments(sanitized, count);
  return { text: sanitized, redactions: [...counts].map(([kind, count]) => ({ kind, count })) };
}

/** A scanner-facing helper: a failed scrub drops that chunk rather than retaining raw input. */
export function scrubChunks(chunks: readonly string[], scrubber: (chunk: string) => ScrubResult = scrub): ScrubResult[] {
  const results: ScrubResult[] = [];
  for (const chunk of chunks) {
    try { results.push(scrubber(chunk)); } catch { /* Skip unsafe chunks without logging their contents. */ }
  }
  return results;
}
