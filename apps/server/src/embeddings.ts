import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embed, embedMany } from "ai";
import { createHash } from "node:crypto";
import { getCredential } from "./credentials.js";
import { isoNow, newId, sqlite, vectorAvailable } from "./db.js";

type Row = Record<string, unknown>;

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function embeddingProfile() {
  return sqlite.prepare("SELECT * FROM model_profiles WHERE role='embedder' AND enabled=1").get() as Row | undefined;
}

function embeddingModel(profile: Row) {
  const apiKey = getCredential("embedder");
  if (!apiKey) throw new Error("向量模型尚未配置 API Key");
  const model = String(profile.model || "");
  if (!model) throw new Error("向量模型尚未配置模型名");
  const baseURL = String(profile.base_url || "") || undefined;
  if (profile.provider === "anthropic") throw new Error("Anthropic 不提供嵌入模型，请为 embedder 选择 OpenAI 或兼容接口");
  if (profile.provider === "openai-compatible") {
    if (!baseURL) throw new Error("OpenAI-compatible 向量模型需要 Base URL");
    return createOpenAICompatible({ name: "novel-studio-embedder", apiKey, baseURL }).textEmbeddingModel(model);
  }
  return createOpenAI({ apiKey, baseURL }).embedding(model);
}

function modelKey(profile: Row) {
  return `${profile.provider}:${profile.base_url || "default"}:${profile.model}`;
}

function chunkText(text: string, maxChars = 1400, overlap = 160) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    let end = Math.min(normalized.length, cursor + maxChars);
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf("\n", end), normalized.lastIndexOf("。", end), normalized.lastIndexOf("！", end), normalized.lastIndexOf("？", end));
      if (boundary > cursor + maxChars * 0.55) end = boundary + 1;
    }
    chunks.push(normalized.slice(cursor, end).trim());
    if (end >= normalized.length) break;
    cursor = Math.max(cursor + 1, end - overlap);
  }
  return chunks.filter(Boolean);
}

function sources(projectId: string, sourceId?: string | null, sourceKind?: string | null) {
  const documents = sourceKind === "entity" ? [] : sqlite.prepare(`SELECT d.id,d.kind,d.title,v.plain_text AS content
    FROM documents d JOIN document_versions v ON v.id=d.current_version_id WHERE d.project_id=? ${sourceId ? "AND d.id=?" : ""}`)
    .all(...(sourceId ? [projectId, sourceId] : [projectId])) as Row[];
  const entities = sourceKind === "document" ? [] : sqlite.prepare(`SELECT id,'entity:'||type AS kind,name AS title,name||char(10)||summary||char(10)||attributes_json AS content
    FROM entities WHERE project_id=? ${sourceId ? "AND id=?" : ""}`)
    .all(...(sourceId ? [projectId, sourceId] : [projectId])) as Row[];
  return [...documents, ...entities];
}

export async function rebuildEmbeddings(input: { projectId: string; sourceId?: string | null; sourceKind?: string | null; abortSignal?: AbortSignal }) {
  if (!vectorAvailable) throw new Error("当前平台无法加载 sqlite-vec，已保留全文检索能力");
  const profile = embeddingProfile();
  if (!profile) throw new Error("向量模型尚未启用");
  const model = embeddingModel(profile);
  const key = modelKey(profile);
  let tokens = 0;
  let chunksWritten = 0;
  for (const source of sources(input.projectId, input.sourceId, input.sourceKind)) {
    if (input.abortSignal?.aborted) throw new Error("向量任务已取消");
    const chunks = chunkText(String(source.content ?? ""));
    sqlite.prepare("DELETE FROM knowledge_embeddings WHERE project_id=? AND source_id=?").run(input.projectId, source.id);
    if (!chunks.length) continue;
    const result = await embedMany({ model, values: chunks, abortSignal: input.abortSignal, maxRetries: 3, maxParallelCalls: 3 });
    tokens += result.usage.tokens;
    const insert = sqlite.prepare(`INSERT INTO knowledge_embeddings(id,source_id,project_id,kind,title,content,content_hash,model_key,dimensions,embedding,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    sqlite.transaction(() => {
      result.embeddings.forEach((embedding, index) => {
        const content = chunks[index] ?? "";
        insert.run(newId(), source.id, input.projectId, source.kind, source.title, content, hash(content), key, embedding.length, JSON.stringify(embedding), isoNow());
        chunksWritten += 1;
      });
    })();
  }
  return { tokens, chunksWritten };
}

export async function searchSemantic(projectId: string, query: string, limit = 8) {
  if (!vectorAvailable || query.trim().length < 2) return [];
  const profile = embeddingProfile();
  if (!profile) return [];
  const key = modelKey(profile);
  const queryHash = hash(query.trim());
  let cached = sqlite.prepare("SELECT embedding,dimensions FROM embedding_query_cache WHERE model_key=? AND query_hash=?").get(key, queryHash) as { embedding: string; dimensions: number } | undefined;
  if (!cached) {
    const result = await embed({ model: embeddingModel(profile), value: query.trim(), maxRetries: 3 });
    cached = { embedding: JSON.stringify(result.embedding), dimensions: result.embedding.length };
    sqlite.prepare("INSERT OR REPLACE INTO embedding_query_cache(id,model_key,query_hash,dimensions,embedding,created_at) VALUES (?,?,?,?,?,?)")
      .run(newId(), key, queryHash, cached.dimensions, cached.embedding, isoNow());
  }
  try {
    return sqlite.prepare(`SELECT source_id AS sourceId,kind,title,content AS excerpt,vec_distance_cosine(embedding,?) AS distance
      FROM knowledge_embeddings WHERE project_id=? AND model_key=? AND dimensions=? ORDER BY distance LIMIT ?`)
      .all(cached.embedding, projectId, key, cached.dimensions, limit) as Row[];
  } catch {
    return [];
  }
}

export function enqueueEmbeddingJob(projectId: string, sourceId?: string | null, sourceKind?: "document" | "entity" | null) {
  const profile = embeddingProfile();
  if (!profile || !vectorAvailable) return null;
  const instruction = JSON.stringify({ sourceId: sourceId ?? null, sourceKind: sourceKind ?? null });
  const existing = sqlite.prepare("SELECT id FROM ai_jobs WHERE project_id=? AND type='embed_knowledge' AND status IN ('queued','running') AND instruction=?")
    .get(projectId, instruction) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = newId();
  sqlite.prepare(`INSERT INTO ai_jobs(id,project_id,type,status,model_profile,instruction,context_snapshot_json,created_at)
    VALUES (?,?,'embed_knowledge','queued','embedder',?,'[]',?)`).run(id, projectId, instruction, isoNow());
  return id;
}

export function embeddingStatus(projectId: string) {
  const profile = embeddingProfile();
  const indexedSources = (sqlite.prepare("SELECT COUNT(DISTINCT source_id) AS count FROM knowledge_embeddings WHERE project_id=?").get(projectId) as { count: number }).count;
  const totalSources = (sqlite.prepare("SELECT (SELECT COUNT(*) FROM documents WHERE project_id=?)+(SELECT COUNT(*) FROM entities WHERE project_id=?) AS count").get(projectId, projectId) as { count: number }).count;
  return { vectorAvailable, enabled: Boolean(profile), indexedSources, totalSources, model: profile?.model ?? "" };
}

