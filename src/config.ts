import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";

export type CtxConfig = {
  projects: string[];
  autoSync: boolean;
  allowlist: string[];
  pollIntervalMinutes: number;
  pushMode: "pr";
  publicPush: boolean;
  embedding: { provider: "ollama"; model: string; url: string };
};

export const defaultConfig: CtxConfig = { projects: [], autoSync: false, allowlist: [], pollIntervalMinutes: 5, pushMode: "pr", publicPush: false, embedding: { provider: "ollama", model: "nomic-embed-text", url: "http://localhost:11434" } };

export function githubRoot(home = homedir()): string { return resolve(home, "code/github"); }

function isWithin(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith("../") && path !== "..";
}

export function parseConfig(raw: unknown, home = homedir()): CtxConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Config must be a JSON object.");
  const input = raw as Record<string, unknown>;
  if ("githubToken" in input || "token" in input) throw new Error("Tokens must be stored in Keychain, not configuration.");
  const allowlist = input.allowlist ?? [];
  if (!Array.isArray(allowlist) || !allowlist.every((path) => typeof path === "string")) throw new Error("allowlist must be an array of paths.");
  const root = githubRoot(home);
  const normalized = allowlist.map((path) => resolve(path));
  if (!normalized.every((path) => isWithin(path, root))) throw new Error("Allowlist paths must resolve inside ~/code/github/.");
  const pollIntervalMinutes = input.pollIntervalMinutes ?? defaultConfig.pollIntervalMinutes;
  if (!Number.isInteger(pollIntervalMinutes) || (pollIntervalMinutes as number) < 5) throw new Error("pollIntervalMinutes must be an integer of at least 5.");
  if (input.pushMode !== undefined && input.pushMode !== "pr") throw new Error("pushMode is locked to pr in v1.");
  if (input.publicPush !== undefined && typeof input.publicPush !== "boolean") throw new Error("publicPush must be boolean.");
  if (input.autoSync !== undefined && typeof input.autoSync !== "boolean") throw new Error("autoSync must be boolean.");
  const embedding = input.embedding ?? defaultConfig.embedding;
  if (!embedding || typeof embedding !== "object" || Array.isArray(embedding)) throw new Error("embedding must be an object.");
  const e = embedding as Record<string, unknown>;
  if (e.provider !== undefined && e.provider !== "ollama") throw new Error("embedding.provider must be ollama.");
  if (e.model !== undefined && (typeof e.model !== "string" || !e.model)) throw new Error("embedding.model must be a non-empty string.");
  const url = e.url ?? defaultConfig.embedding.url;
  if (typeof url !== "string") throw new Error("embedding.url must be a URL string.");
  let parsed: URL; try { parsed = new URL(url); } catch { throw new Error("embedding.url must be a valid URL."); }
  if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("embedding.url must be local HTTP at the root path.");
  const projects = input.projects ?? [];
  if (!Array.isArray(projects) || !projects.every((path) => typeof path === "string" && resolve(path) === path)) throw new Error("projects must be absolute paths.");
  if (new Set(projects).size !== projects.length) throw new Error("projects must not contain duplicates.");
  return { projects, autoSync: input.autoSync ?? false, allowlist: normalized, pollIntervalMinutes: pollIntervalMinutes as number, pushMode: "pr", publicPush: input.publicPush ?? false, embedding: { provider: "ollama", model: (e.model as string | undefined) ?? defaultConfig.embedding.model, url: parsed.toString().replace(/\/$/, "") || "http://localhost:11434" } };
}

export async function registerProject(config: CtxConfig, project: string): Promise<CtxConfig> {
  const resolved = await realpath(project); const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("Project must be a directory.");
  await access(resolve(resolved, ".git"));
  return config.projects.includes(resolved) ? config : { ...config, projects: [...config.projects, resolved] };
}

async function validateProjects(projects: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(projects.map(async (project) => {
    const path = await realpath(project); const info = await stat(path);
    if (!info.isDirectory()) throw new Error("Configured project must be a directory.");
    await access(resolve(path, ".git")); return path;
  }));
  if (new Set(resolved).size !== resolved.length) throw new Error("projects must not contain duplicate realpaths.");
  return resolved;
}

export async function loadConfig(configPath = process.env.CTX_CONFIG_PATH ?? resolve(homedir(), ".ctx/config.json")): Promise<CtxConfig> {
  try { const config = parseConfig(JSON.parse(await readFile(configPath, "utf8"))); return { ...config, projects: await validateProjects(config.projects) }; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig;
    throw error;
  }
}
