import type { MemoryDatabase } from "./database.js";
import { newId, nowIso, normalizeName, estimateTokens } from "./ids.js";
import { OpenAiCompatibleModels } from "./models.js";
import type { ContextItem, ContextPack, ContextRequest, EpistemicScope, MemoryKind } from "./types.js";

export interface RetrievalModelProvider {
  embed?(value: string): Promise<number[] | null>;
}

export interface EmbeddingIndexResult {
  indexed: number;
  skipped: number;
  failed: Array<{ memoryId: string; error: string }>;
}

interface MemoryCandidateRow {
  id: string;
  projectId: string;
  sourceTitle: string;
  kind: MemoryKind;
  scope: EpistemicScope;
  subject: string;
  predicate: string;
  object: string;
  perspective: string | null;
  storyTimeStart: string | null;
  storyTimeEnd: string | null;
  revealOrder: number;
  lifecycle: string;
  spanStart: number;
  spanEnd: number;
  spanText: string;
  disputed: number;
  ftsScore?: number;
}

interface ScoredMemory extends MemoryCandidateRow {
  score: number;
  bucket: keyof Pick<ContextPack, "hardConstraints" | "worldState" | "povKnowledge" | "readerRevealed" | "relevantHistory" | "openCommitments" | "planDrift" | "disputes">;
  reason: string;
}

const bucketPriority: Record<ScoredMemory["bucket"], number> = {
  hardConstraints: 100,
  disputes: 95,
  povKnowledge: 80,
  worldState: 75,
  readerRevealed: 65,
  openCommitments: 60,
  planDrift: 50,
  relevantHistory: 40,
};

export class RetrievalService {
  private readonly models: RetrievalModelProvider;

  constructor(private readonly db: MemoryDatabase, models?: RetrievalModelProvider) {
    this.models = models ?? new OpenAiCompatibleModels(db);
  }

  async indexEmbeddings(projectId: string, memoryIds?: string[]): Promise<EmbeddingIndexResult> {
    this.assertProject(projectId);
    if (!this.models.embed) return { indexed: 0, skipped: memoryIds?.length ?? 0, failed: [] };
    const clauses = ["m.project_id=?", "m.valid_until IS NULL"];
    const params: unknown[] = [projectId];
    if (memoryIds && memoryIds.length > 0) {
      clauses.push(`m.id IN (${memoryIds.map(() => "?").join(",")})`);
      params.push(...memoryIds);
    }
    const rows = this.db.prepare(`SELECT m.id,m.subject,m.predicate,m.object,m.span_text AS spanText
      FROM memories m WHERE ${clauses.join(" AND ")} ORDER BY m.created_at,m.id`).all(...params) as Array<{ id: string; subject: string; predicate: string; object: string; spanText: string }>;
    let indexed = 0;
    let skipped = 0;
    const failed: Array<{ memoryId: string; error: string }> = [];
    for (const row of rows) {
      try {
        const vector = await this.models.embed(`${row.subject} ${row.predicate} ${row.object}\n证据：${row.spanText}`);
        if (!vector || vector.length === 0) { skipped += 1; continue; }
        this.db.prepare(`INSERT INTO memory_embeddings(memory_id,model_key,dimensions,embedding,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(memory_id) DO UPDATE SET model_key=excluded.model_key,dimensions=excluded.dimensions,embedding=excluded.embedding,updated_at=excluded.updated_at`)
          .run(row.id, "configured", vector.length, JSON.stringify(vector), nowIso());
        indexed += 1;
      } catch (error) {
        failed.push({ memoryId: row.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { indexed, skipped, failed };
  }

  async compileContext(projectId: string, request: ContextRequest): Promise<ContextPack> {
    this.assertProject(projectId);
    if (!Number.isInteger(request.tokenBudget) || request.tokenBudget <= 0) throw new Error("tokenBudget 必须是正整数");
    const query = this.queryText(request);
    const structured = this.loadStructured(projectId, request);
    const ftsScores = this.loadFtsScores(projectId, query);
    const embedding = this.models.embed ? await this.models.embed(query) : null;
    const embeddingScores = embedding ? this.loadEmbeddingScores(projectId, embedding) : new Map<string, number>();
    const rows = this.mergeRows(structured, ftsScores);
    const openDisputeIds = this.loadOpenDisputeIds(projectId);
    const scored = rows.map((row) => this.score(row, request, query, ftsScores.get(row.id) ?? 0, openDisputeIds.has(row.id), embeddingScores.get(row.id) ?? 0));
    scored.sort((a, b) => bucketPriority[b.bucket] - bucketPriority[a.bucket] || b.score - a.score || a.revealOrder - b.revealOrder || a.id.localeCompare(b.id));

    const pack: ContextPack = {
      hardConstraints: [], worldState: [], povKnowledge: [], readerRevealed: [], relevantHistory: [], openCommitments: [], planDrift: [], disputes: [],
      tokenBudget: request.tokenBudget, tokenUsed: 0, omitted: [], insufficientEvidence: [], traceId: newId(),
    };
    const selected: Array<{ memoryId: string; bucket: string; score: number }> = [];
    const candidates = scored.map((row) => ({ memoryId: row.id, score: row.score, bucket: row.bucket, reason: row.reason }));
    for (const row of scored) {
      const item = this.toContextItem(row);
      const itemTokens = estimateTokens(item.text + "\n证据：" + item.quote);
      if (itemTokens > request.tokenBudget - pack.tokenUsed) {
        pack.omitted.push({ memoryId: row.id, reason: row.bucket === "disputes" ? "争议证据超过剩余 token 预算" : "超出 token 预算" });
        continue;
      }
      pack[row.bucket].push(item);
      pack.tokenUsed += itemTokens;
      selected.push({ memoryId: row.id, bucket: row.bucket, score: row.score });
    }
    if (scored.length === 0) pack.insufficientEvidence.push("没有找到与当前请求相关的已确认记忆");
    if (request.intent === "evidence" && pack.tokenUsed === 0) pack.insufficientEvidence.push("当前请求没有可引用的证据");
    if ((request.intent === "scene_generation" || request.intent === "current_state") && pack.worldState.length === 0 && pack.hardConstraints.length === 0) {
      pack.insufficientEvidence.push("当前场景缺少足够的世界状态证据");
    }
    this.db.prepare(`INSERT INTO retrieval_traces(id,project_id,request_json,candidates_json,selected_json,omitted_json,token_budget,token_used,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(pack.traceId, projectId, JSON.stringify(request), JSON.stringify(candidates), JSON.stringify(selected), JSON.stringify(pack.omitted),
      request.tokenBudget, pack.tokenUsed, nowIso());
    return pack;
  }

  private assertProject(projectId: string) {
    const row = this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId) as { id: string } | undefined;
    if (!row) throw new Error(`项目不存在: ${projectId}`);
  }

  private queryText(request: ContextRequest): string {
    return [request.instruction, request.recentText ?? "", request.location ?? "", request.pov ?? "", ...(request.mentionedEntities ?? [])].filter(Boolean).join(" ");
  }

  private loadStructured(projectId: string, request: ContextRequest): MemoryCandidateRow[] {
    const entities = (request.mentionedEntities ?? []).map((item) => item.trim()).filter(Boolean);
    const clauses = ["m.project_id=?", "m.valid_until IS NULL"];
    const params: unknown[] = [projectId];
    if (entities.length > 0) {
      clauses.push(`(${entities.map(() => "lower(m.subject)=lower(?) OR lower(m.object)=lower(?) OR lower(coalesce(m.perspective,''))=lower(?)").join(" OR ")})`);
      for (const entity of entities) params.push(entity, entity, entity);
    }
    const rows = this.db.prepare(`SELECT m.id,m.project_id AS projectId,sv.title AS sourceTitle,m.kind,m.scope,m.subject,m.predicate,m.object,m.perspective,
        m.story_time_start AS storyTimeStart,m.story_time_end AS storyTimeEnd,m.reveal_order AS revealOrder,m.lifecycle,
        m.span_start AS spanStart,m.span_end AS spanEnd,m.span_text AS spanText,m.disputed
      FROM memories m JOIN source_versions sv ON sv.id=m.source_version_id WHERE ${clauses.join(" AND ")}
      ORDER BY m.reveal_order DESC,m.created_at DESC LIMIT 5000`).all(...params) as MemoryCandidateRow[];
    return rows;
  }

  private loadFtsScores(projectId: string, query: string): Map<string, number> {
    const result = new Map<string, number>();
    const terms = query.split(/[^\p{L}\p{N}_·]+/u).map((term) => term.trim()).filter((term) => term.length >= 2).slice(0, 24);
    if (terms.length === 0) return result;
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    try {
      const rows = this.db.prepare(`SELECT memory_id AS memoryId,bm25(memories_fts) AS score FROM memories_fts
        WHERE project_id=? AND memories_fts MATCH ? ORDER BY score LIMIT 500`).all(projectId, match) as Array<{ memoryId: string; score: number }>;
      for (const row of rows) result.set(row.memoryId, Math.max(0, 10 - Number(row.score)));
    } catch {
      // Invalid or unsupported FTS queries degrade to structured retrieval.
    }
    return result;
  }

  private mergeRows(structured: MemoryCandidateRow[], ftsScores: Map<string, number>): MemoryCandidateRow[] {
    const byId = new Map(structured.map((row) => [row.id, row]));
    if (ftsScores.size > 0) {
      const ids = [...ftsScores.keys()].filter((id) => !byId.has(id));
      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        const rows = this.db.prepare(`SELECT m.id,m.project_id AS projectId,sv.title AS sourceTitle,m.kind,m.scope,m.subject,m.predicate,m.object,m.perspective,
            m.story_time_start AS storyTimeStart,m.story_time_end AS storyTimeEnd,m.reveal_order AS revealOrder,m.lifecycle,
            m.span_start AS spanStart,m.span_end AS spanEnd,m.span_text AS spanText,m.disputed
          FROM memories m JOIN source_versions sv ON sv.id=m.source_version_id WHERE m.id IN (${placeholders}) AND m.valid_until IS NULL`).all(...ids) as MemoryCandidateRow[];
        for (const row of rows) byId.set(row.id, row);
      }
    }
    return [...byId.values()];
  }

  private loadOpenDisputeIds(projectId: string): Set<string> {
    const rows = this.db.prepare(`SELECT existing_memory_id AS memoryId FROM conflicts WHERE project_id=? AND status='open' AND existing_memory_id IS NOT NULL`).all(projectId) as Array<{ memoryId: string }>;
    return new Set(rows.map((row) => row.memoryId));
  }

  private loadEmbeddingScores(projectId: string, queryVector: number[]): Map<string, number> {
    const scores = new Map<string, number>();
    const rows = this.db.prepare(`SELECT me.memory_id AS memoryId,me.embedding FROM memory_embeddings me
      JOIN memories m ON m.id=me.memory_id WHERE m.project_id=? AND m.valid_until IS NULL`).all(projectId) as Array<{ memoryId: string; embedding: string }>;
    for (const row of rows) {
      try {
        const vector = JSON.parse(row.embedding) as unknown;
        if (!Array.isArray(vector)) continue;
        const score = cosineSimilarity(queryVector, vector.filter((value): value is number => typeof value === "number"));
        scores.set(row.memoryId, Math.max(0, score) * 20);
      } catch {
        // A malformed cached vector is ignored until the next index run.
      }
    }
    return scores;
  }

  private score(row: MemoryCandidateRow, request: ContextRequest, query: string, ftsScore: number, disputed: boolean, embeddingScore: number): ScoredMemory {
    const normalizedQuery = normalizeName(query);
    const subject = normalizeName(row.subject);
    const object = normalizeName(row.object);
    const normalizedInstruction = normalizeName(request.instruction);
    let score = ftsScore;
    let reason = "结构化字段匹配";
    if (normalizedQuery.includes(subject)) score += 6;
    if (normalizedQuery.includes(object)) score += 4;
    if (request.mentionedEntities?.some((entity) => normalizeName(entity) === subject || normalizeName(entity) === object)) score += 8;
    if (request.location && (normalizeName(request.location) === object || normalizeName(request.location) === subject)) score += 5;
    if (request.pov && normalizeName(request.pov) === normalizeName(row.perspective ?? "")) score += 6;
    if (request.storyTime && (row.storyTimeStart === request.storyTime || row.storyTimeEnd === request.storyTime)) score += 4;
    if (normalizedInstruction.includes(normalizeName(row.predicate))) score += 3;
    score += embeddingScore;
    if (row.scope === "world_truth") score += 2;
    if (disputed || row.disputed) return { ...row, ftsScore, score: score + 20, bucket: "disputes", reason: "存在未解决冲突或已标记争议" };
    if (row.kind === "world_rule" || row.kind === "style_constraint") return { ...row, ftsScore, score: score + 12, bucket: "hardConstraints", reason: "硬约束" };
    if (row.scope === "author_plan") return { ...row, ftsScore, score, bucket: "planDrift", reason: "作者计划" };
    if (row.kind === "foreshadowing" || row.kind === "plan_goal" || ["planned", "seeded", "reinforced"].includes(row.lifecycle)) return { ...row, ftsScore, score: score + 5, bucket: "openCommitments", reason: "未闭合承诺或伏笔" };
    if (request.pov && row.scope !== "world_truth") return { ...row, ftsScore, score: score + 4, bucket: "povKnowledge", reason: "叙事视角可知信息" };
    if (["event", "state_change", "causal_link"].includes(row.kind)) return { ...row, ftsScore, score: score + 2, bucket: "relevantHistory", reason: "事件和因果历史" };
    if (row.scope === "character_belief" || row.scope === "rumor_or_lie" || row.scope === "narrator_claim") return { ...row, ftsScore, score: score + 2, bucket: "povKnowledge", reason: "认知域信息" };
    return { ...row, ftsScore, score, bucket: "worldState", reason };
  }

  private toContextItem(row: ScoredMemory): ContextItem {
    return {
      memoryId: row.id,
      text: `${row.subject} ${row.predicate} ${row.object}`,
      score: row.score,
      sourceTitle: row.sourceTitle,
      spanStart: row.spanStart,
      spanEnd: row.spanEnd,
      quote: row.spanText,
      scope: row.scope,
      kind: row.kind,
      disputed: Boolean(row.disputed),
    };
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const size = Math.min(a.length, b.length);
  if (size === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < size; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    aNorm += left * left;
    bNorm += right * right;
  }
  return aNorm === 0 || bNorm === 0 ? 0 : dot / Math.sqrt(aNorm * bNorm);
}
