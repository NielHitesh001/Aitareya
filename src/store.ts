import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const storeSchemaVersion = 2;

export type StoreOptions = { path?: string };
export type SearchResult = { path: string; content: string };
export type ProvenanceSearchResult = { id: string; project: string; path: string; content: string; startLine: number; endLine: number; sourceType: "rule" | "decision" | "doc" | "code" | "commit" };
export type ChunkInput = { project: string; path: string; content: string; startLine: number; endLine: number; sourceType: "rule" | "decision" | "doc" | "code" | "commit"; hash: string; commitSha?: string };

/**
 * Local index store. `vec_documents` is deliberately pending: it is introduced
 * only with the embeddings step, when sqlite-vec is available.
 */
export class Store {
  private readonly database: DatabaseSync;

  constructor(options: StoreOptions = {}) {
    const path = options.path ?? resolve(homedir(), ".ctx/index.db");
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.initialize();
  }

  close(): void { this.database.close(); }

  upsertDocument(path: string, content: string): void {
    this.upsertChunk({ project: "legacy", path, content, startLine: 1, endLine: content.split("\n").length, sourceType: "doc", hash: "legacy" });
  }

  upsertChunk(chunk: ChunkInput): void {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const projectId = this.projectId(chunk.project);
      this.database.prepare("INSERT INTO documents(project_id, path, content, start_line, end_line, source_type, hash, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, path, start_line, end_line, source_type, commit_sha) DO UPDATE SET content = excluded.content, hash = excluded.hash, updated_at = unixepoch()")
        .run(projectId, chunk.path, chunk.content, chunk.startLine, chunk.endLine, chunk.sourceType, chunk.hash, chunk.commitSha ?? "");
      const row = this.database.prepare("SELECT id FROM documents WHERE project_id = ? AND path = ? AND start_line = ? AND end_line = ? AND source_type = ? AND commit_sha = ?").get(projectId, chunk.path, chunk.startLine, chunk.endLine, chunk.sourceType, chunk.commitSha ?? "") as { id: number };
      this.database.prepare("DELETE FROM documents_fts WHERE rowid = ?").run(row.id);
      this.database.prepare("INSERT INTO documents_fts(rowid, path, content) VALUES (?, ?, ?)").run(row.id, chunk.path, chunk.content);
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  projectId(path: string): number {
    this.database.prepare("INSERT INTO projects(path) VALUES (?) ON CONFLICT(path) DO NOTHING").run(path);
    return (this.database.prepare("SELECT id FROM projects WHERE path = ?").get(path) as { id: number }).id;
  }

  fileHash(project: string, path: string): string | undefined {
    const row = this.database.prepare("SELECT hash FROM file_hashes WHERE project_id = ? AND path = ?").get(this.projectId(project), path) as { hash: string } | undefined;
    return row?.hash;
  }

  setFileHash(project: string, path: string, hash: string): void {
    this.database.prepare("INSERT INTO file_hashes(project_id, path, hash) VALUES (?, ?, ?) ON CONFLICT(project_id, path) DO UPDATE SET hash = excluded.hash, updated_at = unixepoch()").run(this.projectId(project), path, hash);
  }

  removeFile(project: string, path: string): void {
    const projectId = this.projectId(project);
    const rows = this.database.prepare("SELECT id FROM documents WHERE project_id = ? AND path = ?").all(projectId, path) as Array<{ id: number }>;
    for (const row of rows) this.database.prepare("DELETE FROM documents_fts WHERE rowid = ?").run(row.id);
    this.database.prepare("DELETE FROM documents WHERE project_id = ? AND path = ?").run(projectId, path);
    this.database.prepare("DELETE FROM file_hashes WHERE project_id = ? AND path = ?").run(projectId, path);
  }

  indexedPaths(project: string): string[] {
    return (this.database.prepare("SELECT path FROM file_hashes WHERE project_id = ?").all(this.projectId(project)) as Array<{ path: string }>).map((row) => row.path);
  }

  cacheGet(key: string): string | undefined { return (this.database.prepare("SELECT value FROM meta WHERE key = ?").get(`cache:${key}`) as { value: string } | undefined)?.value; }
  cacheSet(key: string, value: string): void { this.database.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`cache:${key}`, value); }

  searchDocuments(query: string): SearchResult[] {
    return (this.database.prepare("SELECT path, content FROM documents_fts WHERE documents_fts MATCH ? ORDER BY rank")
      .all(query) as SearchResult[]).map((row) => ({ path: row.path, content: row.content }));
  }

  searchChunks(query: string): ProvenanceSearchResult[] {
    return (this.database.prepare("SELECT d.id, p.path AS project, d.path, d.content, d.start_line AS startLine, d.end_line AS endLine, d.source_type AS sourceType FROM documents_fts f JOIN documents d ON d.id = f.rowid JOIN projects p ON p.id = d.project_id WHERE documents_fts MATCH ? ORDER BY rank").all(query) as ProvenanceSearchResult[]).map((row) => ({ ...row }));
  }

  contextChunks(project: string): ProvenanceSearchResult[] {
    return (this.database.prepare("SELECT d.id, p.path AS project, d.path, d.content, d.start_line AS startLine, d.end_line AS endLine, d.source_type AS sourceType FROM documents d JOIN projects p ON p.id = d.project_id WHERE p.path = ? AND d.source_type IN ('rule', 'decision') ORDER BY d.updated_at DESC, d.id DESC").all(project) as ProvenanceSearchResult[]).map((row) => ({ ...row }));
  }

  decisionChunks(project?: string): ProvenanceSearchResult[] {
    const sql = "SELECT d.id, p.path AS project, d.path, d.content, d.start_line AS startLine, d.end_line AS endLine, d.source_type AS sourceType FROM documents d JOIN projects p ON p.id = d.project_id WHERE d.source_type = 'decision'" + (project ? " AND p.path = ?" : "") + " ORDER BY d.updated_at DESC, d.id DESC";
    return (this.database.prepare(sql).all(...(project ? [project] : [])) as ProvenanceSearchResult[]).map((row) => ({ ...row }));
  }

  projectStatuses(projects: readonly string[]): Array<{ project: string; lastScanAt: number | null }> {
    const statement = this.database.prepare("SELECT MAX(d.updated_at) AS lastScanAt FROM projects p LEFT JOIN documents d ON d.project_id = p.id WHERE p.path = ?");
    return projects.map((project) => ({ project, lastScanAt: (statement.get(project) as { lastScanAt: number | null }).lastScanAt }));
  }

  private initialize(): void {
    const existing = this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (existing) {
      const version = this.database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      if (!version || Number(version.value) !== storeSchemaVersion) this.versionMismatch();
      return;
    }
    this.database.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id),
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('rule', 'decision', 'doc', 'code', 'commit')),
        hash TEXT NOT NULL,
        commit_sha TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(project_id, path, start_line, end_line, source_type, commit_sha)
      );
      CREATE VIRTUAL TABLE documents_fts USING fts5(path, content);
      CREATE TABLE file_hashes (
        project_id INTEGER NOT NULL REFERENCES projects(id),
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (project_id, path)
      );
    `);
    this.database.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(String(storeSchemaVersion));
  }

  private versionMismatch(): never {
    this.database.close();
    throw new Error("Index schema version mismatch. Delete ~/.ctx/index.db; `ctx scan --rebuild` will be available in step 7.");
  }
}
