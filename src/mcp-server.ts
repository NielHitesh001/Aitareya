import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.ts";
import { withinTokenBudget } from "./rank.ts";
import { Store } from "./store.ts";

type ServerOptions = { configPath: string; storePath: string; log?: (message: string) => void };
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object."); return value as Record<string, unknown>; }
function only(args: Record<string, unknown>, fields: readonly string[]) { if (Object.keys(args).some((key) => !fields.includes(key))) throw new McpError(ErrorCode.InvalidParams, "Unknown argument."); }
function optionalString(value: unknown, name: string): string | undefined { if (value === undefined) return undefined; if (typeof value !== "string") throw new McpError(ErrorCode.InvalidParams, `${name} must be a string.`); return value; }
function optionalLimit(value: unknown): number | undefined { if (value === undefined) return undefined; if (!Number.isInteger(value) || (value as number) < 1) throw new McpError(ErrorCode.InvalidParams, "limit must be a positive integer."); return value as number; }
const tools = [
  { name: "ctx_search", description: "Search local ctx index.", inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string" }, project: { type: "string" }, limit: { type: "integer", minimum: 1 } } } },
  { name: "ctx_decisions", description: "List indexed decisions.", inputSchema: { type: "object", additionalProperties: false, properties: { project: { type: "string" } } } },
  { name: "ctx_projects", description: "List registered projects.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
];

export async function startMcpServer(options: ServerOptions): Promise<Server> {
  const server = new Server({ name: "ctx", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = object(request.params.arguments ?? {}); const config = await loadConfig(options.configPath); const store = new Store({ path: options.storePath });
    try {
      if (request.params.name === "ctx_search") { only(args, ["query", "project", "limit"]); const query = optionalString(args.query, "query"); if (!query) throw new McpError(ErrorCode.InvalidParams, "query is required."); const project = optionalString(args.project, "project"); const limit = optionalLimit(args.limit); const fts = store.searchChunks(query).filter((chunk) => !project || chunk.project === project).map(({ content, ...chunk }) => ({ ...chunk, text: content })); const results = withinTokenBudget({ fts }).slice(0, limit); options.log?.(`ctx_search ${results.length}`); return { content: [{ type: "text", text: JSON.stringify(results.map(({ project, path, startLine, endLine, sourceType, text }) => ({ project, provenance: `${path}:${startLine}-${endLine}`, sourceType, text }))) }] }; }
      if (request.params.name === "ctx_decisions") { only(args, ["project"]); const project = optionalString(args.project, "project"); const results = store.decisionChunks(project); options.log?.(`ctx_decisions ${results.length}`); return { content: [{ type: "text", text: JSON.stringify(results) }] }; }
      if (request.params.name === "ctx_projects") { only(args, []); const results = store.projectStatuses(config.projects); options.log?.(`ctx_projects ${results.length}`); return { content: [{ type: "text", text: JSON.stringify(results) }] }; }
      throw new McpError(ErrorCode.MethodNotFound, "Unknown tool.");
    } finally { store.close(); }
  });
  await server.connect(new StdioServerTransport()); return server;
}
