import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadSqliteVec } from "sqlite-vec";

const here = dirname(fileURLToPath(import.meta.url));
export const dataDir = resolve(process.env.NOVEL_STUDIO_DATA_DIR ?? resolve(here, "../../../data"));
mkdirSync(dataDir, { recursive: true });

export const sqlite = new Database(resolve(dataDir, "novel-studio.sqlite"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");
export let vectorAvailable = false;
try {
  loadSqliteVec(sqlite);
  vectorAvailable = true;
} catch {
  vectorAvailable = false;
}

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    genre TEXT NOT NULL DEFAULT '',
    premise TEXT NOT NULL DEFAULT '',
    target_words INTEGER NOT NULL DEFAULT 1000000,
    pov TEXT NOT NULL DEFAULT '第三人称限知',
    audience TEXT NOT NULL DEFAULT '中文网文读者',
    status TEXT NOT NULL DEFAULT 'planning',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    current_version_id TEXT,
    draft_json TEXT,
    draft_plain_text TEXT,
    draft_html TEXT,
    draft_updated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS document_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parent_version_id TEXT,
    content_json TEXT NOT NULL,
    plain_text TEXT NOT NULL,
    html TEXT NOT NULL DEFAULT '',
    word_count INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT 'manual',
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS volumes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position INTEGER NOT NULL,
    outline_document_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, position)
  );

  CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    outline_document_id TEXT,
    content_document_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(volume_id, position)
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL DEFAULT '',
    conflict TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(chapter_id, position)
  );

  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    aliases_json TEXT NOT NULL DEFAULT '[]',
    attributes_json TEXT NOT NULL DEFAULT '{}',
    visibility TEXT NOT NULL DEFAULT 'author',
    current_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS entity_versions (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    origin TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(entity_id, version)
  );

  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    subject_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
    predicate TEXT NOT NULL,
    object_text TEXT NOT NULL,
    valid_from_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
    valid_to_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
    source_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    source_version_id TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
    evidence TEXT NOT NULL DEFAULT '',
    fact_kind TEXT NOT NULL DEFAULT 'state',
    mutable INTEGER NOT NULL DEFAULT 1,
    confidence REAL NOT NULL DEFAULT 1,
    visibility TEXT NOT NULL DEFAULT 'author',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_conflicts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    proposal_id TEXT REFERENCES proposals(id) ON DELETE SET NULL,
    subject_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
    predicate TEXT NOT NULL,
    existing_fact_id TEXT REFERENCES facts(id) ON DELETE SET NULL,
    candidate_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS foreshadows (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    setup_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
    target_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
    resolved_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
    evidence TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chapter_summaries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    source_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    continuation_excerpt TEXT NOT NULL DEFAULT '',
    state_delta_json TEXT NOT NULL DEFAULT '{}',
    stale INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(chapter_id, source_version_id)
  );

  CREATE TABLE IF NOT EXISTS arc_summaries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    start_chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    end_chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    source_versions_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    open_threads_json TEXT NOT NULL DEFAULT '[]',
    stale INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, source_versions_json)
  );

  CREATE TABLE IF NOT EXISTS model_profiles (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL DEFAULT 'openai',
    model TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '',
    temperature REAL NOT NULL DEFAULT 0.7,
    max_output_tokens INTEGER NOT NULL DEFAULT 8192,
    input_price REAL,
    output_price REAL,
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    scene_id TEXT REFERENCES scenes(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    model_profile TEXT NOT NULL,
    model_snapshot_json TEXT NOT NULL DEFAULT '{}',
    instruction TEXT NOT NULL DEFAULT '',
    selection_json TEXT,
    context_snapshot_json TEXT NOT NULL DEFAULT '[]',
    prompt_snapshot TEXT NOT NULL DEFAULT '',
    base_version_id TEXT,
    output_text TEXT NOT NULL DEFAULT '',
    error TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    retry_of_job_id TEXT REFERENCES ai_jobs(id) ON DELETE SET NULL,
    decision_json TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    job_id TEXT REFERENCES ai_jobs(id) ON DELETE SET NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    base_version_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );

  CREATE TABLE IF NOT EXISTS review_findings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    job_id TEXT REFERENCES ai_jobs(id) ON DELETE SET NULL,
    document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '',
    suggestion TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    source_id UNINDEXED,
    project_id UNINDEXED,
    kind UNINDEXED,
    title,
    content,
    tokenize='trigram'
  );

  CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    model_key TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    embedding TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS embedding_query_cache (
    id TEXT PRIMARY KEY,
    model_key TEXT NOT NULL,
    query_hash TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    embedding TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(model_key, query_hash)
  );

  CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
  CREATE INDEX IF NOT EXISTS idx_versions_document ON document_versions(document_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id);
  CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project_id, type);
  CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project_id, status);
  CREATE INDEX IF NOT EXISTS idx_memory_conflicts_project ON memory_conflicts(project_id, status);
  CREATE INDEX IF NOT EXISTS idx_jobs_project ON ai_jobs(project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_proposals_project ON proposals(project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_embeddings_project ON knowledge_embeddings(project_id, dimensions);
`);

function ensureColumn(table: string, name: string, definition: string) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

ensureColumn("facts", "fact_kind", "TEXT NOT NULL DEFAULT 'state'");
ensureColumn("facts", "mutable", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("ai_jobs", "scene_id", "TEXT REFERENCES scenes(id) ON DELETE SET NULL");
ensureColumn("ai_jobs", "selection_json", "TEXT");
ensureColumn("ai_jobs", "decision_json", "TEXT");
ensureColumn("chapter_summaries", "continuation_excerpt", "TEXT NOT NULL DEFAULT ''");

const now = new Date().toISOString();
const profileDefaults = [
  ["planner", 0.55, 8192],
  ["writer", 0.85, 12288],
  ["reviewer", 0.25, 6144],
  ["extractor", 0.15, 6144],
  ["embedder", 0, 1024],
] as const;

const insertProfile = sqlite.prepare(`
  INSERT OR IGNORE INTO model_profiles
    (id, role, provider, model, temperature, max_output_tokens, enabled, updated_at)
  VALUES (?, ?, 'openai', '', ?, ?, 0, ?)
`);
for (const [role, temperature, maxTokens] of profileDefaults) {
  insertProfile.run(randomUUID(), role, temperature, maxTokens, now);
}

sqlite.prepare("UPDATE ai_jobs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now);
sqlite.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '4')").run();

export function newId() {
  return randomUUID();
}

export function isoNow() {
  return new Date().toISOString();
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function countHanWords(text: string) {
  const han = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z0-9]+/g)?.length ?? 0;
  return han + latin;
}

export function ensureCredentialFilePermissions(path: string) {
  try {
    chmodSync(path, 0o600);
  } catch {
    // The file may not exist yet.
  }
}
