import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { isValidOwnerRepo, loadConfig, registerProject, resolveCloneRoot, saveConfig, type CtxConfig } from "./config.ts";
import { scanRepository } from "./scanner.ts";
import { scrub } from "./scrub.ts";
import { Store } from "./store.ts";

const exec = promisify(execFile);

const DOCUMENTED_SCOPES = new Set([
  "repo",
  "contents:read",
  "contents:write",
  "pull_requests:read",
  "pull_requests:write",
  "metadata:read",
  "metadata",
]);

const WRITE_SCOPES = new Set(["repo", "contents:write", "pull_requests:write"]);
const SAFE_SCOPE_RE = /^[a-z0-9:_-]+$/i;
const TOKEN_PREFIX_RE = /^(gh[pousr]_|github_pat_)/i;

export type GithubScopeReport = {
  status: "pass" | "warn" | "fail";
  names: string[];
  broad?: string[];
  writeAccess?: boolean;
  message?: string;
};

export type GithubDoctorReport = {
  ghInstalled: "pass" | "fail";
  authenticated: "pass" | "fail";
  scopes: GithubScopeReport;
};

export type GitDoctorReport = {
  status: "pass" | "fail";
  message?: string;
};

type ExecResult = { ok: boolean; stdout: string; stderr: string; notFound: boolean };

async function runCmd(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { env: env ?? process.env, timeout: 10_000 });
    return { ok: true, stdout, stderr, notFound: false };
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      notFound: err.code === "ENOENT",
    };
  }
}

export function parseTokenScopes(authOutput: string): string[] {
  const match = authOutput.match(/Token scopes:\s*(.+)/i);
  if (!match) return [];
  const raw = match[1].trim();
  if (!raw || /^none$/i.test(raw)) return [];
  return raw
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
    .filter((name) => name.length > 0 && SAFE_SCOPE_RE.test(name) && !TOKEN_PREFIX_RE.test(name));
}

export async function checkGitInstalled(env?: NodeJS.ProcessEnv): Promise<GitDoctorReport> {
  const result = await runCmd("git", ["--version"], env);
  if (result.ok) return { status: "pass" };
  return {
    status: "fail",
    message: result.notFound ? "git is not installed." : "git check failed.",
  };
}

export async function checkGithubDoctor(env?: NodeJS.ProcessEnv): Promise<GithubDoctorReport> {
  const version = await runCmd("gh", ["--version"], env);
  if (!version.ok) {
    return {
      ghInstalled: "fail",
      authenticated: "fail",
      scopes: {
        status: "fail",
        names: [],
        message: version.notFound ? "gh CLI is not installed." : "gh CLI check failed.",
      },
    };
  }

  const auth = await runCmd("gh", ["auth", "status"], env);
  if (!auth.ok) {
    return {
      ghInstalled: "pass",
      authenticated: "fail",
      scopes: {
        status: "fail",
        names: [],
        message: "gh is not authenticated. Run `ctx github login`.",
      },
    };
  }

  const scopes = parseTokenScopes(`${auth.stdout}\n${auth.stderr}`);
  const broad = scopes.filter((scope) => !DOCUMENTED_SCOPES.has(scope));
  const hasExplicitScopes = scopes.length > 0;
  const writeAccess = !hasExplicitScopes || scopes.some((scope) => WRITE_SCOPES.has(scope));

  const warnings: string[] = [];
  if (broad.length > 0) {
    warnings.push(`Token scopes broader than documented set: ${broad.join(", ")}.`);
  }
  if (!writeAccess) {
    warnings.push("Token lacks write access; pushes will be skipped. Reads continue.");
  }

  return {
    ghInstalled: "pass",
    authenticated: "pass",
    scopes: {
      status: warnings.length > 0 ? "warn" : "pass",
      names: scopes,
      ...(broad.length > 0 ? { broad } : {}),
      writeAccess,
      ...(warnings.length > 0 ? { message: warnings.join(" ") } : {}),
    },
  };
}

function runInteractive(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], env: env ?? process.env });
    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(scrub(chunk.toString("utf8")).text));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(scrub(chunk.toString("utf8")).text));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export type LoginResult = {
  alreadyAuthenticated: boolean;
  scopes: string[];
  writeAccess: boolean;
  message: string;
};

export async function loginGithub(options: { env?: NodeJS.ProcessEnv; interactive?: boolean } = {}): Promise<LoginResult> {
  const env = options.env ?? process.env;
  const version = await runCmd("gh", ["--version"], env);
  if (!version.ok) {
    throw new Error(version.notFound ? "gh CLI is not installed." : "gh CLI check failed.");
  }

  const initial = await runCmd("gh", ["auth", "status"], env);
  let alreadyAuthenticated = initial.ok;

  if (!initial.ok) {
    if (options.interactive === false) {
      const login = await runCmd("gh", ["auth", "login", "--scopes", "repo"], env);
      if (!login.ok) throw new Error("gh auth login failed.");
    } else {
      const code = await runInteractive("gh", ["auth", "login", "--scopes", "repo"], env);
      if (code !== 0) throw new Error(`gh auth login failed with exit code ${code}.`);
    }
    alreadyAuthenticated = false;
  }

  const verified = await checkGithubDoctor(env);
  if (verified.authenticated !== "pass") {
    throw new Error("GitHub token verification failed after login.");
  }

  const scopeList = verified.scopes.names.length > 0 ? verified.scopes.names.join(", ") : "fine-grained/none";
  const writeAccess = verified.scopes.writeAccess ?? true;
  const suffix = writeAccess ? "" : " Token lacks write access; pushes will be skipped. Reads continue.";
  return {
    alreadyAuthenticated,
    scopes: verified.scopes.names,
    writeAccess,
    message: `GitHub authentication verified (scopes: ${scopeList}).${suffix}`,
  };
}

export type DiscoverEntry = {
  nameWithOwner: string;
  isNew: boolean;
  isPrivate: boolean;
};

export type DiscoverResult = {
  entries: DiscoverEntry[];
  privateNewCount: number;
  lines: string[];
};

export function assertAllowedRepo(config: CtxConfig, ownerRepo: string): string {
  if (!isValidOwnerRepo(ownerRepo)) {
    throw new Error(`Invalid repository format "${ownerRepo}". Expected "owner/repo".`);
  }
  if (!config.github.repos.includes(ownerRepo)) {
    throw new Error(`Repository "${ownerRepo}" is not in github.repos allowlist.`);
  }
  return ownerRepo;
}

export async function initRepository(
  repoPath: string,
  options: { configPath?: string; storePath?: string } = {},
): Promise<void> {
  const ctxHome = process.env.CTX_HOME ?? join(homedir(), ".ctx");
  const configPath = options.configPath ?? process.env.CTX_CONFIG_PATH ?? join(ctxHome, "config.json");
  const storePath = options.storePath ?? join(ctxHome, "index.db");
  const config = await registerProject(await loadConfig(configPath), repoPath);
  await saveConfig(config, configPath);
  await mkdir(join(repoPath, "context", "decisions"), { recursive: true });
  try {
    await readFile(join(repoPath, "context", "rules.md"));
  } catch {
    await writeFile(join(repoPath, "context", "rules.md"), "# Project rules\n");
  }
  const store = new Store({ path: storePath });
  try {
    await scanRepository(repoPath, { store });
  } finally {
    store.close();
  }
}

export async function discoverRepos(options: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  allowPrivateNames?: boolean;
} = {}): Promise<DiscoverResult> {
  const env = options.env ?? process.env;
  const config = await loadConfig(options.configPath);
  const result = await runCmd("gh", ["repo", "list", "--limit", "1000", "--json", "nameWithOwner"], env);
  if (!result.ok) {
    throw new Error(result.notFound ? "gh CLI is not installed." : "Failed to list repositories via gh.");
  }

  let rawList: unknown;
  try {
    rawList = JSON.parse(result.stdout);
  } catch {
    throw new Error("Failed to parse repository list from gh.");
  }
  if (!Array.isArray(rawList)) {
    throw new Error("Unexpected repository list format from gh.");
  }

  const allowlisted = new Set(config.github.repos);
  const entries: DiscoverEntry[] = [];
  const lines: string[] = [];
  let privateNewCount = 0;

  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const record = item as { nameWithOwner?: unknown; isPrivate?: unknown };
    if (typeof record.nameWithOwner !== "string" || !isValidOwnerRepo(record.nameWithOwner)) continue;
    const isPrivate = record.isPrivate === true;
    const isNew = !allowlisted.has(record.nameWithOwner);
    entries.push({ nameWithOwner: record.nameWithOwner, isNew, isPrivate });
    if (isPrivate && !options.allowPrivateNames) {
      if (isNew) privateNewCount += 1;
      continue;
    }
    lines.push(isNew ? `${record.nameWithOwner} (new)` : `${record.nameWithOwner} (allowlisted)`);
  }

  if (privateNewCount > 0) {
    lines.push(`${privateNewCount} private new ${privateNewCount === 1 ? "repository" : "repositories"} (names hidden).`);
  }

  return { entries, privateNewCount, lines };
}

function resolveRepoTarget(cloneRoot: string, ownerRepo: string, home = homedir()): string {
  const root = resolveCloneRoot(cloneRoot, home);
  const [owner, repo] = ownerRepo.split("/");
  const target = resolve(root, owner, repo);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || rel === "..") {
    throw new Error("Resolved repository path escapes cloneRoot.");
  }
  return target;
}

export async function allowRepo(
  ownerRepo: string,
  options: { configPath?: string; storePath?: string; home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ repo: string; targetDir: string; cloned: boolean; message: string }> {
  if (!isValidOwnerRepo(ownerRepo)) {
    throw new Error(`Invalid repository format "${ownerRepo}". Expected "owner/repo".`);
  }

  const ctxHome = process.env.CTX_HOME ?? join(homedir(), ".ctx");
  const configPath = options.configPath ?? process.env.CTX_CONFIG_PATH ?? join(ctxHome, "config.json");
  const storePath = options.storePath ?? join(ctxHome, "index.db");
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;

  const current = await loadConfig(configPath);
  const targetDir = resolveRepoTarget(current.github.cloneRoot, ownerRepo, home);

  let exists = false;
  try {
    await stat(targetDir);
    exists = true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (exists) {
    const nextRepos = current.github.repos.includes(ownerRepo) ? current.github.repos : [...current.github.repos, ownerRepo];
    await saveConfig({ ...current, github: { ...current.github, repos: nextRepos } }, configPath);
    try {
      await access(join(targetDir, ".git"));
      await initRepository(targetDir, { configPath, storePath });
    } catch {
      // Directory exists without .git; do not re-clone or fail on init.
    }
    return {
      repo: ownerRepo,
      targetDir,
      cloned: false,
      message: `Target directory already exists at ${targetDir}; skipped clone.`,
    };
  }

  await mkdir(dirname(targetDir), { recursive: true });
  const url = `https://github.com/${ownerRepo}.git`;
  const clone = await runCmd(
    "git",
    ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "clone", url, targetDir],
    env,
  );
  if (!clone.ok) {
    const detail = scrub(clone.stderr || clone.stdout).text.trim();
    throw new Error(detail ? `git clone failed: ${detail}` : "git clone failed.");
  }

  const updated = await loadConfig(configPath);
  const nextRepos = updated.github.repos.includes(ownerRepo) ? updated.github.repos : [...updated.github.repos, ownerRepo];
  await saveConfig({ ...updated, github: { ...updated.github, repos: nextRepos } }, configPath);
  await initRepository(targetDir, { configPath, storePath });

  return {
    repo: ownerRepo,
    targetDir,
    cloned: true,
    message: `Allowed and cloned ${ownerRepo} to ${targetDir}.`,
  };
}

export async function denyRepo(
  ownerRepo: string,
  options: { configPath?: string } = {},
): Promise<{ repo: string; message: string }> {
  if (!isValidOwnerRepo(ownerRepo)) {
    throw new Error(`Invalid repository format "${ownerRepo}". Expected "owner/repo".`);
  }
  const ctxHome = process.env.CTX_HOME ?? join(homedir(), ".ctx");
  const configPath = options.configPath ?? process.env.CTX_CONFIG_PATH ?? join(ctxHome, "config.json");
  const config = await loadConfig(configPath);
  assertAllowedRepo(config, ownerRepo);

  const nextRepos = config.github.repos.filter((entry) => entry !== ownerRepo);
  await saveConfig({ ...config, github: { ...config.github, repos: nextRepos } }, configPath);

  return {
    repo: ownerRepo,
    message: `Removed ${ownerRepo} from github.repos. Local clone was not deleted.`,
  };
}
