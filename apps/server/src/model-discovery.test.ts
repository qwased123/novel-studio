import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_DISCOVERY_TIMEOUT_MS, discoverModels, normalizeModelsEndpoint } from "./model-discovery.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("model discovery", () => {
  it("normalizes provider models endpoints to /v1/models", () => {
    expect(normalizeModelsEndpoint("openai").toString()).toBe("https://api.openai.com/v1/models");
    expect(normalizeModelsEndpoint("anthropic").toString()).toBe("https://api.anthropic.com/v1/models");
    expect(normalizeModelsEndpoint("openai-compatible", "http://localhost:8080/v1").toString()).toBe("http://localhost:8080/v1/models");
    expect(normalizeModelsEndpoint("openai-compatible", "https://llm.example.com").toString()).toBe("https://llm.example.com/v1/models");
    expect(normalizeModelsEndpoint("openai-compatible", "https://llm.example.com/v1/models/").toString()).toBe("https://llm.example.com/v1/models");
    expect(normalizeModelsEndpoint("openai-compatible", "https://llm.example.com/models").toString()).toBe("https://llm.example.com/models");

    expect(() => normalizeModelsEndpoint("openai-compatible")).toThrow(/Base URL/);
    expect(() => normalizeModelsEndpoint("openai", "ftp://api.openai.com/v1")).toThrow(/http/);
    expect(() => normalizeModelsEndpoint("openai", "https://user:pass@api.openai.com/v1")).toThrow(/用户名或密码/);
  });

  it("fetches OpenAI-compatible endpoints, deduplicates and sorts model ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "z-model" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await discoverModels({
      provider: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "sk-test-secret",
    });
    expect(models).toEqual(["a-model", "z-model"]);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://llm.example.com/v1/models");
    expect(init).toMatchObject({ redirect: "manual", credentials: "omit" });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-secret");
  });

  it("uses Anthropic auth headers and version header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "claude-3-5-sonnet" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await discoverModels({ provider: "anthropic", apiKey: "sk-ant-test" });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://api.anthropic.com/v1/models");
    expect(init.headers).toMatchObject({
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
    });
  });

  it("does not follow redirects and returns actionable errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("redirect", { status: 302 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverModels({ provider: "openai", apiKey: "sk-test" })).rejects.toThrow(/重定向/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 }));
    await expect(discoverModels({ provider: "openai", apiKey: "sk-test" })).rejects.toThrow(/HTTP 401.*Invalid API key/);
  });

  it("validates URLs and API keys before fetching", async () => {
    await expect(discoverModels({ provider: "openai-compatible", baseUrl: "not-a-url", apiKey: "sk-test" })).rejects.toThrow(/http/);
    await expect(discoverModels({ provider: "openai", apiKey: "   " })).rejects.toThrow(/API Key/);
  });

  it("times out when the provider does not respond", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);

    const rejected = expect(discoverModels({ provider: "openai", apiKey: "sk-test" })).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(MODEL_DISCOVERY_TIMEOUT_MS + 1);
    await rejected;
  });
});
