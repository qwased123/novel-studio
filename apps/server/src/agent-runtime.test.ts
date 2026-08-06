import { APICallError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntime,
  assemblePromptMessages,
  isReasoningEffortUnsupportedError,
  providerOptionsFor,
  runtimeSamplingOptions,
  sanitizeProviderMessage,
} from "./agent-runtime.js";
import type { AgentPromptBlock } from "./modern-store.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function streamResponse(text: string) {
  const chunks = [
    { id: "mock-1", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "mock-1", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function block(partial: Partial<AgentPromptBlock> & Pick<AgentPromptBlock, "name" | "depth" | "position">): AgentPromptBlock {
  return {
    id: `block-${partial.name}`,
    projectId: "project-test",
    agentRole: "main",
    name: partial.name,
    enabled: true,
    pinned: false,
    role: "system",
    position: partial.position,
    depth: partial.depth,
    triggerScope: "always",
    content: `内容：${partial.name}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("agent prompt assembly", () => {
  it("orders enabled blocks deterministically and filters by trigger scope", () => {
    const blocks = [
      block({ name: "A", depth: 1, position: 0 }),
      block({ name: "B", depth: 0, position: 5 }),
      block({ name: "C", depth: 0, position: 0, triggerScope: "chat" }),
      block({ name: "D", depth: 0, position: 1, enabled: false }),
      block({ name: "E", depth: 0, position: 2, triggerScope: "task" }),
    ];
    expect(assemblePromptMessages(blocks, "chat").map((message) => message.name)).toEqual(["C", "B", "A"]);
    expect(assemblePromptMessages(blocks, "task").map((message) => message.name)).toEqual(["E", "B", "A"]);
    expect(assemblePromptMessages(blocks, "chat").map((message) => message.role)).toEqual(["system", "system", "system"]);
  });

  it("breaks ordering ties by createdAt then id", () => {
    const blocks = [
      block({ name: "older", depth: 0, position: 0, createdAt: "2026-01-01T00:00:00.000Z", id: "z-id" }),
      block({ name: "newer", depth: 0, position: 0, createdAt: "2026-01-02T00:00:00.000Z", id: "a-id" }),
      block({ name: "same-time", depth: 0, position: 0, createdAt: "2026-01-01T00:00:00.000Z", id: "a-id" }),
    ];
    expect(assemblePromptMessages(blocks, "always").map((message) => message.name)).toEqual(["same-time", "older", "newer"]);
  });

  it("includes topP in sampling options only when configured", () => {
    expect(runtimeSamplingOptions({ temperature: 0.7, maxOutputTokens: 4096 })).toEqual({ temperature: 0.7, maxOutputTokens: 4096 });
    expect(runtimeSamplingOptions({ temperature: 0.7, topP: 0.8, maxOutputTokens: 4096 })).toEqual({ temperature: 0.7, topP: 0.8, maxOutputTokens: 4096 });
  });

  it("serializes reasoning effort into provider-specific request options", () => {
    expect(providerOptionsFor({ provider: "openai", model: "gpt-5", apiKey: "sk", reasoningEffort: "xhigh" }))
      .toEqual({ openai: { reasoningEffort: "xhigh" } });
    expect(providerOptionsFor({ provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk", reasoningEffort: "max" }))
      .toEqual({ anthropic: { effort: "max" } });
    expect(providerOptionsFor({ provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk", reasoningEffort: "none" }))
      .toEqual({ anthropic: { thinking: { type: "disabled" } } });
    expect(providerOptionsFor({ provider: "openai-compatible", model: "deepseek", apiKey: "sk", adapterName: "novel-studio", reasoningEffort: "high" }))
      .toEqual({ novelStudio: { reasoningEffort: "high" } });
    expect(providerOptionsFor({ provider: "openai", model: "gpt-4o", apiKey: "sk" })).toBeUndefined();
  });

  it("sends reasoning_effort in the OpenAI-compatible request body", async () => {
    const fetchMock = vi.fn(async () => streamResponse("完成。"));
    vi.stubGlobal("fetch", fetchMock);

    await agentRuntime.run({
      model: {
        provider: "openai-compatible",
        model: "mock-reasoner",
        apiKey: "sk-test",
        baseUrl: "http://mock.local/v1",
        adapterName: "novel-studio",
        reasoningEffort: "max",
      },
      system: "系统",
      prompt: "请回答",
      temperature: 0.7,
      maxOutputTokens: 512,
      abortSignal: new AbortController().signal,
      onTextDelta: () => undefined,
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://mock.local/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "mock-reasoner",
      reasoning_effort: "max",
      max_tokens: 512,
    });
  });

  it("uses chat completions for OpenAI provider with a custom base URL", async () => {
    const fetchMock = vi.fn(async () => streamResponse("完成。"));
    vi.stubGlobal("fetch", fetchMock);

    await agentRuntime.run({
      model: {
        provider: "openai",
        model: "deepseek-v4-flash",
        apiKey: "sk-test",
        baseUrl: "https://api.deepseek.com/v1",
        reasoningEffort: "max",
      },
      system: "系统",
      prompt: "请回答",
      temperature: 0.7,
      maxOutputTokens: 512,
      abortSignal: new AbortController().signal,
      onTextDelta: () => undefined,
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "deepseek-v4-flash",
      reasoning_effort: "max",
    });
  });

  it("moves system prompt blocks to the top-level system option", async () => {
    const fetchMock = vi.fn(async () => streamResponse("完成。"));
    vi.stubGlobal("fetch", fetchMock);

    await agentRuntime.run({
      model: {
        provider: "openai-compatible",
        model: "mock-system",
        apiKey: "sk-test",
        baseUrl: "http://mock.local/v1",
        adapterName: "novel-studio",
      },
      system: "显式系统指令",
      promptBlocks: [
        { role: "system", content: "系统指令块" },
        { role: "user", content: "历史用户消息" },
        { role: "assistant", content: "历史助手消息" },
        { role: "system", content: "系统指令块" },
      ],
      prompt: "请回答",
      temperature: 0.7,
      maxOutputTokens: 512,
      abortSignal: new AbortController().signal,
      onTextDelta: () => undefined,
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content).toContain("显式系统指令");
    expect(body.messages[0]?.content).toContain("系统指令块");
    expect(body.messages[0]?.content.match(/系统指令块/g)).toHaveLength(1);
    expect(body.messages.slice(1).map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(body.messages[1]?.content).toBe("历史用户消息");
    expect(body.messages[3]?.content).toBe("请回答");
  });

  it("classifies reasoning effort errors conservatively", () => {
    const unsupported = new APICallError({
      message: "Invalid value for 'reasoning': unsupported effort 'xhigh'",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
    expect(isReasoningEffortUnsupportedError(unsupported)).toBe(true);
    const responsesEffort = new APICallError({
      message: "Invalid value for 'reasoning.effort': unsupported value",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
    expect(isReasoningEffortUnsupportedError(responsesEffort)).toBe(true);

    const rateLimit = new APICallError({
      message: "Rate limit exceeded",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: true,
    });
    expect(isReasoningEffortUnsupportedError(rateLimit)).toBe(false);
    expect(isReasoningEffortUnsupportedError(new Error("Invalid value"))).toBe(false);

    const temperatureOnReasoningModel = new APICallError({
      message: "temperature is not supported for reasoning models",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
    expect(isReasoningEffortUnsupportedError(temperatureOnReasoningModel)).toBe(false);
  });

  it("redacts credential-like values from provider diagnostics", () => {
    expect(sanitizeProviderMessage("failed with api_key=sk-secret-abc and Bearer sk-bearer-token"))
      .toBe("failed with api_key=[REDACTED] and Bearer [REDACTED]");
    expect(sanitizeProviderMessage("x-api-key: sk-ant-test-value rejected")).toBe("x-api-key: [REDACTED] rejected");
  });
});
