import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, isStepCount, jsonSchema, streamText, tool } from "ai";
import type { AgentPromptBlock, PromptTriggerScope } from "./modern-store.js";
import type { ReasoningEffort } from "./modern-models.js";

export interface AgentModelConfig {
  provider: "openai" | "anthropic" | "openai-compatible";
  model: string;
  apiKey: string;
  baseUrl?: string;
  adapterName?: string;
  reasoningEffort?: ReasoningEffort;
  configName?: string;
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

export const REASONING_EFFORT_ERROR_CODE = "reasoning_effort_unsupported";

export interface ReasoningEffortUnsupportedDetails {
  reasoningEffort: string;
  model: string;
  provider: string;
  configName?: string;
  providerMessage: string;
}

export class ReasoningEffortUnsupportedError extends Error {
  readonly code = REASONING_EFFORT_ERROR_CODE;
  constructor(readonly details: ReasoningEffortUnsupportedDetails) {
    const target = details.configName
      ? `模型配置「${details.configName}」（${details.model}）`
      : `模型「${details.model}」`;
    super(`当前模型不支持所选推理强度「${details.reasoningEffort}」，${target}不支持该设置。请在模型配置中调整推理强度或更换模型。`);
    this.name = "ReasoningEffortUnsupportedError";
  }
}

export function sanitizeProviderMessage(message: string) {
  return message
    .replace(/(x-api-key|api[_-]?key)([=:]\s*)[^\s,;&]+/gi, "$1$2[REDACTED]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/**
 * Conservative classification: only errors that both reference reasoning
 * effort and contain an explicit unsupported/invalid marker are treated as
 * effort-related. Provider network/rate-limit/5xx failures are left untouched.
 */
export function isReasoningEffortUnsupportedError(error: unknown): boolean {
  if (error instanceof ReasoningEffortUnsupportedError) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const effortMention = /reasoning[ _.-]?effort|reasoning_effort|'effort'|"effort"|\beffort\b/.test(message);
  if (!effortMention) return false;
  const unsupportedMention = /unsupported|not support|does not support|doesn'?t support|invalid|unknown|not allowed|not valid|unrecognized|不支持|无效|未知|无法使用/.test(message);
  if (!unsupportedMention) return false;
  const status = APICallError.isInstance(error) ? error.statusCode : undefined;
  return status === undefined || status === 400 || status === 422;
}

export function providerOptionsFor(model: AgentModelConfig): Record<string, Record<string, string | { type: "disabled" }>> | undefined {
  if (!model.reasoningEffort) return undefined;
  if (model.provider === "openai") {
    return { openai: { reasoningEffort: model.reasoningEffort } };
  }
  if (model.provider === "anthropic") {
    return model.reasoningEffort === "none"
      ? { anthropic: { thinking: { type: "disabled" } } }
      : { anthropic: { effort: model.reasoningEffort } };
  }
  const providerKey = (model.adapterName ?? "novel-studio")
    .replace(/[_-]([a-z])/g, (_match, char: string) => char.toUpperCase());
  return { [providerKey]: { reasoningEffort: model.reasoningEffort } };
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

export function normalizePromptMessages(request: Pick<AgentRunRequest, "system" | "promptBlocks">): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemParts: string[] = [];
  const seen = new Set<string>();
  const addSystem = (content: string) => {
    const trimmed = content.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      systemParts.push(trimmed);
    }
  };
  if (request.system) addSystem(request.system);
  for (const block of request.promptBlocks ?? []) {
    if (block.role === "system") addSystem(block.content);
  }
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: (request.promptBlocks ?? [])
      .filter((block) => block.role !== "system")
      .map((block) => ({ role: block.role as "user" | "assistant", content: block.content })),
  };
}

class AiSdkAgentRuntime implements AgentRuntime {
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    try {
      const baseURL = request.model.baseUrl || undefined;
      const model = request.model.provider === "anthropic"
        ? createAnthropic({ apiKey: request.model.apiKey, baseURL })(request.model.model)
        : request.model.provider === "openai-compatible"
          ? createOpenAICompatible({
            name: request.model.adapterName ?? "novel-studio",
            apiKey: request.model.apiKey,
            baseURL: request.model.baseUrl ?? "",
          })(request.model.model)
          : request.model.baseUrl
            ? createOpenAI({ apiKey: request.model.apiKey, baseURL }).chat(request.model.model)
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
      const normalizedPrompt = normalizePromptMessages(request);
      const result = streamText({
        model,
        ...(normalizedPrompt.system ? { system: normalizedPrompt.system } : {}),
        ...(request.promptBlocks !== undefined
          ? {
              messages: [...normalizedPrompt.messages, { role: "user" as const, content: payload }],
            }
          : { prompt: payload }),
        tools,
        stopWhen: request.maxSteps ? isStepCount(request.maxSteps) : undefined,
        ...runtimeSamplingOptions(request),
        providerOptions: providerOptionsFor(request.model),
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
    } catch (error) {
      if (error instanceof ReasoningEffortUnsupportedError) throw error;
      if (isReasoningEffortUnsupportedError(error) && request.model.reasoningEffort) {
        throw new ReasoningEffortUnsupportedError({
          reasoningEffort: request.model.reasoningEffort,
          model: request.model.model,
          provider: request.model.provider,
          configName: request.model.configName,
          providerMessage: sanitizeProviderMessage(error instanceof Error ? error.message : String(error)),
        });
      }
      throw error;
    }
  }
}

export const agentRuntime: AgentRuntime = new AiSdkAgentRuntime();
