import { z } from "zod";
import type { MemoryDatabase } from "./database.js";
import { nowIso, sha256 } from "./ids.js";
import { EPISTEMIC_SCOPES, MEMORY_KINDS, type MemoryCandidateInput, type ModelConfig } from "./types.js";

const candidateSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  scope: z.enum(EPISTEMIC_SCOPES),
  subject: z.string().min(1).max(200),
  predicate: z.string().min(1).max(120),
  object: z.string().min(1).max(1000),
  perspective: z.string().max(200).nullable().optional(),
  storyTimeStart: z.string().max(120).nullable().optional(),
  storyTimeEnd: z.string().max(120).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  threadKey: z.string().max(200).nullable().optional(),
  lifecycle: z.enum(["active", "planned", "seeded", "reinforced", "resolved", "abandoned"]).optional(),
  spanStart: z.number().int().min(0),
  spanEnd: z.number().int().positive(),
  spanText: z.string().min(1),
});

const extractionSchema = z.object({ candidates: z.array(candidateSchema).max(300) });

export interface ModelMetricRecord {
  id: number;
  role: ModelConfig["role"];
  operation: "chat" | "embedding";
  cacheHit: boolean;
  attempts: number;
  durationMs: number;
  status: "success" | "failed";
  httpStatus: number | null;
  error: string | null;
  createdAt: string;
}

class ModelRequestError extends Error {
  constructor(message: string, readonly httpStatus: number | null = null) {
    super(message);
    this.name = "ModelRequestError";
  }
}

const systemPrompt = `你是长篇中文小说的叙事记忆抽取器。只从输入原文提取有明确证据的信息，不补全、不猜测、不裁决冲突。
输出严格 JSON：{"candidates":[...]}。每项字段：kind、scope、subject、predicate、object、perspective、storyTimeStart、storyTimeEnd、confidence、threadKey、lifecycle、spanStart、spanEnd、spanText。
spanStart/spanEnd 是当前片段内 UTF-16 左闭右开下标，spanText 必须与片段切片逐字一致。
kind 只能是 entity/attribute/relationship/event/state_change/world_rule/location_topology/causal_link/foreshadowing/plan_goal/theme/style_constraint。
scope 只能是 world_truth/character_belief/rumor_or_lie/narrator_claim/author_plan。角色所想、听说和欺骗绝不写成 world_truth。未来大纲写 author_plan。
把状态变化、故事时间、揭示出的伏笔及兑现分别记录；不要把整段摘要伪装成事实。`;

function parseJsonObject(value: string) {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return JSON.parse(fenced ?? value);
}

export class OpenAiCompatibleModels {
  constructor(private readonly db: MemoryDatabase, private readonly apiKey = process.env.MEMORY_OPENAI_API_KEY ?? "") {}

  getConfig(role: ModelConfig["role"]): ModelConfig {
    const row = this.db.prepare("SELECT role,base_url AS baseUrl,model,temperature,max_output_tokens AS maxOutputTokens,enabled FROM model_configs WHERE role=?").get(role) as Record<string, unknown> | undefined;
    if (!row) return { role, baseUrl: "https://api.openai.com/v1", model: "", temperature: role === "extractor" ? 0.1 : 0, maxOutputTokens: 4096, enabled: false };
    return { role, baseUrl: String(row.baseUrl), model: String(row.model), temperature: Number(row.temperature), maxOutputTokens: Number(row.maxOutputTokens), enabled: Boolean(row.enabled) };
  }

  saveConfig(config: ModelConfig) {
    if (!config.baseUrl.trim() || !config.model.trim()) throw new Error("启用模型前必须填写 Base URL 和模型名");
    if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) throw new Error("temperature 必须在 0 到 2 之间");
    if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0 || config.maxOutputTokens > 1_000_000) throw new Error("maxOutputTokens 必须是 1 到 1000000 之间的整数");
    try {
      const parsed = new URL(config.baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("协议不支持");
    } catch {
      throw new Error("Base URL 必须是有效的 HTTP(S) 地址");
    }
    this.db.prepare(`INSERT INTO model_configs(role,base_url,model,temperature,max_output_tokens,enabled,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(role) DO UPDATE SET base_url=excluded.base_url,model=excluded.model,
      temperature=excluded.temperature,max_output_tokens=excluded.max_output_tokens,enabled=excluded.enabled,updated_at=excluded.updated_at`)
      .run(config.role, config.baseUrl.replace(/\/$/, ""), config.model, config.temperature, config.maxOutputTokens, config.enabled ? 1 : 0, nowIso());
    return this.getConfig(config.role);
  }

  listMetrics(options: { role?: ModelConfig["role"]; operation?: ModelMetricRecord["operation"]; limit?: number } = {}): ModelMetricRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.role) { clauses.push("role=?"); params.push(options.role); }
    if (options.operation) { clauses.push("operation=?"); params.push(options.operation); }
    const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 100)));
    const rows = this.db.prepare(`SELECT id,role,operation,cache_hit AS cacheHit,attempts,duration_ms AS durationMs,status,http_status AS httpStatus,error,created_at AS createdAt
      FROM model_request_metrics ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id), role: row.role as ModelConfig["role"], operation: row.operation as ModelMetricRecord["operation"],
      cacheHit: Boolean(row.cacheHit), attempts: Number(row.attempts), durationMs: Number(row.durationMs), status: row.status as ModelMetricRecord["status"],
      httpStatus: row.httpStatus === null ? null : Number(row.httpStatus), error: row.error === null ? null : String(row.error), createdAt: String(row.createdAt),
    }));
  }

  getMetricSummary() {
    const rows = this.db.prepare(`SELECT role,operation,count(*) AS requests,
        sum(CASE WHEN cache_hit=1 THEN 1 ELSE 0 END) AS cacheHits,
        sum(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successes,
        sum(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failures,
        avg(duration_ms) AS avgDurationMs,avg(attempts) AS avgAttempts
      FROM model_request_metrics GROUP BY role,operation ORDER BY role,operation`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({ role: String(row.role), operation: String(row.operation), requests: Number(row.requests), cacheHits: Number(row.cacheHits), successes: Number(row.successes), failures: Number(row.failures), avgDurationMs: Number(row.avgDurationMs ?? 0), avgAttempts: Number(row.avgAttempts ?? 0) }));
  }

  async extract(content: string, context: string, chunkOffset: number): Promise<MemoryCandidateInput[]> {
    const config = this.getConfig("extractor");
    if (!config.enabled) return ruleBasedExtract(content, chunkOffset);
    const cacheKey = sha256(JSON.stringify({ role: "extractor", model: config.model, prompt: systemPrompt, content, context }));
    const cached = this.db.prepare("SELECT response_json AS responseJson FROM model_cache WHERE cache_key=?").get(cacheKey) as { responseJson: string } | undefined;
    if (cached) this.recordMetric("extractor", "chat", { cacheHit: true, attempts: 0, durationMs: 0, status: "success", httpStatus: null, error: null });
    const parsed = cached ? extractionSchema.parse(JSON.parse(cached.responseJson)) : extractionSchema.parse(parseJsonObject(await this.chat(config, [
      { role: "system", content: systemPrompt },
      { role: "user", content: `相关既有记忆（仅用于识别，不得覆盖原文）：\n${context.slice(0, 6000)}\n\n待抽取片段：\n${content}` },
    ])));
    if (!cached) this.db.prepare("INSERT INTO model_cache(cache_key,role,response_json,created_at) VALUES(?,?,?,?)").run(cacheKey, "extractor", JSON.stringify(parsed), nowIso());
    return parsed.candidates.map((item) => ({ ...item, spanStart: item.spanStart + chunkOffset, spanEnd: item.spanEnd + chunkOffset }));
  }

  async verifyConflict(input: { candidate: MemoryCandidateInput; existing: string; explanation: string }) {
    const config = this.getConfig("verifier");
    if (!config.enabled) return { confirmed: true, explanation: input.explanation };
    const prompt = `你是小说一致性复核器。你不能选择哪条设定正确，只判断两条带证据信息是否在相同认知域和有效时间内确实不相容。输出 JSON：{"confirmed":boolean,"explanation":string}。\n既有：${input.existing}\n新候选：${JSON.stringify(input.candidate)}\n初筛理由：${input.explanation}`;
    const key = sha256(JSON.stringify({ role: "verifier", model: config.model, prompt }));
    const cached = this.db.prepare("SELECT response_json AS responseJson FROM model_cache WHERE cache_key=?").get(key) as { responseJson: string } | undefined;
    if (cached) {
      this.recordMetric("verifier", "chat", { cacheHit: true, attempts: 0, durationMs: 0, status: "success", httpStatus: null, error: null });
      return z.object({ confirmed: z.boolean(), explanation: z.string() }).parse(JSON.parse(cached.responseJson));
    }
    const result = z.object({ confirmed: z.boolean(), explanation: z.string() }).parse(parseJsonObject(await this.chat(config, [{ role: "user", content: prompt }])));
    this.db.prepare("INSERT INTO model_cache(cache_key,role,response_json,created_at) VALUES(?,?,?,?)").run(key, "verifier", JSON.stringify(result), nowIso());
    return result;
  }

  async embed(value: string): Promise<number[] | null> {
    const config = this.getConfig("embedding");
    if (!config.enabled) return null;
    const key = sha256(JSON.stringify({ role: "embedding", model: config.model, value }));
    const cached = this.db.prepare("SELECT response_json AS responseJson FROM model_cache WHERE cache_key=?").get(key) as { responseJson: string } | undefined;
    if (cached) {
      this.recordMetric("embedding", "embedding", { cacheHit: true, attempts: 0, durationMs: 0, status: "success", httpStatus: null, error: null });
      return JSON.parse(cached.responseJson) as number[];
    }
    if (!this.apiKey) throw new Error("缺少 MEMORY_OPENAI_API_KEY");
    const embedding = await this.withRetry("embedding", "embedding", async (signal) => {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/embeddings`, { method: "POST", signal, headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify({ model: config.model, input: value }) });
      if (!response.ok) throw new ModelRequestError(`Embedding 请求失败 ${response.status}: ${(await response.text()).slice(0, 500)}`, response.status);
      const data = await response.json() as { data?: Array<{ embedding?: number[] }> };
      const vector = data.data?.[0]?.embedding;
      if (!vector) throw new ModelRequestError("Embedding 响应缺少向量");
      return vector;
    });
    this.db.prepare("INSERT INTO model_cache(cache_key,role,response_json,created_at) VALUES(?,?,?,?)").run(key, "embedding", JSON.stringify(embedding), nowIso());
    return embedding;
  }

  private async chat(config: ModelConfig, messages: Array<{ role: string; content: string }>) {
    if (!this.apiKey) throw new Error("缺少 MEMORY_OPENAI_API_KEY");
    return this.withRetry(config.role, "chat", async (signal) => {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: config.model, messages, temperature: config.temperature, max_tokens: config.maxOutputTokens, response_format: { type: "json_object" } }),
      });
      if (!response.ok) throw new ModelRequestError(`模型请求失败 ${response.status}: ${(await response.text()).slice(0, 500)}`, response.status);
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new ModelRequestError("模型响应缺少 content");
      return content;
    });
  }

  private async withRetry<T>(role: ModelConfig["role"], operation: ModelMetricRecord["operation"], request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const maxAttempts = Math.max(1, Math.min(5, Number(process.env.MEMORY_MODEL_MAX_ATTEMPTS ?? 3)));
    const baseDelayMs = Math.max(0, Number(process.env.MEMORY_MODEL_RETRY_BASE_MS ?? 250));
    const timeoutMs = Math.max(100, Number(process.env.MEMORY_MODEL_TIMEOUT_MS ?? 90_000));
    const started = Date.now();
    let attempts = 0;
    let lastError: unknown;
    let httpStatus: number | null = null;
    while (attempts < maxAttempts) {
      attempts += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const value = await request(controller.signal);
        this.recordMetric(role, operation, { cacheHit: false, attempts, durationMs: Date.now() - started, status: "success", httpStatus: null, error: null });
        return value;
      } catch (error) {
        lastError = error;
        httpStatus = error instanceof ModelRequestError ? error.httpStatus : null;
        if (attempts >= maxAttempts || !this.retryable(error)) break;
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempts - 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    this.recordMetric(role, operation, { cacheHit: false, attempts, durationMs: Date.now() - started, status: "failed", httpStatus, error: message.slice(0, 2000) });
    throw lastError instanceof Error ? lastError : new Error(message);
  }

  private retryable(error: unknown) {
    if (error instanceof ModelRequestError) return error.httpStatus === null || error.httpStatus === 408 || error.httpStatus === 425 || error.httpStatus === 429 || error.httpStatus >= 500;
    return true;
  }

  private recordMetric(role: ModelConfig["role"], operation: ModelMetricRecord["operation"], value: Omit<ModelMetricRecord, "id" | "role" | "operation" | "createdAt">) {
    this.db.prepare(`INSERT INTO model_request_metrics(role,operation,cache_hit,attempts,duration_ms,status,http_status,error,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(role, operation, value.cacheHit ? 1 : 0, value.attempts, Math.max(0, Math.trunc(value.durationMs)), value.status, value.httpStatus, value.error, nowIso());
  }
}

export function ruleBasedExtract(content: string, chunkOffset = 0): MemoryCandidateInput[] {
  const results: MemoryCandidateInput[] = [];
  const patterns: Array<{ regex: RegExp; predicate: string; kind: MemoryCandidateInput["kind"] }> = [
    { regex: /([\p{L}\p{N}_·]{1,24})(?:位于|坐落于)([^。！？\n]{1,40})/gu, predicate: "location", kind: "location_topology" },
    { regex: /([\p{L}\p{N}_·]{1,24})(?:拥有|持有)([^。！？\n]{1,40})/gu, predicate: "holds_item", kind: "state_change" },
    { regex: /([\p{L}\p{N}_·]{1,24})(?:是|为)([^。！？\n]{1,40})/gu, predicate: "is", kind: "attribute" },
  ];
  for (const { regex, predicate, kind } of patterns) {
    for (const match of content.matchAll(regex)) {
      const spanStart = chunkOffset + (match.index ?? 0);
      const spanText = match[0];
      results.push({ kind, scope: "world_truth", subject: match[1]!, predicate, object: match[2]!.trim(), confidence: 0.55, lifecycle: "active", spanStart, spanEnd: spanStart + spanText.length, spanText });
    }
  }
  return results;
}
