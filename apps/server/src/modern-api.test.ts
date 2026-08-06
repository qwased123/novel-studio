import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRuntime, ReasoningEffortUnsupportedError } from "./agent-runtime.js";
import { getCredential, setCredential } from "./credentials.js";
import { sqlite } from "./db.js";
import { registerModernRoutes } from "./modern-api.js";

const apps: ReturnType<typeof Fastify>[] = [];

async function modernApp() {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.status(500).send({ error: error.message }));
  await registerModernRoutes(app);
  await app.ready();
  apps.push(app);
  return app;
}

async function json<T>(app: ReturnType<typeof Fastify>, url: string, init: { method?: string; body?: unknown } = {}) {
  const response = await app.inject({
    method: init.method ?? "GET",
    url,
    payload: init.body,
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
  });
  return { response, body: response.body ? JSON.parse(response.body) as T : null };
}

function streamResponse(text: string) {
  const chunks = [
    { id: "mock-1", object: "chat.completion.chunk", created: 1, model: "mock-writer", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "mock-1", object: "chat.completion.chunk", created: 1, model: "mock-writer", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("modern HTTP workflow", () => {
  it("keeps main chat isolated and records context before priority", async () => {
    const app = await modernApp();
    const created = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `聊天-${crypto.randomUUID()}` } });
    expect(created.response.statusCode).toBe(201);
    const projectId = created.body.id;
    const sessions = await json<Array<{ id: string }>>(app, `/api/modern/projects/${projectId}/sessions`);
    const sessionId = sessions.body[0].id;
    const memory = await json<{ id: string }>(app, `/api/modern/projects/${projectId}/memory`, {
      method: "POST",
      body: { title: "雾城", kind: "native", status: "formal", content: "雾城位于海边。", basePriority: 0.9 },
    });
    expect(memory.response.statusCode).toBe(201);

    const message = await json<{ taskIds: string[]; context: Array<{ id: string }> }>(app, `/api/modern/projects/${projectId}/sessions/${sessionId}/messages`, {
      method: "POST",
      body: { content: "请讨论雾城的气候" },
    });
    expect(message.response.statusCode).toBe(201);
    expect(message.body.context.some((item) => item.id === memory.body.id)).toBe(true);
    expect(message.body.taskIds).toHaveLength(2);
    const tasks = await json<Array<{ id: string; targetAgent: string; type: string }>>(app, `/api/modern/projects/${projectId}/tasks`);
    expect(tasks.body.filter((task) => message.body.taskIds.includes(task.id)).map((task) => task.targetAgent)).toEqual(expect.arrayContaining(["context", "priority"]));
    expect(tasks.body.filter((task) => message.body.taskIds.includes(task.id)).map((task) => task.type)).toEqual(expect.arrayContaining(["select_context", "rank_context"]));

    const second = await json<{ id: string }>(app, `/api/modern/projects/${projectId}/sessions`, { method: "POST", body: { title: "另一讨论" } });
    const otherMessages = await json<unknown[]>(app, `/api/modern/projects/${projectId}/sessions/${second.body.id}/messages`);
    expect(otherMessages.body).toEqual([]);
  });

  it("requires preflight for empty drafts and promotes a reviewed draft with its memory", async () => {
    const app = await modernApp();
    const project = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `晋级-${crypto.randomUUID()}` } });
    const draft = await json<{ id: string; version: number }>(app, `/api/modern/projects/${project.body.id}/sources`, {
      method: "POST", body: { kind: "setting", area: "draft", title: "空设定", content: "" },
    });
    expect(draft.response.statusCode, draft.response.body).toBe(201);
    const blocked = await json<{ blockers: string[] }>(app, `/api/modern/projects/${project.body.id}/sources/${draft.body.id}/promote`, { method: "POST", body: {} });
    expect(blocked.response.statusCode).toBe(409);
    expect(blocked.body.blockers).toContain("文件内容为空");
    const reports = await json<Array<{ status: string; kind: string }>>(app, `/api/modern/projects/${project.body.id}/reviews`);
    expect(reports.body[0]).toMatchObject({ status: "open", kind: "logic" });

    const editable = await json<{ id: string; version: number }>(app, `/api/modern/projects/${project.body.id}/sources`, {
      method: "POST", body: { kind: "setting", area: "draft", title: "正式设定", content: "档案馆在城东。" },
    });
    const changed = await json<{ version: number }>(app, `/api/modern/projects/${project.body.id}/sources/${editable.body.id}`, {
      method: "PATCH", body: { content: "档案馆在城东，地下有旧井。", expectedVersion: 1 },
    });
    expect(changed.body.version).toBe(2);
    const promoted = await json<{ source: { id: string; area: string; version: number }; memory: { id: string; status: string }; skill: { id: string; summary: string }; catalog: { content: string } }>(app, `/api/modern/projects/${project.body.id}/sources/${editable.body.id}/promote`, { method: "POST", body: {} });
    expect(promoted.response.statusCode).toBe(201);
    expect(promoted.body.source).toMatchObject({ area: "formal", version: 1 });
    expect(promoted.body.memory.status).toBe("formal");
    expect(promoted.body.skill.summary).toContain("档案馆");
    expect(promoted.body.catalog.content).toContain("正式设定");

    const repeated = await json<{ source: { id: string }; memory: { id: string }; skill: { id: string } }>(app, `/api/modern/projects/${project.body.id}/sources/${editable.body.id}/promote`, { method: "POST", body: {} });
    expect(repeated.response.statusCode).toBe(201);
    expect(repeated.body.source.id).toBe(promoted.body.source.id);
    expect(repeated.body.memory.id).toBe(promoted.body.memory.id);
    expect(repeated.body.skill.id).toBe(promoted.body.skill.id);
    const formals = await json<Array<{ id: string; sourceFileId: string | null }>>(app, `/api/modern/projects/${project.body.id}/sources?area=formal`);
    expect(formals.body.filter((file) => file.sourceFileId === editable.body.id)).toHaveLength(1);
    const memories = await json<Array<{ id: string; sourceFileId: string | null }>>(app, `/api/modern/projects/${project.body.id}/memory`);
    expect(memories.body.filter((entry) => entry.sourceFileId === promoted.body.source.id)).toHaveLength(1);
  });

  it("deletes retired memory and only resolved review reports", async () => {
    const app = await modernApp();
    const project = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `生命周期-${crypto.randomUUID()}` } });
    const memory = await json<{ id: string }>(app, `/api/modern/projects/${project.body.id}/memory`, { method: "POST", body: { title: "退役记忆", kind: "native", status: "formal", content: "旧资料" } });
    const rejected = await json<{ error: string }>(app, `/api/modern/projects/${project.body.id}/memory/${memory.body.id}`, { method: "DELETE", body: { confirm: true, expectedStatus: "draft" } });
    expect(rejected.response.statusCode).toBe(500);
    const deleted = await json<{ ok: boolean }>(app, `/api/modern/projects/${project.body.id}/memory/${memory.body.id}`, { method: "DELETE", body: { confirm: true, expectedStatus: "formal" } });
    expect(deleted.body.ok).toBe(true);

    const source = await json<{ id: string }>(app, `/api/modern/projects/${project.body.id}/sources`, { method: "POST", body: { kind: "setting", area: "formal", title: "审查对象", content: "内容" } });
    const report = await json<{ id: string }>(app, `/api/modern/projects/${project.body.id}/reviews`, { method: "POST", body: { kind: "logic", targetFileId: source.body.id, content: "问题" } });
    const pendingDelete = await json<{ error: string }>(app, `/api/modern/projects/${project.body.id}/reviews/${report.body.id}`, { method: "DELETE" });
    expect(pendingDelete.response.statusCode).toBe(500);
    const resolved = await json<{ deleted: boolean }>(app, `/api/modern/projects/${project.body.id}/reviews/${report.body.id}`, { method: "PATCH", body: { status: "resolved" } });
    expect(resolved.body.deleted).toBe(true);
    const remaining = await json<Array<{ id: string }>>(app, `/api/modern/projects/${project.body.id}/reviews`);
    expect(remaining.body.some((entry) => entry.id === report.body.id)).toBe(false);
  });

  it("exposes ordered prompt blocks and saves them through the agent profile route", async () => {
    const app = await modernApp();
    const project = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `提示块-${crypto.randomUUID()}` } });
    const projectId = project.body.id;

    const prompts = await json<Record<string, Array<Record<string, unknown>>>>(app, `/api/modern/projects/${projectId}/agents/prompts`);
    expect(prompts.response.statusCode).toBe(200);
    const mainBlocks = prompts.body.main;
    expect(mainBlocks.some((block) => block.name === "主 Agent 职责")).toBe(true);
    expect(mainBlocks.some((block) => block.pinned === true)).toBe(true);

    const rolePrompts = await json<Array<Record<string, unknown>>>(app, `/api/modern/projects/${projectId}/agents/main/prompts`);
    expect(rolePrompts.body).toHaveLength(mainBlocks.length);

    const replaced = mainBlocks.map((block) => block.name === "主 Agent 职责" ? { ...block, content: "已编辑的职责" } : block);
    const saved = await json<{ prompt: string }>(app, `/api/modern/projects/${projectId}/agents/main`, {
      method: "PUT",
      body: { enabled: true, modelProfile: "", promptBlocks: replaced },
    });
    expect(saved.response.statusCode).toBe(200);
    expect(saved.body.prompt).toBe("");
    const after = await json<Array<Record<string, unknown>>>(app, `/api/modern/projects/${projectId}/agents/main/prompts`);
    expect((after.body.find((block) => block.name === "主 Agent 职责") as Record<string, unknown>).content).toBe("已编辑的职责");

    const legacy = await json<Record<string, unknown>>(app, `/api/modern/projects/${projectId}/agents/writer`, {
      method: "PUT",
      body: { prompt: "旧版自定义" },
    });
    expect(legacy.response.statusCode).toBe(200);
    const writerBlocks = await json<Array<Record<string, unknown>>>(app, `/api/modern/projects/${projectId}/agents/writer/prompts`);
    expect((writerBlocks.body.find((block) => block.name === "自定义提示词（旧版）") as Record<string, unknown>).content).toBe("旧版自定义");

    const guarded = await json<{ error: string }>(app, `/api/modern/projects/${projectId}/agents/main`, {
      method: "PUT",
      body: { promptBlocks: [{ name: "替换", role: "system", content: "x" }] },
    });
    expect(guarded.response.statusCode).toBe(500);
    expect(guarded.body.error).toContain("固定提示块");
  });

  it("persists a bound model config on the agent profile through the API", async () => {
    const app = await modernApp();
    const project = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `绑定模型-${crypto.randomUUID()}` } });
    const model = await json<{ id: string }>(app, "/api/modern/models", {
      method: "POST",
      body: { name: "绑定模型", provider: "openai", model: "gpt-5", apiKey: "sk-test" },
    });
    expect(model.response.statusCode).toBe(201);

    const saved = await json<{ modelProfile: string }>(app, `/api/modern/projects/${project.body.id}/agents/main`, {
      method: "PUT",
      body: { enabled: true, modelProfile: model.body.id },
    });
    expect(saved.response.statusCode).toBe(200);
    expect(saved.body.modelProfile).toBe(model.body.id);

    const agents = await json<Array<{ role: string; modelProfile: string }>>(app, `/api/modern/projects/${project.body.id}/agents`);
    expect(agents.body.find((profile) => profile.role === "main")).toMatchObject({ modelProfile: model.body.id });

    const updated = await json<{ modelProfile: string }>(app, `/api/modern/projects/${project.body.id}/agents/main`, {
      method: "PUT",
      body: { enabled: true, modelProfile: "replacement-model" },
    });
    expect(updated.body.modelProfile).toBe("replacement-model");
    const after = await json<Array<{ role: string; modelProfile: string }>>(app, `/api/modern/projects/${project.body.id}/agents`);
    expect(after.body.find((profile) => profile.role === "main")?.modelProfile).toBe("replacement-model");
  });

  it("deletes one session and its messages while preserving other sessions and projects", async () => {
    const app = await modernApp();
    const first = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `会话删除-A-${crypto.randomUUID()}` } });
    const second = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `会话保留-B-${crypto.randomUUID()}` } });
    const initialSessions = await json<Array<{ id: string }>>(app, `/api/modern/projects/${first.body.id}/sessions`);
    const keptSession = initialSessions.body[0]!;
    const firstSession = await json<{ id: string }>(app, `/api/modern/projects/${first.body.id}/sessions`, { method: "POST", body: { title: "待删" } });
    const otherSession = await json<{ id: string }>(app, `/api/modern/projects/${second.body.id}/sessions`, { method: "POST", body: { title: "B" } });
    await json(app, `/api/modern/projects/${first.body.id}/sessions/${firstSession.body.id}/messages`, { method: "POST", body: { content: "删除我" } });
    await json(app, `/api/modern/projects/${first.body.id}/sessions/${keptSession.id}/messages`, { method: "POST", body: { content: "保留我" } });
    await json(app, `/api/modern/projects/${second.body.id}/sessions/${otherSession.body.id}/messages`, { method: "POST", body: { content: "B 保留" } });

    const unconfirmed = await json<{ error: string }>(app, `/api/modern/projects/${first.body.id}/sessions/${keptSession.id}`, { method: "DELETE", body: { confirm: false } });
    expect(unconfirmed.response.statusCode).toBe(400);

    const deleted = await json<{ ok: boolean }>(app, `/api/modern/projects/${first.body.id}/sessions/${firstSession.body.id}`, { method: "DELETE", body: { confirm: true } });
    expect(deleted.response.statusCode).toBe(200);
    expect(deleted.body.ok).toBe(true);
    const missing = await json<{ error: string }>(app, `/api/modern/projects/${first.body.id}/sessions/${firstSession.body.id}`, { method: "DELETE", body: { confirm: true } });
    expect(missing.response.statusCode).toBe(404);

    const sessions = await json<Array<{ id: string }>>(app, `/api/modern/projects/${first.body.id}/sessions`);
    expect(sessions.body.map((session) => session.id)).toEqual([keptSession.id]);
    const firstMessages = (sqlite.prepare("SELECT COUNT(*) AS count FROM modern_messages WHERE session_id = ? AND project_id = ?").get(firstSession.body.id, first.body.id) as { count: number }).count;
    const keptMessages = (sqlite.prepare("SELECT COUNT(*) AS count FROM modern_messages WHERE session_id = ? AND project_id = ?").get(keptSession.id, first.body.id) as { count: number }).count;
    const otherMessages = (sqlite.prepare("SELECT COUNT(*) AS count FROM modern_messages WHERE session_id = ? AND project_id = ?").get(otherSession.body.id, second.body.id) as { count: number }).count;
    expect(firstMessages).toBe(0);
    expect(keptMessages).toBe(1);
    expect(otherMessages).toBe(1);
    const secondSessions = await json<Array<{ id: string }>>(app, `/api/modern/projects/${second.body.id}/sessions`);
    expect(secondSessions.body.map((session) => session.id)).toContain(otherSession.body.id);
    expect(secondSessions.body).toHaveLength(2);
  });

  it("returns a model_not_configured notice without persisting an assistant configuration message", async () => {
    const app = await modernApp();
    const project = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `未配置模型-${crypto.randomUUID()}` } });
    const namedSession = await json<{ id: string }>(app, `/api/modern/projects/${project.body.id}/sessions`, { method: "POST", body: { title: "新会话" } });
    const sent = await json<{ assistant: unknown; notice?: { code: string; message: string }; taskIds: string[]; context: unknown[]; userMessage?: { id: string; role: string; content: string }; session?: { title: string } }>(
      app,
      `/api/modern/projects/${project.body.id}/sessions/${namedSession.body.id}/messages`,
      { method: "POST", body: { content: "请继续写作" } },
    );
    expect(sent.response.statusCode).toBe(201);
    expect(sent.body.assistant).toBeNull();
    expect(sent.body.userMessage).toMatchObject({ role: "user", content: "请继续写作" });
    expect(sent.body.session?.title).toBe("请继续写作");
    expect(sent.body.notice).toMatchObject({ code: "model_not_configured" });
    expect(sent.body.taskIds).toHaveLength(2);
    expect(Array.isArray(sent.body.context)).toBe(true);
    const messages = await json<Array<{ role: string; content: string }>>(app, `/api/modern/projects/${project.body.id}/sessions/${namedSession.body.id}/messages`);
    expect(messages.body.map((message) => message.role)).toEqual(["user"]);
    expect(messages.body.some((message) => message.content.includes("尚未配置规划模型"))).toBe(false);
    const renamedSessions = await json<Array<{ title: string }>>(app, `/api/modern/projects/${project.body.id}/sessions`);
    expect(renamedSessions.body[0]?.title).toBe("请继续写作");
  });

  it("keeps a normal configured-model assistant response unchanged", async () => {
    const app = await modernApp();
    const project = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `已配置模型-${crypto.randomUUID()}` } });
    const namedSession = await json<{ id: string }>(app, `/api/modern/projects/${project.body.id}/sessions`, { method: "POST", body: { title: "新会话" } });
    const model = await json<{ id: string }>(app, "/api/modern/models", {
      method: "POST",
      body: { name: "正常模型", provider: "openai", model: "gpt-5", apiKey: "sk-test" },
    });
    await json(app, `/api/modern/projects/${project.body.id}/agents/main`, { method: "PUT", body: { enabled: true, modelProfile: model.body.id } });
    const spy = vi.spyOn(agentRuntime, "run").mockResolvedValue({ text: "正常回复", inputTokens: 1, outputTokens: 1, toolCalls: [] });
    const sent = await json<{ assistant: { content: string } | null; notice: unknown; userMessage?: { content: string }; session?: { title: string } }>(
      app,
      `/api/modern/projects/${project.body.id}/sessions/${namedSession.body.id}/messages`,
      { method: "POST", body: { content: "你好" } },
    );
    expect(sent.response.statusCode).toBe(201);
    expect(sent.body.assistant?.content).toBe("正常回复");
    expect(sent.body.userMessage?.content).toBe("你好");
    expect(sent.body.session?.title).toBe("你好");
    expect(sent.body.notice).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("sends system prompt blocks through the top-level system option without InvalidPromptError", async () => {
    const fetchMock = vi.fn(async () => streamResponse("正常回复"));
    vi.stubGlobal("fetch", fetchMock);
    const app = await modernApp();
    const project = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `系统消息-${crypto.randomUUID()}` } });
    const model = await json<{ id: string }>(app, "/api/modern/models", {
      method: "POST",
      body: { name: "兼容模型", provider: "openai-compatible", model: "mock-writer", baseUrl: "http://mock.local/v1", apiKey: "sk-test" },
    });
    await json(app, `/api/modern/projects/${project.body.id}/agents/main`, { method: "PUT", body: { enabled: true, modelProfile: model.body.id } });
    const sessions = await json<Array<{ id: string }>>(app, `/api/modern/projects/${project.body.id}/sessions`);
    const sent = await json<{ assistant: { content: string } | null }>(
      app,
      `/api/modern/projects/${project.body.id}/sessions/${sessions.body[0]?.id}/messages`,
      { method: "POST", body: { content: "你好" } },
    );
    expect(sent.response.statusCode).toBe(201);
    expect(sent.body.assistant?.content).toBe("正常回复");
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content?: string }> };
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content).toContain("你是 Novel Studio 的主 Agent");
    expect(body.messages.filter((message) => message.role === "system")).toHaveLength(1);
  });

  it("names the session on first send even when the model request fails", async () => {
    const app = await modernApp();
    const project = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `失败命名-${crypto.randomUUID()}` } });
    const namedSession = await json<{ id: string }>(app, `/api/modern/projects/${project.body.id}/sessions`, { method: "POST", body: { title: "新会话" } });
    const model = await json<{ id: string }>(app, "/api/modern/models", {
      method: "POST",
      body: { name: "失败模型", provider: "openai", model: "gpt-5", apiKey: "sk-test" },
    });
    await json(app, `/api/modern/projects/${project.body.id}/agents/main`, { method: "PUT", body: { enabled: true, modelProfile: model.body.id } });
    vi.spyOn(agentRuntime, "run").mockRejectedValue(new Error("模型内部错误"));
    const sent = await json<{ error: string; code?: string }>(
      app,
      `/api/modern/projects/${project.body.id}/sessions/${namedSession.body.id}/messages`,
      { method: "POST", body: { content: "失败消息" } },
    );
    expect(sent.response.statusCode).toBe(502);
    expect(sent.body.error).toContain("模型内部错误");
    expect(sent.body.code).toBe("model_request_failed");
    const renamedSessions = await json<Array<{ title: string }>>(app, `/api/modern/projects/${project.body.id}/sessions`);
    expect(renamedSessions.body[0]?.title).toBe("失败消息");
  });

  it("stores modern model configs with topP and contextLength", async () => {
    const app = await modernApp();
    const created = await json<{ id: string; topP: number; contextLength: number; maxOutputTokens: number }>(app, "/api/modern/models", {
      method: "POST",
      body: { name: "主模型", provider: "openai", model: "gpt-4o", topP: 0.9, contextLength: 200_000 },
    });
    expect(created.response.statusCode).toBe(201);
    expect(created.body).toMatchObject({ topP: 0.9, contextLength: 200_000, maxOutputTokens: 8192 });

    const updated = await json<{ topP: number; contextLength: number }>(app, `/api/modern/models/${created.body.id}`, {
      method: "PUT",
      body: { name: "主模型", provider: "openai", model: "gpt-4o", topP: 0.7, contextLength: 128_000 },
    });
    expect(updated.body).toMatchObject({ topP: 0.7, contextLength: 128_000 });

    const listed = await json<Array<{ id: string; topP: number; contextLength: number }>>(app, "/api/modern/models");
    expect(listed.body.find((entry) => entry.id === created.body.id)).toMatchObject({ topP: 0.7, contextLength: 128_000 });
  });

  it("accepts 1,000,000 context length and arbitrary backend-valid max output integers", async () => {
    const app = await modernApp();
    const created = await json<{ id: string; reasoningEffort: string; contextLength: number; maxOutputTokens: number }>(app, "/api/modern/models", {
      method: "POST",
      body: { name: "大上下文", provider: "openai", model: "gpt-5", reasoningEffort: "xhigh", contextLength: 1_000_000, maxOutputTokens: 1_000 },
    });
    expect(created.response.statusCode).toBe(201);
    expect(created.body).toMatchObject({ reasoningEffort: "xhigh", contextLength: 1_000_000, maxOutputTokens: 1_000 });
  });

  it("deletes a modern project with cascade isolation and leaves credentials untouched", async () => {
    const app = await modernApp();
    const first = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `删除-A-${crypto.randomUUID()}` } });
    const second = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `保留-B-${crypto.randomUUID()}` } });
    await json(app, `/api/modern/projects/${first.body.id}/sources`, { method: "POST", body: { kind: "setting", area: "formal", title: "待删除资料" } });
    await json(app, `/api/modern/projects/${second.body.id}/sources`, { method: "POST", body: { kind: "setting", area: "formal", title: "保留资料" } });
    const credentialKey = "modern-model:delete-test-credential";
    setCredential(credentialKey, "sk-delete-test-secret");

    const unconfirmed = await json<{ error: string }>(app, `/api/modern/projects/${second.body.id}`, { method: "DELETE", body: { confirm: false } });
    expect(unconfirmed.response.statusCode).toBe(400);
    expect(unconfirmed.body.error).toContain("确认");

    const deleted = await json<{ ok: boolean }>(app, `/api/modern/projects/${first.body.id}`, { method: "DELETE", body: { confirm: true } });
    expect(deleted.response.statusCode).toBe(200);
    expect(deleted.body.ok).toBe(true);

    const missing = await json<{ error: string }>(app, `/api/modern/projects/${first.body.id}`, { method: "DELETE", body: { confirm: true } });
    expect(missing.response.statusCode).toBe(404);
    expect(missing.body.error).toContain("不存在");

    const firstProject = await json<{ error: string }>(app, `/api/modern/projects/${first.body.id}`);
    expect(firstProject.response.statusCode).toBe(404);
    const secondProject = await json(app, `/api/modern/projects/${second.body.id}`);
    expect(secondProject.response.statusCode).toBe(200);
    const secondSources = await json<Array<{ title: string }>>(app, `/api/modern/projects/${second.body.id}/sources`);
    expect(secondSources.body).toHaveLength(1);
    expect(secondSources.body[0]?.title).toBe("保留资料");
    expect(getCredential(credentialKey)).toBe("sk-delete-test-secret");
    setCredential(credentialKey, "");
  });

  it("propagates reasoning_effort_unsupported as a structured API error", async () => {
    const app = await modernApp();
    const project = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `推理错误-${crypto.randomUUID()}` } });
    const model = await json<{ id: string }>(app, "/api/modern/models", {
      method: "POST",
      body: { name: "主模型", provider: "openai", model: "gpt-5", reasoningEffort: "xhigh", apiKey: "sk-test-key" },
    });
    expect(model.response.statusCode).toBe(201);
    const bound = await json(app, `/api/modern/projects/${project.body.id}/agents/main`, {
      method: "PUT",
      body: { enabled: true, modelProfile: model.body.id },
    });
    expect(bound.response.statusCode).toBe(200);

    const spy = vi.spyOn(agentRuntime, "run").mockRejectedValue(new ReasoningEffortUnsupportedError({
      reasoningEffort: "xhigh",
      model: "gpt-5",
      provider: "openai",
      configName: "主模型",
      providerMessage: "Unsupported value: reasoning_effort does not support 'xhigh'",
    }));

    const sessions = await json<Array<{ id: string }>>(app, `/api/modern/projects/${project.body.id}/sessions`);
    const message = await json<{ error: string; code?: string; detail?: { reasoningEffort?: string; configName?: string; model?: string; providerMessage?: string } }>(
      app,
      `/api/modern/projects/${project.body.id}/sessions/${sessions.body[0]?.id}/messages`,
      { method: "POST", body: { content: "请继续写作" } },
    );
    expect(message.response.statusCode).toBe(400);
    expect(message.body.code).toBe("reasoning_effort_unsupported");
    expect(message.body.detail).toMatchObject({ reasoningEffort: "xhigh", configName: "主模型", model: "gpt-5" });
    expect(message.body.detail?.providerMessage).toBe("Unsupported value: reasoning_effort does not support 'xhigh'");
    expect(message.body.error).toContain("推理强度");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("discovers provider models through the API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "z-model" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = await modernApp();

    const result = await json<{ models: string[] }>(app, "/api/modern/models/discover", {
      method: "POST",
      body: { provider: "openai-compatible", baseUrl: "https://llm.example.com/v1", apiKey: "sk-discovery-secret" },
    });
    expect(result.response.statusCode).toBe(200);
    expect(result.body.models).toEqual(["a-model", "z-model"]);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://llm.example.com/v1/models");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-discovery-secret");
  });
});
