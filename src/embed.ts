import { scrub } from "./scrub.ts";
import { Store } from "./store.ts";

export type EmbedOptions = { store: Store; hash: string; url?: string; model?: string; timeoutMs?: number; log?: (status: string) => void };
export type EmbedResult = { available: boolean; embedding?: number[]; cached: boolean };

export async function embed(text: string, options: EmbedOptions): Promise<EmbedResult> {
  const cached = options.store.cacheGet(`embedding:${options.hash}`);
  if (cached) return { available: true, embedding: JSON.parse(cached) as number[], cached: true };
  const url = options.url ?? "http://localhost:11434";
  let endpoint: URL;
  try { endpoint = new URL(url); } catch { return { available: false, cached: false }; }
  if (endpoint.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(endpoint.hostname) || endpoint.pathname !== "/") return { available: false, cached: false };
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
    const response = await fetch(`${url}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: options.model ?? "nomic-embed-text", input: scrub(text).text }), signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) { options.log?.(`http-${response.status}`); return { available: false, cached: false }; }
    const vector = (await response.json() as { embeddings?: number[][] }).embeddings?.[0];
    if (!Array.isArray(vector)) { options.log?.("invalid-response"); return { available: false, cached: false }; }
    options.store.cacheSet(`embedding:${options.hash}`, JSON.stringify(vector)); return { available: true, embedding: vector, cached: false };
  } catch (error) { options.log?.(error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable"); return { available: false, cached: false }; }
}
