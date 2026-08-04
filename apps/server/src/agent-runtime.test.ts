import { describe, expect, it } from "vitest";
import { assemblePromptMessages, runtimeSamplingOptions } from "./agent-runtime.js";
import type { AgentPromptBlock } from "./modern-store.js";

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
});
