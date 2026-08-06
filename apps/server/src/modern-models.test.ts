import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { sqlite } from "./db.js";
import { DEFAULT_CONTEXT_LENGTH, DEFAULT_TOP_P, getModernModel, initModernModels, migrateModernModelConfigs, saveModernModel } from "./modern-models.js";

describe("modern model configs", () => {
  it("migrates and persists topP and contextLength with defaults", () => {
    initModernModels();
    const columns = sqlite.prepare("PRAGMA table_info(modern_model_configs)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["top_p", "context_length"]));

    const created = saveModernModel(null, { name: "默认", provider: "openai", model: "gpt-4o" });
    expect(getModernModel(created.id)).toMatchObject({
      topP: DEFAULT_TOP_P,
      contextLength: DEFAULT_CONTEXT_LENGTH,
      maxOutputTokens: 8192,
    });

    const updated = saveModernModel(created.id, {
      name: "更新",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      topP: 0.8,
      contextLength: 200_000,
    });
    expect(getModernModel(updated.id)).toMatchObject({ topP: 0.8, contextLength: 200_000 });
  });

  it("validates topP and contextLength", () => {
    const base = { name: "校验", provider: "openai" as const, model: "gpt-4o" };
    expect(() => saveModernModel(null, { ...base, topP: -0.1 })).toThrow(/topP/);
    expect(() => saveModernModel(null, { ...base, topP: 1.01 })).toThrow(/topP/);
    expect(() => saveModernModel(null, { ...base, contextLength: 1023 })).toThrow(/上下文长度/);
    expect(() => saveModernModel(null, { ...base, contextLength: 2_000_001 })).toThrow(/上下文长度/);
    expect(() => saveModernModel(null, { ...base, contextLength: 1000.5 })).toThrow(/上下文长度/);
    expect(() => saveModernModel(null, { ...base, contextLength: 4096, maxOutputTokens: 8192 })).toThrow(/不能超过上下文长度/);
  });

  it("accepts xhigh/max and arbitrary backend-valid integer token limits", () => {
    const base = { name: "扩展强度", provider: "openai" as const, model: "gpt-5" };
    const created = saveModernModel(null, {
      ...base,
      reasoningEffort: "xhigh",
      contextLength: 1_000_000,
      maxOutputTokens: 1_000,
    });
    expect(created).toMatchObject({ reasoningEffort: "xhigh", contextLength: 1_000_000, maxOutputTokens: 1_000 });

    const updated = saveModernModel(created.id, {
      ...base,
      reasoningEffort: "max",
      contextLength: 500_000,
      maxOutputTokens: 333,
    });
    expect(updated).toMatchObject({ reasoningEffort: "max", maxOutputTokens: 333 });
    expect(() => saveModernModel(null, { ...base, reasoningEffort: "ultra" as never })).toThrow(/推理强度/);
  });

  it("migrates the old reasoning_effort CHECK while preserving rows and FK mode", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE modern_model_configs (
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
        legacy_extra TEXT NOT NULL DEFAULT 'keep',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO modern_model_configs(
        id, name, provider, model, base_url, temperature, reasoning_effort,
        top_p, context_length, max_output_tokens, enabled, legacy_extra, created_at, updated_at
      ) VALUES (
        'old-1', '旧配置', 'openai', 'gpt-4o', '', 0.7, 'high',
        1, 200000, 4096, 1, 'extra-value', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      CREATE INDEX idx_modern_models_name ON modern_model_configs(name);
    `);

    migrateModernModelConfigs(db);

    expect(Number(db.pragma("foreign_keys", { simple: true }))).toBe(1);
    expect(db.prepare("SELECT name, reasoning_effort AS reasoningEffort, context_length AS contextLength, max_output_tokens AS maxOutputTokens, legacy_extra AS legacyExtra FROM modern_model_configs WHERE id = 'old-1'").get())
      .toMatchObject({ name: "旧配置", reasoningEffort: "high", contextLength: 200000, maxOutputTokens: 4096, legacyExtra: "extra-value" });
    const migratedSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'modern_model_configs'").get() as { sql: string }).sql;
    expect(migratedSql).toContain("'xhigh'");
    expect(migratedSql).toContain("'max'");
    expect(migratedSql).toContain("provider IN ('openai','anthropic','openai-compatible')");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_modern_models_updated'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_modern_models_name'").get()).toBeTruthy();
    db.prepare("INSERT INTO modern_model_configs(id, name, provider, model, reasoning_effort, created_at, updated_at) VALUES ('new-1', '新配置', 'openai', 'gpt-5', 'xhigh', ?, ?)")
      .run("2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    expect((db.prepare("SELECT reasoning_effort AS reasoningEffort FROM modern_model_configs WHERE id = 'new-1'").get() as { reasoningEffort: string }).reasoningEffort).toBe("xhigh");
    db.close();
  });
});
