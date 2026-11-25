import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { scrub } from "./scrub.ts";

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
