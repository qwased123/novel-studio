import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { isStepCount, jsonSchema, streamText, tool } from "ai";
import type { AgentPromptBlock, PromptTriggerScope } from "./modern-store.js";

export interface AgentModelConfig {
  provider: "openai" | "anthropic" | "openai-compatible";
  model: string;
  apiKey: string;
  baseUrl?: string;
  adapterName?: string;
}

export interface AgentTool<Input = unknown> {
  name: string;
  description: string;
  inputSchema: {
    safeParse(value: unknown): { success: true; data: Input } | { success: false; error: { message: string } };
    toJSONSchema(options?: { target?: string }): unknown;
  };
  execute?: (input: Input) => unknown | Promise<unknown>;
}

export function defineAgentTool<Input>(definition: AgentTool<Input>) {
  return definition as AgentTool<unknown>;
}

export interface AgentRunRequest {
  model: AgentModelConfig;
  system: string;
  prompt: string;
  contextPayload?: string;
  sessionPayload?: string;
  promptBlocks?: AgentPromptMessage[];
  tools?: AgentTool<unknown>[];
  maxSteps?: number;
  temperature: number;
  topP?: number;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
  maxRetries?: number;
  onTextDelta: (text: string) => void | Promise<void>;
}

export interface AgentPromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
}

export interface AgentToolCall {
  toolName: string;
  input: unknown;
}

export interface AgentRunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: AgentToolCall[];
}

export interface AgentRuntime {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export function runtimeSamplingOptions(request: Pick<AgentRunRequest, "temperature" | "topP" | "maxOutputTokens">) {
  return {
    temperature: request.temperature,
    maxOutputTokens: request.maxOutputTokens,
    ...(request.topP !== undefined ? { topP: request.topP } : {}),
  };
}

export function assemblePromptMessages(blocks: AgentPromptBlock[], scope: PromptTriggerScope): AgentPromptMessage[] {
  return blocks
    .filter((block) => block.enabled && (block.triggerScope === "always" || block.triggerScope === scope))
    .sort((a, b) =>
      a.depth - b.depth ||
      a.position - b.position ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id))
    .map((block) => ({ role: block.role, content: block.content, name: block.name }));
}

class AiSdkAgentRuntime implements AgentRuntime {
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const baseURL = request.model.baseUrl || undefined;
    const model = request.model.provider === "anthropic"
      ? createAnthropic({ apiKey: request.model.apiKey, baseURL })(request.model.model)
      : request.model.provider === "openai-compatible"
        ? createOpenAICompatible({
          name: request.model.adapterName ?? "novel-studio",
          apiKey: request.model.apiKey,
          baseURL: request.model.baseUrl ?? "",
        })(request.model.model)
        : createOpenAI({ apiKey: request.model.apiKey, baseURL })(request.model.model);
    const tools = request.tools?.length
      ? Object.fromEntries(request.tools.map((definition) => {
        const inputSchema = jsonSchema(
          definition.inputSchema.toJSONSchema({ target: "draft-07" }) as Parameters<typeof jsonSchema>[0],
          {
            validate: (value) => {
              const parsed = definition.inputSchema.safeParse(value);
              return parsed.success
                ? { success: true, value: parsed.data }
                : { success: false, error: new Error(parsed.error.message) };
            },
          },
        );
        const adaptedTool = definition.execute
          ? tool({ description: definition.description, inputSchema, execute: definition.execute })
          : tool({ description: definition.description, inputSchema });
        return [definition.name, adaptedTool];
      }))
      : undefined;
    const payload = request.contextPayload !== undefined || request.sessionPayload !== undefined
      ? [
          request.contextPayload,
          request.sessionPayload ? `<session>\n${request.sessionPayload}\n</session>` : "",
          `<author-message>\n${request.prompt}\n</author-message>`,
        ].filter(Boolean).join("\n\n")
      : request.prompt;
    const result = streamText({
      model,
      ...(request.promptBlocks !== undefined
        ? {
            messages: [
              ...request.promptBlocks.map((block) => ({ role: block.role, content: block.content })),
              { role: "user" as const, content: payload },
            ],
          }
        : { system: request.system, prompt: payload }),
      tools,
      stopWhen: request.maxSteps ? isStepCount(request.maxSteps) : undefined,
      ...runtimeSamplingOptions(request),
      abortSignal: request.abortSignal,
      maxRetries: request.maxRetries ?? 3,
    });

    let text = "";
    for await (const chunk of result.textStream) {
      text += chunk;
      await request.onTextDelta(chunk);
    }

    const [usage, toolCalls] = await Promise.all([result.totalUsage, result.toolCalls]);
    return {
      text,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      toolCalls: toolCalls.map((call) => ({ toolName: call.toolName, input: call.input })),
    };
  }
}

export const agentRuntime: AgentRuntime = new AiSdkAgentRuntime();
