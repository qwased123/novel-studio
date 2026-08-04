import { describe, expect, it } from "vitest";
import { sqlite } from "./db.js";
import { DEFAULT_CONTEXT_LENGTH, DEFAULT_TOP_P, getModernModel, initModernModels, saveModernModel } from "./modern-models.js";

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
});
