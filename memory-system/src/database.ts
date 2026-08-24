import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { load as loadSqliteVec } from "sqlite-vec";

const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, series_key TEXT NOT NULL DEFAULT 'standalone',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('setting','prose','outline')),
  content TEXT NOT NULL, content_hash TEXT NOT NULL, chapter TEXT, scene TEXT, story_time TEXT,
  reveal_order INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','reviewing','blocked','committed','failed','rejected')),
  error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(project_id, content_hash, source_kind)
);
CREATE TABLE IF NOT EXISTS source_versions(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id), title TEXT NOT NULL,
  source_kind TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
  chapter TEXT, scene TEXT, story_time TEXT, reveal_order INTEGER NOT NULL, committed_at TEXT NOT NULL,
  UNIQUE(project_id, content_hash, source_kind)
);
CREATE TABLE IF NOT EXISTS source_chunks(
  id TEXT PRIMARY KEY, source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, content TEXT NOT NULL,
  content_hash TEXT NOT NULL, chapter_label TEXT, UNIQUE(source_version_id, seq)
);
CREATE VIRTUAL TABLE IF NOT EXISTS source_chunks_fts USING fts5(chunk_id UNINDEXED, project_id UNINDEXED, title, content, tokenize='trigram');
CREATE TABLE IF NOT EXISTS entities(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, normalized_name TEXT NOT NULL, entity_type TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL, UNIQUE(project_id, normalized_name)
);
CREATE TABLE IF NOT EXISTS entity_aliases(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id, normalized_alias)
);
CREATE TABLE IF NOT EXISTS submission_candidates(
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, scope TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
  perspective TEXT, story_time_start TEXT, story_time_end TEXT, confidence REAL NOT NULL,
  thread_key TEXT, lifecycle TEXT NOT NULL, span_start INTEGER NOT NULL, span_end INTEGER NOT NULL,
  span_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id), candidate_id TEXT REFERENCES submission_candidates(id),
  kind TEXT NOT NULL, scope TEXT NOT NULL, subject_entity_id TEXT NOT NULL REFERENCES entities(id),
  subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, object_entity_id TEXT REFERENCES entities(id),
  perspective_entity_id TEXT REFERENCES entities(id), perspective TEXT, story_time_start TEXT, story_time_end TEXT,
  reveal_order INTEGER NOT NULL, lifecycle TEXT NOT NULL, confidence REAL NOT NULL,
  thread_key TEXT, span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, span_text TEXT NOT NULL,
  disputed INTEGER NOT NULL DEFAULT 0, intentional_conflict INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT NOT NULL, valid_until TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_lookup ON memories(project_id, subject, predicate, scope, valid_until, disputed);
CREATE INDEX IF NOT EXISTS idx_memories_time ON memories(project_id, story_time_start, story_time_end, reveal_order);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, project_id UNINDEXED, subject, predicate, object, span_text, tokenize='trigram');
CREATE TABLE IF NOT EXISTS memory_edges(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_entity_id TEXT NOT NULL REFERENCES entities(id), to_entity_id TEXT NOT NULL REFERENCES entities(id),
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, relation TEXT NOT NULL, UNIQUE(memory_id, from_entity_id, to_entity_id)
);
CREATE TABLE IF NOT EXISTS memory_embeddings(
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model_key TEXT NOT NULL, dimensions INTEGER NOT NULL, embedding TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS summaries(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  level TEXT NOT NULL, owner_key TEXT NOT NULL, content TEXT NOT NULL, source_hash TEXT NOT NULL,
  valid INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE(project_id, level, owner_key)
);
CREATE TABLE IF NOT EXISTS conflicts(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  submission_id TEXT REFERENCES submissions(id), candidate_id TEXT REFERENCES submission_candidates(id),
  existing_memory_id TEXT REFERENCES memories(id), later_memory_id TEXT REFERENCES memories(id),
  severity TEXT NOT NULL, category TEXT NOT NULL, impact_key TEXT NOT NULL, explanation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', resolution_action TEXT, resolution_note TEXT,
  created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conflicts_open ON conflicts(project_id, status, impact_key);
CREATE TABLE IF NOT EXISTS resolutions(
  id TEXT PRIMARY KEY, conflict_id TEXT NOT NULL REFERENCES conflicts(id), project_id TEXT NOT NULL REFERENCES projects(id),
  action TEXT NOT NULL, note TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS line_blocks(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  impact_key TEXT NOT NULL, conflict_id TEXT NOT NULL REFERENCES conflicts(id), created_at TEXT NOT NULL,
  UNIQUE(project_id, impact_key, conflict_id)
);
CREATE TABLE IF NOT EXISTS retrieval_traces(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_json TEXT NOT NULL, candidates_json TEXT NOT NULL, selected_json TEXT NOT NULL,
  omitted_json TEXT NOT NULL, token_budget INTEGER NOT NULL, token_used INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_configs(
  role TEXT PRIMARY KEY, base_url TEXT NOT NULL, model TEXT NOT NULL, temperature REAL NOT NULL,
  max_output_tokens INTEGER NOT NULL, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_cache(
  cache_key TEXT PRIMARY KEY, role TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS job_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, project_id TEXT NOT NULL,
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TEXT NOT NULL, locked_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, status, created_at);
CREATE TABLE IF NOT EXISTS model_request_metrics(
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, operation TEXT NOT NULL,
  cache_hit INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, http_status INTEGER,
  error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_metrics_time ON model_request_metrics(created_at, role, operation);
CREATE TABLE IF NOT EXISTS benchmark_runs(
  id TEXT PRIMARY KEY, project_id TEXT, status TEXT NOT NULL, target_chars INTEGER NOT NULL,
  report_json TEXT, error TEXT, created_at TEXT NOT NULL, finished_at TEXT
);
`;

export function openDatabase(file = resolve(process.env.MEMORY_DATA_DIR ?? resolve(process.cwd(), "memory-system-data"), "memory.sqlite")) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  try { loadSqliteVec(db); } catch { /* FTS and graph retrieval remain available. */ }
  db.exec(schema);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
  return db;
}

export type MemoryDatabase = ReturnType<typeof openDatabase>;
