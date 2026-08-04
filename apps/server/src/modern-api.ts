import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentRuntime, assemblePromptMessages, type AgentModelConfig } from "./agent-runtime.js";
import { getCredential } from "./credentials.js";
import { isoNow, newId, sqlite } from "./db.js";
import { discoverModels, getModernModel, getModernModelCredential, listModernModels, saveModernModel } from "./modern-models.js";
import {
  AGENT_ROLES,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  PROMPT_BLOCK_ROLES,
  PROMPT_TRIGGER_SCOPES,
  REVIEW_KINDS,
  REVIEW_STATUSES,
  SOURCE_FILE_AREAS,
  SOURCE_FILE_KINDS,
  appendMessage,
  createMemoryEntry,
  createProject,
  createReviewReport,
  createSession,
  createSourceFile,
  createTask,
  deleteMemoryEntry,
  deleteReviewReport,
  getAgentProfile,
  getCatalog,
  getMemoryEntry,
  getProject,
  getSession,
  getSkill,
  getSourceFile,
  initModernStore,
  listAgentProfiles,
  listAgentPromptBlocks,
  listAgentPromptBlocksByProject,
  listMemoryEntries,
  listMessages,
  listProjects,
  listReviewReports,
  listSessions,
  listSourceFiles,
  listTasks,
  promoteSourceAtomically,
  saveAgentPromptBlocks,
  updateSourceFile,
  updateMemoryEntry,
  updateReviewReport,
  updateTask,
  upsertAgentProfile,
  upsertCatalog,
  upsertSkill,
  type AgentRole,
  type JsonRecord,
  type MemoryEntry,
  type SourceFile,
} from "./modern-store.js";

const messageSchema = z.object({ content: z.string().trim().min(1).max(50_000) });
const projectSchema = z.object({ name: z.string().trim().min(1).max(500) });
const sourceSchema = z.object({
  kind: z.enum(SOURCE_FILE_KINDS),
  area: z.enum(SOURCE_FILE_AREAS),
  title: z.string().trim().min(1).max(500),
  content: z.string().max(1_000_000).default(""),
  sourceFileId: z.string().nullable().optional(),
  sourceVersion: z.string().nullable().optional(),
});
const sourceUpdateSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  content: z.string().max(1_000_000).optional(),
  status: z.enum(["active", "archived"]).optional(),
  expectedVersion: z.number().int().min(1).optional(),
});
const sessionSchema = z.object({ title: z.string().trim().max(500).optional() });
const memorySchema = z.object({
  title: z.string().trim().min(1).max(500),
  kind: z.enum(MEMORY_KINDS),
  status: z.enum(MEMORY_STATUSES).default("draft"),
  content: z.string().max(1_000_000).default(""),
  sourceFileId: z.string().nullable().optional(),
  sourceVersion: z.string().nullable().optional(),
  basePriority: z.number().finite().min(0).max(1).default(0.5),
});
const taskSchema = z.object({
  targetAgent: z.enum(AGENT_ROLES),
  type: z.string().trim().min(1).max(120),
  payload: z.record(z.string(), z.unknown()).default({}),
  sessionId: z.string().nullable().optional(),
});
const reportSchema = z.object({
  kind: z.enum(REVIEW_KINDS),
  targetFileId: z.string().nullable().optional(),
  targetTaskId: z.string().nullable().optional(),
  content: z.string().max(200_000).default(""),
  status: z.enum(REVIEW_STATUSES).default("open"),
});
const promotionSchema = z.object({ override: z.boolean().default(false), reason: z.string().trim().max(2_000).optional() });
const promptBlockSchema = z.object({
  id: z.string().max(128).optional(),
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  pinned: z.boolean().default(false),
  role: z.enum(PROMPT_BLOCK_ROLES).default("system"),
  position: z.number().int().min(0).max(10_000).default(0),
  depth: z.number().int().min(0).max(10_000).default(0),
  triggerScope: z.enum(PROMPT_TRIGGER_SCOPES).default("always"),
  content: z.string().max(100_000).default(""),
});
const agentSchema = z.object({
  role: z.enum(AGENT_ROLES),
  enabled: z.boolean().default(true),
  prompt: z.string().max(100_000).optional(),
  promptBlocks: z.array(promptBlockSchema).max(200).optional(),
  modelProfile: z.string().max(120).default(""),
});
const modernModelConfigSchema = z.object({
  name: z.string().trim().min(1).max(200),
  provider: z.enum(["openai", "anthropic", "openai-compatible"]),
  model: z.string().max(200),
  baseUrl: z.string().max(500).optional(),
  temperature: z.number().min(0).max(2).optional(),
  reasoningEffort: z.enum(["none", "low", "medium", "high"]).optional(),
  topP: z.number().min(0).max(1).optional(),
  contextLength: z.number().int().min(1_024).max(2_000_000).optional(),
  maxOutputTokens: z.number().int().min(256).max(100_000).optional(),
  enabled: z.boolean().optional(),
  apiKey: z.string().max(2000).optional(),
});

type ContextCandidate = {
  id: string;
  title: string;
  kind: string;
  source: "memory" | "source" | "review";
  summary: string;
  content?: string;
  basePriority: number;
  relevance: number;
  layer: "core" | "working" | "reference";
  fullText: boolean;
};

function projectParams(projectId: string) {
  return z.string().trim().min(1).max(128).parse(projectId);
}

function scoreText(query: string, ...values: string[]) {
  const normalized = query.toLocaleLowerCase();
  const terms = normalized.split(/[\s,，。；;、:：!?！？/]+/).filter((term) => term.length >= 2);
  if (!terms.length) return 0;
  const haystack = values.join(" ").toLocaleLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function buildContext(projectId: string, targetAgent: AgentRole, query: string, maxInputTokens = 48_000): ContextCandidate[] {
  const entries = listMemoryEntries(projectId, { status: "formal" });
  const candidates: ContextCandidate[] = entries.map((entry: MemoryEntry) => {
    const skill = getSkill(projectId, entry.id);
    const relevance = scoreText(query, entry.title, skill?.summary ?? "", ...(skill?.keywords ?? []));
    const layer = entry.basePriority >= 0.85 ? "core" : relevance > 0 ? "working" : "reference";
    return {
      id: entry.id,
      title: entry.title,
      kind: "memory",
      source: "memory",
      summary: skill?.summary || entry.content.slice(0, 180),
      content: relevance > 0 || entry.basePriority >= 0.85 ? entry.content : undefined,
      basePriority: entry.basePriority,
      relevance,
      layer,
      fullText: relevance > 0 || entry.basePriority >= 0.85,
    };
  });

  for (const file of listSourceFiles(projectId, { area: "formal" })) {
    const relevance = scoreText(query, file.title, file.content.slice(0, 1200));
    candidates.push({
      id: file.id,
      title: file.title,
      kind: file.kind,
      source: "source",
      summary: file.content.slice(0, 180),
      content: relevance > 0 ? file.content : undefined,
      basePriority: file.kind === "setting" ? 0.7 : 0.5,
      relevance,
      layer: relevance > 0 ? "working" : "reference",
      fullText: relevance > 0,
    });
  }

  if (targetAgent === "main") {
    const catalog = getCatalog(projectId, "review");
    if (catalog?.content.trim()) {
      candidates.unshift({
        id: `review-catalog:${projectId}`,
        title: "待处理审查目录",
        kind: "review_catalog",
        source: "review",
        summary: catalog.content.slice(0, 500),
        content: catalog.content,
        basePriority: 1,
        relevance: 10,
        layer: "core",
        fullText: true,
      });
    }
  }

  const reserve = Math.min(2_000, Math.max(256, Math.floor(maxInputTokens * 0.1)));
  const tokenLimit = maxInputTokens - reserve;
  let used = 0;
  return candidates
    .sort((a, b) => (b.basePriority + b.relevance * 0.2) - (a.basePriority + a.relevance * 0.2))
    .slice(0, 12)
    .filter((candidate) => {
      const text = candidate.fullText ? candidate.content ?? candidate.summary : `[简介] ${candidate.summary}`;
      const estimated = Math.max(1, Math.ceil(text.length / 2.2));
      if (used + estimated > tokenLimit) return false;
      used += estimated;
      return true;
    });
}

function contextText(candidates: ContextCandidate[]) {
  return candidates.map((candidate) => {
    const text = candidate.fullText ? candidate.content ?? candidate.summary : `[简介] ${candidate.summary}`;
    return `## ${candidate.title}\n${text}`;
  }).join("\n\n");
}

function makeTaskResult(projectId: string, sessionId: string | null, targetAgent: AgentRole, type: string, payload: JsonRecord, result: JsonRecord) {
  const task = createTask({ projectId, sessionId, targetAgent, type, payload });
  updateTask(projectId, task.id, { status: "running", expectedStatus: "queued" });
  return updateTask(projectId, task.id, { status: "succeeded", result, expectedStatus: "running" });
}

function modelForMain(projectId: string): { config: AgentModelConfig; temperature: number; topP: number; contextLength: number; maxOutputTokens: number } | null {
  const profile = getAgentProfile(projectId, "main");
  if (!profile?.enabled || !profile.modelProfile) return null;
  const model = getModernModel(profile.modelProfile);
  const apiKey = getModernModelCredential(profile.modelProfile);
  if (!model || !model.enabled || !apiKey || !model.model) return null;
  if (model.provider === "openai-compatible" && !model.baseUrl) return null;
  return {
    config: {
      provider: model.provider,
      model: model.model,
      apiKey,
      baseUrl: model.baseUrl || undefined,
      adapterName: "novel-studio-modern-main",
    },
    temperature: model.temperature,
    topP: model.topP,
    contextLength: model.contextLength,
    maxOutputTokens: model.maxOutputTokens,
  };
}

async function runMainModel(
  projectId: string,
  context: string,
  session: string,
  authorMessage: string,
  model: NonNullable<ReturnType<typeof modelForMain>>,
) {
  const promptBlocks = assemblePromptMessages(listAgentPromptBlocks(projectId, "main"), "chat");
  const result = await agentRuntime.run({
    model: model.config,
    system: "你是 Novel Studio 的主 Agent。你只负责与作者交流、理解需求、拆分任务和汇总结果，不直接写正文或修改项目文件。请用简洁、具体的中文回应，并说明下一步会调用哪些 Agent。",
    promptBlocks,
    contextPayload: context,
    sessionPayload: session,
    prompt: authorMessage,
    temperature: model.temperature,
    topP: model.topP,
    maxOutputTokens: model.maxOutputTokens,
    abortSignal: new AbortController().signal,
    onTextDelta: () => undefined,
  });
  return result.text.trim() || "主 Agent 没有生成可显示的回复。";
}

function ensureProject(projectId: string) {
  const project = getProject(projectId);
  if (!project) throw new Error("作品不存在");
  return project;
}

function compactMemory(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 4_000);
}

export async function registerModernRoutes(app: FastifyInstance) {
  initModernStore();

  app.get("/api/modern/projects", async () => listProjects());
  app.post("/api/modern/projects", async (request, reply) => {
    const body = projectSchema.parse(request.body);
    const project = createProject({ id: newId(), name: body.name });
    createSession({ projectId: project.id, title: "主 Agent" });
    return reply.status(201).send(project);
  });
  app.get<{ Params: { projectId: string } }>("/api/modern/projects/:projectId", async (request, reply) => {
    const project = getProject(projectParams(request.params.projectId));
    if (!project) return reply.status(404).send({ error: "作品不存在" });
    return project;
  });

  app.get<{ Params: { projectId: string }; Querystring: { kind?: string; area?: string } }>("/api/modern/projects/:projectId/sources", async (request) => {
    const projectId = projectParams(request.params.projectId);
    ensureProject(projectId);
    return listSourceFiles(projectId, {
      kind: request.query.kind as typeof SOURCE_FILE_KINDS[number] | undefined,
      area: request.query.area as typeof SOURCE_FILE_AREAS[number] | undefined,
    });
  });
  app.post<{ Params: { projectId: string } }>("/api/modern/projects/:projectId/sources", async (request, reply) => {
    const projectId = projectParams(request.params.projectId);
    ensureProject(projectId);
    const body = sourceSchema.parse(request.body);
    return reply.status(201).send(createSourceFile({ ...body, projectId }));
  });
  app.get<{ Params: { projectId: string; sourceId: string } }>("/api/modern/projects/:projectId/sources/:sourceId", async (request, reply) => {
    const source = getSourceFile(projectParams(request.params.projectId), request.params.sourceId);
    if (!source) return reply.status(404).send({ error: "资料文件不存在" });
    return source;
  });
  app.patch<{ Params: { projectId: string; sourceId: string } }>("/api/modern/projects/:projectId/sources/:sourceId", async (request) => {
    return updateSourceFile(projectParams(request.params.projectId), request.params.sourceId, sourceUpdateSchema.parse(request.body));
  });
  app.post<{ Params: { projectId: string; sourceId: string } }>("/api/modern/projects/:projectId/sources/:sourceId/promote", async (request, reply) => {
    const projectId = projectParams(request.params.projectId);
    const source = getSourceFile(projectId, request.params.sourceId);
    if (!source) return reply.status(404).send({ error: "草稿不存在" });
    if (source.area !== "draft") return reply.status(409).send({ error: "只有草稿可以转为正式版本" });
    const body = promotionSchema.parse(request.body);
    const reviewTask = makeTaskResult(projectId, null, "logic_review", "promotion_preflight", { sourceFileId: source.id }, { checked: [source.title], blockers: source.content.trim() ? [] : ["文件内容为空"] });
    const blockers = source.content.trim() ? [] : ["文件内容为空"];
    if (blockers.length && !body.override) {
      const report = createReviewReport({ projectId, kind: "logic", targetFileId: source.id, targetTaskId: reviewTask.id, status: "open", content: blockers.join("\n") });
      return reply.status(409).send({ error: "初审发现阻断问题", report, blockers });
    }
    if (blockers.length && !body.reason) return reply.status(400).send({ error: "覆盖审查问题必须填写理由" });
    const fidelityTask = makeTaskResult(projectId, null, "logic_review", "fidelity_review", { sourceFileId: source.id }, { checked: [source.title], passed: true, note: "当前纵向切片使用确定性摘要，待配置记忆管理模型后替换为模型审查" });
    const promoted = promoteSourceAtomically({
      projectId,
      sourceFileId: source.id,
      memoryContent: compactMemory(source.content),
      memorySummary: compactMemory(source.content).slice(0, 240),
      memoryPurpose: `辅助 Agent 理解${source.title}`,
      keywords: source.title.split(/[\s，、,。]+/).filter(Boolean).slice(0, 12),
      basePriority: source.kind === "setting" ? 0.75 : 0.6,
    });
    const memoryTask = makeTaskResult(projectId, null, "memory_manager", "promote_memory", { sourceFileId: source.id, formalFileId: promoted.source.id }, { memoryId: promoted.memory.id, formalFileId: promoted.source.id, overridden: body.override, fidelityTaskId: fidelityTask.id });
    if (body.override) createReviewReport({ projectId, kind: "logic", targetFileId: source.id, targetTaskId: reviewTask.id, status: "overridden", content: `${body.reason}\n\n原始问题：${blockers.join("；")}` });
    return reply.status(201).send({ ...promoted, reviewTask, fidelityTask, memoryTask });
  });

  app.get<{ Params: { projectId: string } }>("/api/modern/projects/:projectId/sessions", async (request) => listSessions(projectParams(request.params.projectId)));
  app.post<{ Params: { projectId: string } }>("/api/modern/projects/:projectId/sessions", async (request, reply) => {
    const projectId = projectParams(request.params.projectId);
    ensureProject(projectId);
    return reply.status(201).send(createSession({ projectId, ...sessionSchema.parse(request.body) }));
  });
  app.get<{ Params: { projectId: string; sessionId: string } }>("/api/modern/projects/:projectId/sessions/:sessionId/messages", async (request) => {
    const projectId = projectParams(request.params.projectId);
    if (!getSession(projectId, request.params.sessionId)) throw new Error("会话不存在");
    return listMessages(projectId, request.params.sessionId);
  });
  app.post<{ Params: { projectId: string; sessionId: string } }>("/api/modern/projects/:projectId/sessions/:sessionId/messages", async (request, reply) => {
    const projectId = projectParams(request.params.projectId);
    const session = getSession(projectId, request.params.sessionId);
    if (!session) return reply.status(404).send({ error: "会话不存在" });
    const body = messageSchema.parse(request.body);
    const userMessage = appendMessage({ projectId, sessionId: session.id, role: "user", content: body.content });
    const mainModel = modelForMain(projectId);
    const candidates = buildContext(projectId, "main", body.content, mainModel?.contextLength);
    const contextTask = makeTaskResult(projectId, session.id, "context", "select_context", { query: body.content }, { candidates: candidates.map((candidate) => ({ id: candidate.id, title: candidate.title, layer: candidate.layer, fullText: candidate.fullText })) });
    const ranked = [...candidates].sort((a, b) => (b.basePriority + b.relevance) - (a.basePriority + a.relevance));
    const priorityTask = makeTaskResult(projectId, session.id, "priority", "rank_context", { candidateIds: candidates.map((candidate) => candidate.id) }, { ranked: ranked.map((candidate, index) => ({ id: candidate.id, rank: index + 1, layer: candidate.layer })) });
    const recent = listMessages(projectId, session.id).slice(-8).map((message) => `${message.role}: ${message.content}`).join("\n");
    const assistantText = mainModel
      ? await runMainModel(projectId, contextText(ranked), recent, body.content, mainModel)
      : "我已经收到你的要求。主 Agent 会先整理任务，再由上下文 Agent 选择相关记忆；当前尚未配置规划模型，因此这轮先记录为待处理任务。";
    const assistant = appendMessage({ projectId, sessionId: session.id, role: "main", content: assistantText });
    return reply.status(201).send({ userMessage, assistant, context: ranked, taskIds: [contextTask.id, priorityTask.id] });
  });

  app.get<{ Params: { projectId: string } }>("/api/modern/projects/:projectId/tasks", async (request) => listTasks(projectParams(request.params.projectId)));
  app.post<{ Params: { projectId: string } }>("/api/modern/projects/:projectId/tasks", async (request, reply) => {
    const projectId = projectParams(request.params.projectId);
    ensureProject(projectId);
    const body = taskSchema.parse(request.body);
    return reply.status(201).send(createTask({ projectId, ...body }));
  });

  app.get<{ Params: { projectId: string }; Querystring: { status?: string; kind?: string } }>("/api/modern/projects/:projectId/memory", async (request) => {
    const projectId = projectParams(request.params.projectId);
    ensureProject(projectId);
    return listMemoryEntries(projectId, {
      status: request.query.status as typeof MEMORY_STATUSES[number] | undefined,
      kind: request.query.kind as typeof MEMORY_KINDS[number] | undefined,
    }).map((entry) => ({ ...entry, skill: getSkill(projectId, entry.id) }));
  });
  app.post<{ Params: { projectId: string } }>("/api/modern/projects/:projectId/memory", async (request, reply) => {
    const projectId = projectParams(request.params.projectId);
    ensureProject(projectId);
    return reply.status(201).send(createMemoryEntry({ ...memorySchema.parse(request.body), projectId }));
  });
  app.patch<{ Params: { projectId: string; memoryId: string } }>("/api/modern/projects/:projectId/memory/:memoryId", async (request) => updateMemoryEntry(projectParams(request.params.projectId), request.params.memoryId, z.record(z.string(), z.unknown()).parse(request.body)));
  app.delete<{ Params: { projectId: string; memoryId: string } }>("/api/modern/projects/:projectId/memory/:memoryId", async (request) => {
    const body = z.object({ confirm: z.literal(true), expectedStatus: z.enum(MEMORY_STATUSES).optional() }).parse(request.body);
    deleteMemoryEntry(projectParams(request.params.projectId), request.params.memoryId, body.expectedStatus);
    return { ok: true };
  });
  app.get<{ Params: { projectId: string; memoryId: string } }>("/api/modern/projects/:projectId/memory/:memoryId/skill", async (request, reply) => {
    const skill = getSkill(projectParams(request.params.projectId), request.params.memoryId);
    if (!skill) return reply.status(404).send({ error: "记忆 skill 不存在" });
    return skill;
  });
  app.put<{ Params: { projectId: string; memoryId: string } }>("/api/modern/projects/:projectId/memory/:memoryId/skill", async (request) => upsertSkill(projectParams(request.params.projectId), request.params.memoryId, request.body as { summary: string; purpose?: string; keywords?: string[]; related?: string[]; sourceVersion?: string | null }));
  app.get<{ Params: { projectId: string; kind: string } }>("/api/modern/projects/:projectId/catalogs/:kind", async (request, reply) => {
    const catalog = getCatalog(projectParams(request.params.projectId), request.params.kind);
    if (!catalog) return reply.status(404).send({ error: "目录不存在" });
    return catalog;
  });
  app.put<{ Params: { projectId: string; kind: string } }>("/api/modern/projects/:projectId/catalogs/:kind", async (request) => upsertCatalog(projectParams(request.params.projectId), request.params.kind, z.string().max(200_000).parse((request.body as { content?: unknown })?.content)));

  app.get<{ Params: { projectId: string }; Querystring: { status?: string; kind?: string } }>("/api/modern/projects/:projectId/reviews", async (request) => listReviewReports(projectParams(request.params.projectId), {
    status: request.query.status as typeof REVIEW_STATUSES[number] | undefined,
    kind: request.query.kind as typeof REVIEW_KINDS[number] | undefined,
  }));
  app.post<{ Params: { projectId: string } }>("/api/modern/projects/:projectId/reviews", async (request, reply) => {
    const projectId = projectParams(request.params.projectId);
    ensureProject(projectId);
    return reply.status(201).send(createReviewReport({ ...reportSchema.parse(request.body), projectId }));
  });
  app.patch<{ Params: { projectId: string; reportId: string } }>("/api/modern/projects/:projectId/reviews/:reportId", async (request) => {
    const projectId = projectParams(request.params.projectId);
    const updated = updateReviewReport(projectId, request.params.reportId, z.record(z.string(), z.unknown()).parse(request.body));
    if (updated.status === "resolved") {
      deleteReviewReport(projectId, updated.id);
      return { ...updated, deleted: true };
    }
    return updated;
  });
  app.delete<{ Params: { projectId: string; reportId: string } }>("/api/modern/projects/:projectId/reviews/:reportId", async (request) => {
    deleteReviewReport(projectParams(request.params.projectId), request.params.reportId);
    return { ok: true };
  });

  app.get<{ Params: { projectId: string } }>("/api/modern/projects/:projectId/agents", async (request) => listAgentProfiles(projectParams(request.params.projectId)));
  app.get<{ Params: { projectId: string } }>("/api/modern/projects/:projectId/agents/prompts", async (request) => {
    const projectId = projectParams(request.params.projectId);
    ensureProject(projectId);
    return listAgentPromptBlocksByProject(projectId);
  });
  app.get<{ Params: { projectId: string; role: AgentRole } }>("/api/modern/projects/:projectId/agents/:role/prompts", async (request) => {
    const projectId = projectParams(request.params.projectId);
    ensureProject(projectId);
    return listAgentPromptBlocks(projectId, request.params.role);
  });
  app.put<{ Params: { projectId: string; role: AgentRole } }>("/api/modern/projects/:projectId/agents/:role", async (request) => {
    const projectId = projectParams(request.params.projectId);
    ensureProject(projectId);
    const body = agentSchema.parse({ ...(typeof request.body === "object" && request.body !== null ? request.body : {}), role: request.params.role });
    return upsertAgentProfile(projectId, body);
  });
  app.put<{ Params: { projectId: string; role: AgentRole } }>("/api/modern/projects/:projectId/agents/:role/prompts", async (request) => {
    const projectId = projectParams(request.params.projectId);
    ensureProject(projectId);
    const body = z.object({ blocks: z.array(promptBlockSchema).max(200) }).parse(request.body);
    return saveAgentPromptBlocks(projectId, request.params.role, body);
  });

  app.get("/api/modern/models", async () => listModernModels());
  app.post("/api/modern/models/discover", async (request, reply) => {
    const body = z.object({
      provider: z.enum(["openai", "anthropic", "openai-compatible"]),
      baseUrl: z.string().max(500).optional(),
      apiKey: z.string().min(1).max(2000),
    }).parse(request.body);
    try {
      return reply.send({ models: await discoverModels(body) });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : "模型发现失败" });
    }
  });
  app.post("/api/modern/models", async (request, reply) => {
    const body = modernModelConfigSchema.parse(request.body);
    return reply.status(201).send(saveModernModel(null, body));
  });
  app.put<{ Params: { modelId: string } }>("/api/modern/models/:modelId", async (request) => {
    const body = modernModelConfigSchema.parse(request.body);
    return saveModernModel(request.params.modelId, body);
  });
}
