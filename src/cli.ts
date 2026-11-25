import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startApiServer } from "./api/server.ts";
import { doctor } from "./doctor.ts";
import { defaultConfig, loadConfig, registerProject } from "./config.ts";
import { scanRepository } from "./scanner.ts";
import { Store } from "./store.ts";
import { withinTokenBudget } from "./rank.ts";
import { embed } from "./embed.ts";
import { agentsMarkdown } from "./writers/agents-md.ts";
import { claudeMarkdown } from "./writers/claude-md.ts";
import { cursorRules } from "./writers/cursorrules.ts";
import { syncFile } from "./sync.ts";
import { watchProjects } from "./watcher.ts";
import { startMcpServer } from "./mcp-server.ts";
import { installDaemon, uninstallDaemon } from "./daemon.ts";
import { loginGithub } from "./github.ts";

const exec = promisify(execFile);
const ctxHome = process.env.CTX_HOME ?? join(homedir(), ".ctx");
const configPath = join(ctxHome, "config.json");
const storePath = join(ctxHome, "index.db");
async function saveConfig(config: object) { await mkdir(ctxHome, { recursive: true, mode: 0o700 }); await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); }
async function currentGitRepository(): Promise<string> { try { return (await exec("git", ["rev-parse", "--show-toplevel"])).stdout.trim(); } catch { throw new Error("ctx init must be run inside a git repository."); } }
async function init() { const repo = await currentGitRepository(); const config = await registerProject(await loadConfig(configPath), repo); await saveConfig(config); await mkdir(join(repo, "context", "decisions"), { recursive: true }); try { await readFile(join(repo, "context", "rules.md")); } catch { await writeFile(join(repo, "context", "rules.md"), "# Project rules\n"); } const store = new Store({ path: storePath }); try { await scanRepository(repo, { store }); } finally { store.close(); } }
async function scan(projectOnly: boolean) { const config = await loadConfig(configPath); const projects = projectOnly ? [await currentGitRepository()] : config.projects; const store = new Store({ path: storePath }); try { for (const project of projects) await scanRepository(project, { store }); } finally { store.close(); } }
async function search(query: string) { const store = new Store({ path: storePath }); try { const chunks = store.searchChunks(query); if (chunks[0]) await embed(chunks[0].content, { store, hash: chunks[0].id }); const results = withinTokenBudget({ fts: chunks.map(({ content, ...chunk }) => ({ ...chunk, text: content })) }); for (const result of results) console.log(`${result.project} ${result.path}:${result.startLine}-${result.endLine} [${result.sourceType}]\n${result.text}\n`); } finally { store.close(); } }
async function syncProject(project: string, args: string[], emitDiff = true) { const store = new Store({ path: storePath }); try { const dryRun = args.includes("--dry-run"); const yes = args.includes("--yes"); const targets = [["AGENTS.md", agentsMarkdown], ["CLAUDE.md", claudeMarkdown], [".cursorrules", cursorRules]] as const; for (const [name, writer] of targets) { const result = await syncFile(join(project, name), writer(store, project), { dryRun, yes, confirm: async () => new Promise((resolve) => { process.stdout.write(`Apply ${name}? [y/N] `); process.stdin.once("data", (data) => resolve(data.toString().trim().toLowerCase() === "y")); }), log: (message) => console.error(message) }); if (emitDiff && result.diff) process.stdout.write(result.diff); } } finally { store.close(); } }
async function sync(args: string[]) { await syncProject(await currentGitRepository(), args); }
async function watchCommand(args: string[]) { const config = await loadConfig(configPath); const store = new Store({ path: storePath }); const service = await watchProjects({ projects: config.projects, ctxHome, store, autoSync: config.autoSync, yes: args.includes("--yes"), sync: async (project) => syncProject(project, ["--yes"], false), projectProvider: async () => (await loadConfig(configPath)).projects, log: (message) => console.error(message) }); const stop = async () => { await service.close(); store.close(); process.exit(0); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); }
async function serve() { await startMcpServer({ configPath, storePath, log: (message) => console.error(message) }); }
async function daemon(action?: string) { const options = { ctxHome, binaryPath: process.env.CTX_BIN, launchAgents: process.env.CTX_LAUNCH_AGENTS }; if (action === "install") { for (const file of await installDaemon(options)) console.log(`loaded ${file}`); } else if (action === "uninstall") { for (const file of await uninstallDaemon(options)) console.log(`unloaded ${file}`); } else throw new Error("Usage: ctx daemon install | uninstall"); }

const [, , command, subcommand] = process.argv;
if (command === "api" && subcommand === "serve") {
  const socketPath = process.env.CTX_SOCKET_PATH ?? join(homedir(), ".ctx", "ctx.sock");
  const server = await startApiServer(socketPath);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} else if (command === "doctor") {
  console.log(JSON.stringify(await doctor(), null, 2));
} else if (command === "init") {
  await init();
} else if (command === "scan") {
  await scan(subcommand === "--project");
} else if (command === "search" && subcommand) {
  await search(subcommand);
} else if (command === "sync") {
  await sync(process.argv.slice(3));
} else if (command === "watch") {
  await watchCommand(process.argv.slice(3));
} else if (command === "serve") {
  await serve();
} else if (command === "daemon") {
  await daemon(subcommand);
} else if (command === "github" && subcommand === "login") {
  const result = await loginGithub();
  console.log(result.message);
} else {
  console.error("Usage: ctx init | ctx scan [--project] | ctx search <query> | ctx sync [--dry-run|--yes] | ctx watch [--yes] | ctx serve | ctx daemon install|uninstall | ctx api serve | ctx doctor | ctx github login");
  process.exitCode = 64;
}
