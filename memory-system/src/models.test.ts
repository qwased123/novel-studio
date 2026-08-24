import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "./database.js";
import { OpenAiCompatibleModels } from "./models.js";

describe("OpenAiCompatibleModels", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("retries transient chat failures and records request metrics", async () => {
    const db = openDatabase(":memory:");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MEMORY_MODEL_RETRY_BASE_MS", "0");
    vi.stubEnv("MEMORY_MODEL_MAX_ATTEMPTS", "3");
    const models = new OpenAiCompatibleModels(db, "test-key");
    models.saveConfig({ role: "extractor", baseUrl: "http://model.test/v1", model: "extractor", temperature: 0, maxOutputTokens: 128, enabled: true });
    try {
      const result = await models.extract("林舟位于北城。", "", 0);
      expect(result).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(models.getMetricSummary()).toEqual([expect.objectContaining({ role: "extractor", operation: "chat", requests: 1, successes: 1, failures: 0, cacheHits: 0, avgAttempts: 2 })]);
      expect(models.listMetrics({ role: "extractor" })[0]).toMatchObject({ attempts: 2, status: "success", httpStatus: null });
    } finally {
      db.close();
    }
  });

  it("validates model configuration before persisting it", () => {
    const db = openDatabase(":memory:");
    const models = new OpenAiCompatibleModels(db);
    try {
      expect(() => models.saveConfig({ role: "extractor", baseUrl: "not-a-url", model: "x", temperature: 0, maxOutputTokens: 128, enabled: false })).toThrow(/Base URL/);
      expect(() => models.saveConfig({ role: "extractor", baseUrl: "http://model.test/v1", model: "x", temperature: 3, maxOutputTokens: 128, enabled: false })).toThrow(/temperature/);
      expect(() => models.saveConfig({ role: "extractor", baseUrl: "http://model.test/v1", model: "x", temperature: 0, maxOutputTokens: 0, enabled: false })).toThrow(/maxOutputTokens/);
      expect(models.getConfig("extractor").enabled).toBe(false);
    } finally {
      db.close();
    }
  });

  it("records cache hits without issuing another network request", async () => {
    const db = openDatabase(":memory:");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const models = new OpenAiCompatibleModels(db, "test-key");
    models.saveConfig({ role: "extractor", baseUrl: "http://model.test/v1", model: "extractor", temperature: 0, maxOutputTokens: 128, enabled: true });
    try {
      await models.extract("林舟位于北城。", "", 0);
      await models.extract("林舟位于北城。", "", 0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(models.getMetricSummary()).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "extractor", operation: "chat", requests: 2, cacheHits: 1, successes: 2 }),
      ]));
    } finally {
      db.close();
    }
  });
});
