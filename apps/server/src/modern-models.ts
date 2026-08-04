import { getCredential, setCredential } from "./credentials.js";
import { isoNow, newId, sqlite } from "./db.js";

export const MODERN_MODEL_PROVIDERS = ["openai", "anthropic", "openai-compatible"] as const;
export type ModernModelProvider = typeof MODERN_MODEL_PROVIDERS[number];
export const REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export const DEFAULT_TOP_P = 1;
export const DEFAULT_CONTEXT_LENGTH = 128_000;
export const CONTEXT_LENGTH_MIN = 1_024;
export const CONTEXT_LENGTH_MAX = 2_000_000;

export interface ModernModelConfig {
  id: string;
  name: string;
  provider: ModernModelProvider;
  model: string;
  baseUrl: string;
  temperature: number;
  reasoningEffort: ReasoningEffort;
  topP: number;
  contextLength: number;
  maxOutputTokens: number;
  enabled: boolean;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SaveModernModelInput {
  name: string;
  provider: ModernModelProvider;
  model: string;
  baseUrl?: string;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  topP?: number;
  contextLength?: number;
  maxOutputTokens?: number;
  enabled?: boolean;
  apiKey?: string;
}

const credentialKey = (id: string) => `modern-model:${id}`;

function ensureColumn(name: string, definition: string) {
  const columns = sqlite.prepare("PRAGMA table_info(modern_model_configs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) {
    sqlite.exec(`ALTER TABLE modern_model_configs ADD COLUMN ${name} ${definition}`);
  }
}

export function initModernModels() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS modern_model_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','openai-compatible')),
      model TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      temperature REAL NOT NULL DEFAULT 0.7,
      reasoning_effort TEXT NOT NULL DEFAULT 'none' CHECK(reasoning_effort IN ('none','low','medium','high')),
      top_p REAL NOT NULL DEFAULT 1,
      context_length INTEGER NOT NULL DEFAULT 128000,
      max_output_tokens INTEGER NOT NULL DEFAULT 8192,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_modern_models_updated ON modern_model_configs(updated_at DESC);
  `);
  ensureColumn("top_p", "REAL NOT NULL DEFAULT 1");
  ensureColumn("context_length", "INTEGER NOT NULL DEFAULT 128000");
}

initModernModels();

function assertInput(input: SaveModernModelInput) {
  if (!input.name?.trim()) throw new Error("模型配置名称不能为空");
  if (!MODERN_MODEL_PROVIDERS.includes(input.provider)) throw new Error("不支持的模型供应商");
  if (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)) throw new Error("温度必须在 0 到 2 之间");
  if (input.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(input.reasoningEffort)) throw new Error("不支持的推理强度");
  if (input.topP !== undefined && (!Number.isFinite(input.topP) || input.topP < 0 || input.topP > 1)) throw new Error("topP 必须在 0 到 1 之间");
  if (input.contextLength !== undefined && (!Number.isInteger(input.contextLength) || input.contextLength < CONTEXT_LENGTH_MIN || input.contextLength > CONTEXT_LENGTH_MAX)) {
    throw new Error(`上下文长度必须在 ${CONTEXT_LENGTH_MIN} 到 ${CONTEXT_LENGTH_MAX} 之间`);
  }
  if (input.maxOutputTokens !== undefined && (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 256 || input.maxOutputTokens > 100_000)) throw new Error("最大输出 token 不合法");
  if ((input.maxOutputTokens ?? 8192) > (input.contextLength ?? DEFAULT_CONTEXT_LENGTH)) throw new Error("最大输出 token 不能超过上下文长度");
}

function mapRow(row: Record<string, unknown>): ModernModelConfig {
  const id = String(row.id);
  return {
    id,
    name: String(row.name),
    provider: row.provider as ModernModelProvider,
    model: String(row.model),
    baseUrl: String(row.baseUrl),
    temperature: Number(row.temperature),
    reasoningEffort: row.reasoningEffort as ReasoningEffort,
    topP: Number(row.topP),
    contextLength: Number(row.contextLength),
    maxOutputTokens: Number(row.maxOutputTokens),
    enabled: Boolean(row.enabled),
    hasApiKey: Boolean(getCredential(credentialKey(id))),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

const columns = `id,name,provider,model,base_url AS baseUrl,temperature,reasoning_effort AS reasoningEffort,
  top_p AS topP,context_length AS contextLength,max_output_tokens AS maxOutputTokens,
  enabled,created_at AS createdAt,updated_at AS updatedAt`;

export function listModernModels() {
  return (sqlite.prepare(`SELECT ${columns} FROM modern_model_configs ORDER BY updated_at DESC`).all() as Record<string, unknown>[]).map(mapRow);
}

export function getModernModel(id: string) {
  const row = sqlite.prepare(`SELECT ${columns} FROM modern_model_configs WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function saveModernModel(id: string | null, input: SaveModernModelInput) {
  assertInput(input);
  const modelId = id ?? newId();
  const now = isoNow();
  return sqlite.transaction(() => {
    const existing = sqlite.prepare("SELECT id FROM modern_model_configs WHERE id=?").get(modelId);
    if (existing) {
      sqlite.prepare(`UPDATE modern_model_configs SET name=?,provider=?,model=?,base_url=?,temperature=?,reasoning_effort=?,top_p=?,context_length=?,max_output_tokens=?,enabled=?,updated_at=? WHERE id=?`)
        .run(
          input.name.trim(), input.provider, input.model.trim(), input.baseUrl?.trim() ?? "",
          input.temperature ?? 0.7, input.reasoningEffort ?? "none", input.topP ?? DEFAULT_TOP_P,
          input.contextLength ?? DEFAULT_CONTEXT_LENGTH, input.maxOutputTokens ?? 8192,
          input.enabled === false ? 0 : 1, now, modelId,
        );
    } else {
      sqlite.prepare(`INSERT INTO modern_model_configs(id,name,provider,model,base_url,temperature,reasoning_effort,top_p,context_length,max_output_tokens,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          modelId, input.name.trim(), input.provider, input.model.trim(), input.baseUrl?.trim() ?? "",
          input.temperature ?? 0.7, input.reasoningEffort ?? "none", input.topP ?? DEFAULT_TOP_P,
          input.contextLength ?? DEFAULT_CONTEXT_LENGTH, input.maxOutputTokens ?? 8192,
          input.enabled === false ? 0 : 1, now, now,
        );
    }
    if (input.apiKey !== undefined) setCredential(credentialKey(modelId), input.apiKey);
    return getModernModel(modelId)!;
  })();
}

export function getModernModelCredential(id: string) {
  return getCredential(credentialKey(id));
}

export { discoverModels } from "./model-discovery.js";
