import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";

export type GithubConfig = {
  enabled: boolean;
  owner: string;
  repos: string[];
  cloneRoot: string;
  pollIntervalMinutes: number;
  pushMode: "pr";
  branchPrefix: string;
  allowPublicPush: boolean;
  maxReposPerRun: number;
  rateLimitBackoffSeconds: number;
};

export type CtxConfig = {
  projects: string[];
  autoSync: boolean;
  allowlist: string[];
  pollIntervalMinutes: number;
  pushMode: "pr";
  publicPush: boolean;
  embedding: { provider: "ollama"; model: string; url: string };
  github: GithubConfig;
};

export const defaultGithubConfig: GithubConfig = {
  enabled: false,
  owner: "",
  repos: [],
  cloneRoot: "~/code/github",
  pollIntervalMinutes: 15,
  pushMode: "pr",
  branchPrefix: "ctx/auto-update",
  allowPublicPush: false,
  maxReposPerRun: 50,
  rateLimitBackoffSeconds: 60,
};

export const defaultConfig: CtxConfig = { projects: [], autoSync: false, allowlist: [], pollIntervalMinutes: 5, pushMode: "pr", publicPush: false, embedding: { provider: "ollama", model: "nomic-embed-text", url: "http://localhost:11434" }, github: defaultGithubConfig };

export function githubRoot(home = homedir()): string { return resolve(home, "code/github"); }

function isWithin(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith("../") && path !== "..";
}

const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const TOKEN_KEY_RE = /(token|secret|password|apikey)/i;
const TOKEN_VALUE_RE = /\b(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|sk_(?:live|test)_[A-Za-z0-9]+)\b/;

function assertNoTokens(value: unknown): void {
  if (typeof value === "string") {
    if (TOKEN_VALUE_RE.test(value)) throw new Error("Tokens must be stored in Keychain, not configuration.");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoTokens(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (TOKEN_KEY_RE.test(key)) throw new Error("Tokens must be stored in Keychain, not configuration.");
      assertNoTokens(entry);
    }
  }
}

export function isValidOwnerRepo(value: string): boolean {
  return OWNER_REPO_RE.test(value) && !value.includes("..");
}

export function resolveCloneRoot(cloneRoot: string, home = homedir()): string {
  if (cloneRoot === "~") return resolve(home);
  if (cloneRoot.startsWith("~/")) return resolve(home, cloneRoot.slice(2));
  return resolve(cloneRoot);
}

export function parseGithubConfig(raw: unknown, home = homedir()): GithubConfig {
  if (raw === undefined) return { ...defaultGithubConfig, repos: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("github must be an object.");
  assertNoTokens(raw);
  const g = raw as Record<string, unknown>;
  const enabled = g.enabled ?? defaultGithubConfig.enabled;
  if (typeof enabled !== "boolean") throw new Error("github.enabled must be boolean.");
  const owner = g.owner ?? defaultGithubConfig.owner;
  if (typeof owner !== "string") throw new Error("github.owner must be a string.");
  const repos = g.repos ?? defaultGithubConfig.repos;
  if (!Array.isArray(repos) || !repos.every((entry) => typeof entry === "string" && isValidOwnerRepo(entry))) {
    throw new Error("github.repos must be an array of owner/repo strings.");
  }
  if (new Set(repos).size !== repos.length) throw new Error("github.repos must not contain duplicates.");
  const cloneRoot = g.cloneRoot ?? defaultGithubConfig.cloneRoot;
  if (typeof cloneRoot !== "string" || !cloneRoot || !isWithin(resolveCloneRoot(cloneRoot, home), resolve(home))) {
    throw new Error("github.cloneRoot must resolve inside the home directory.");
  }
  const pollIntervalMinutes = g.pollIntervalMinutes ?? defaultGithubConfig.pollIntervalMinutes;
  if (!Number.isInteger(pollIntervalMinutes) || (pollIntervalMinutes as number) < 5) {
    throw new Error("github.pollIntervalMinutes must be an integer of at least 5.");
  }
  if (g.pushMode !== undefined && g.pushMode !== "pr") throw new Error("github.pushMode is locked to pr in v1.");
  const branchPrefix = g.branchPrefix ?? defaultGithubConfig.branchPrefix;
  if (typeof branchPrefix !== "string" || !branchPrefix) throw new Error("github.branchPrefix must be a non-empty string.");
  const allowPublicPush = g.allowPublicPush ?? defaultGithubConfig.allowPublicPush;
  if (typeof allowPublicPush !== "boolean") throw new Error("github.allowPublicPush must be boolean.");
  const maxReposPerRun = g.maxReposPerRun ?? defaultGithubConfig.maxReposPerRun;
  if (!Number.isInteger(maxReposPerRun) || (maxReposPerRun as number) < 1) {
    throw new Error("github.maxReposPerRun must be a positive integer.");
  }
  const rateLimitBackoffSeconds = g.rateLimitBackoffSeconds ?? defaultGithubConfig.rateLimitBackoffSeconds;
  if (!Number.isInteger(rateLimitBackoffSeconds) || (rateLimitBackoffSeconds as number) < 1) {
    throw new Error("github.rateLimitBackoffSeconds must be a positive integer.");
  }
  return {
    enabled,
    owner,
    repos: [...repos],
    cloneRoot,
    pollIntervalMinutes: pollIntervalMinutes as number,
    pushMode: "pr",
    branchPrefix,
    allowPublicPush,
    maxReposPerRun: maxReposPerRun as number,
    rateLimitBackoffSeconds: rateLimitBackoffSeconds as number,
  };
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
  return { projects, autoSync: input.autoSync ?? false, allowlist: normalized, pollIntervalMinutes: pollIntervalMinutes as number, pushMode: "pr", publicPush: input.publicPush ?? false, embedding: { provider: "ollama", model: (e.model as string | undefined) ?? defaultConfig.embedding.model, url: parsed.toString().replace(/\/$/, "") || "http://localhost:11434" }, github: parseGithubConfig(input.github, home) };
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

export async function saveConfig(config: CtxConfig, configPath = process.env.CTX_CONFIG_PATH ?? resolve(homedir(), ".ctx/config.json")): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
