import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
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
    const promoted = await json<{ source: { area: string; version: number }; memory: { status: string }; skill: { summary: string }; catalog: { content: string } }>(app, `/api/modern/projects/${project.body.id}/sources/${editable.body.id}/promote`, { method: "POST", body: {} });
    expect(promoted.response.statusCode).toBe(201);
    expect(promoted.body.source).toMatchObject({ area: "formal", version: 1 });
    expect(promoted.body.memory.status).toBe("formal");
    expect(promoted.body.skill.summary).toContain("档案馆");
    expect(promoted.body.catalog.content).toContain("正式设定");
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

  it("manages a global style preset library and per-project selection through the API", async () => {
    const app = await modernApp();
    const project = await json<{ id: string }>(app, "/api/modern/projects", { method: "POST", body: { name: `文风-${crypto.randomUUID()}` } });
    const projectId = project.body.id;

    const empty = await json<{ active: null; presets: unknown[] }>(app, `/api/modern/projects/${projectId}/style-preset`);
    expect(empty.response.statusCode).toBe(200);
    expect(empty.body.active).toBeNull();
    expect(empty.body.presets).toEqual([]);

    const created = await json<{ id: string; name: string; content: string }>(app, "/api/modern/style-presets", {
      method: "POST",
      body: { name: "白话风", content: "短句冷峻，性爱场景直白细腻。" },
    });
    expect(created.response.statusCode).toBe(200);
    expect(created.body.name).toBe("白话风");
    const presetId = created.body.id;

    const listed = await json<Array<{ id: string }>>(app, "/api/modern/style-presets");
    expect(listed.body.some((preset) => preset.id === presetId)).toBe(true);

    const selected = await json<{ active: { id: string } | null }>(app, `/api/modern/projects/${projectId}/style-preset`, {
      method: "PUT",
      body: { presetId },
    });
    expect(selected.response.statusCode).toBe(200);
    expect(selected.body.active?.id).toBe(presetId);

    const updated = await json<{ content: string }>(app, `/api/modern/style-presets/${presetId}`, {
      method: "PUT",
      body: { content: "短句冷峻，性爱直白。" },
    });
    expect(updated.body.content).toBe("短句冷峻，性爱直白。");
    const after = await json<{ active: { content: string } | null }>(app, `/api/modern/projects/${projectId}/style-preset`);
    expect(after.body.active?.content).toBe("短句冷峻，性爱直白。");

    const cleared = await json<{ active: { id: string } | null }>(app, `/api/modern/projects/${projectId}/style-preset`, {
      method: "PUT",
      body: { presetId: null },
    });
    expect(cleared.body.active).toBeNull();

    const removed = await json<{ ok: boolean }>(app, `/api/modern/style-presets/${presetId}`, { method: "DELETE" });
    expect(removed.response.statusCode).toBe(200);
    const finalList = await json<Array<{ id: string }>>(app, "/api/modern/style-presets");
    expect(finalList.body.some((preset) => preset.id === presetId)).toBe(false);

    const oversized = await json<{ error: string }>(app, "/api/modern/style-presets", {
      method: "POST",
      body: { name: "超长", content: "x".repeat(8_001) },
    });
    expect(oversized.response.statusCode).toBe(500);
    expect(oversized.body.error).toContain("长度限制");
  });
});
