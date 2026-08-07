import { describe, expect, it } from "vitest";
import {
  AGENT_ROLES,
  LEGACY_PROMPT_BLOCK_NAME,
  STYLE_PROMPT_BLOCK_NAME,
  appendMessage,
  assembleRolePromptBlocks,
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
  getProject,
  getSkill,
  getSourceFile,
  getStylePrompt,
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
  saveStylePrompt,
  updateMemoryEntry,
  updateReviewReport,
  updateSourceFile,
  updateTask,
  upsertAgentProfile,
  upsertCatalog,
  upsertSkill,
} from "./modern-store.js";
import { sqlite } from "./db.js";

function projectId(label: string) {
  return `${label}-${crypto.randomUUID()}`;
}

describe("modern store", () => {
  it("enforces project isolation and caller-supplied project ids", () => {
    const projectA = projectId("isolation-a");
    const projectB = projectId("isolation-b");
    createProject({ id: projectA, name: "作品 A" });
    createProject({ id: projectB, name: "作品 B" });

    expect(getProject(projectA)).toMatchObject({ id: projectA, name: "作品 A" });
    expect(getProject(projectB)).toMatchObject({ id: projectB });
    expect(listProjects().some((entry) => entry.id === projectA)).toBe(true);
    expect(() => createProject({ id: projectA, name: "重复" })).toThrow(/已存在/);

    const fileA = createSourceFile({ projectId: projectA, kind: "prose", area: "draft", title: "A 草稿" });
    expect(listSourceFiles(projectA)).toHaveLength(1);
    expect(listSourceFiles(projectB)).toHaveLength(0);
    expect(getSourceFile(projectA, fileA.id)?.title).toBe("A 草稿");
    expect(getSourceFile(projectB, fileA.id)).toBeNull();
    expect(() => createSourceFile({ projectId: projectB, kind: "prose", area: "draft", title: "越权引用", sourceFileId: fileA.id }))
      .toThrow(/不属于该项目/);

    const sessionA = createSession({ projectId: projectA, title: "主线会话" });
    expect(listSessions(projectA)).toHaveLength(1);
    expect(listSessions(projectB)).toHaveLength(0);
    expect(() => appendMessage({ projectId: projectB, sessionId: sessionA.id, role: "user", content: "越权" }))
      .toThrow(/不属于该项目/);

    const memoryA = createMemoryEntry({ projectId: projectA, title: "A 记忆", kind: "native" });
    upsertSkill(projectA, memoryA.id, { summary: "A 技能" });
    expect(getSkill(projectA, memoryA.id)?.summary).toBe("A 技能");
    expect(getSkill(projectB, memoryA.id)).toBeNull();
    expect(() => upsertSkill(projectB, memoryA.id, { summary: "越权技能" })).toThrow(/不属于该项目/);

    upsertCatalog(projectA, "style", "A 文风");
    expect(getCatalog(projectA, "style")?.content).toBe("A 文风");
    expect(getCatalog(projectB, "style")).toBeNull();

    const reportA = createReviewReport({ projectId: projectA, kind: "prose", targetFileId: fileA.id });
    expect(listReviewReports(projectB)).toHaveLength(0);
    expect(getAgentProfile(projectA, "main")).toBeNull();
    expect(upsertAgentProfile(projectA, { role: "main", prompt: "统筹" }).enabled).toBe(true);
    expect(getAgentProfile(projectB, "main")).toBeNull();
    expect(reportA.status).toBe("open");
  });

  it("stores source files in draft and formal areas with typed version refs", () => {
    const project = projectId("source-files");
    createProject({ id: project, name: "源文件测试" });

    const draft = createSourceFile({
      projectId: project,
      kind: "prose",
      area: "draft",
      title: "第一章草稿",
      content: "雨落旧城。",
    });
    createSourceFile({ projectId: project, kind: "outline", area: "draft", title: "全书大纲" });
    const formal = createSourceFile({
      projectId: project,
      kind: "setting",
      area: "formal",
      title: "旧城设定",
      content: "档案馆在城东。",
      sourceFileId: draft.id,
      sourceVersion: "v2",
    });

    expect(listSourceFiles(project, { area: "draft" })).toHaveLength(2);
    expect(listSourceFiles(project, { area: "formal" })).toHaveLength(1);
    expect(listSourceFiles(project, { kind: "setting" })[0]).toMatchObject({ area: "formal", title: "旧城设定" });
    expect(formal).toMatchObject({ sourceFileId: draft.id, sourceVersion: "v2", status: "active" });
    expect(draft.sourceVersion).toBeNull();

    expect(() => createSourceFile({ projectId: project, kind: "poem" as never, area: "draft", title: "非法" }))
      .toThrow(/kind/);
    expect(() => createSourceFile({ projectId: project, kind: "prose", area: "review" as never, title: "非法" }))
      .toThrow(/area/);
    expect(() => createSourceFile({ projectId: project, kind: "prose", area: "draft", title: "" }))
      .toThrow(/title/);
  });

  it("keeps sessions and messages project-scoped in conversation order", () => {
    const project = projectId("sessions");
    const other = projectId("sessions-other");
    createProject({ id: project, name: "会话测试" });
    createProject({ id: other, name: "另一作品" });

    const mainSession = createSession({ projectId: project, title: "主线讨论" });
    const sideSession = createSession({ projectId: project, title: "支线讨论" });
    expect(listSessions(project)).toHaveLength(2);

    const first = appendMessage({ projectId: project, sessionId: mainSession.id, role: "user", content: "先写第一幕" });
    appendMessage({ projectId: project, sessionId: mainSession.id, role: "assistant", content: "好的。" });
    appendMessage({ projectId: project, sessionId: mainSession.id, role: "main", content: "继续推进" });
    expect(first.role).toBe("user");

    expect(listMessages(project, mainSession.id).map((entry) => entry.role)).toEqual(["user", "assistant", "main"]);
    expect(listMessages(project, sideSession.id)).toHaveLength(0);
    expect(() => appendMessage({ projectId: project, sessionId: mainSession.id, role: "user", content: "" }))
      .toThrow(/content/);
    expect(() => appendMessage({ projectId: project, sessionId: mainSession.id, role: "narrator" as never, content: "x" }))
      .toThrow(/role/);
    expect(() => appendMessage({ projectId: other, sessionId: mainSession.id, role: "user", content: "越权" }))
      .toThrow(/不属于该项目/);
    expect(() => listMessages(other, mainSession.id)).toThrow(/不属于该项目/);
  });

  it("links memory entries, one skill sidecar and project catalogs", () => {
    const project = projectId("memory");
    const other = projectId("memory-other");
    createProject({ id: project, name: "记忆测试" });
    createProject({ id: other, name: "另一作品" });

    const file = createSourceFile({ projectId: project, kind: "prose", area: "formal", title: "第一章定稿" });
    const entry = createMemoryEntry({
      projectId: project,
      title: "林彻旧伤",
      kind: "native",
      status: "draft",
      content: "左手旧伤，源自旧城档案馆事件。",
      sourceFileId: file.id,
      sourceVersion: "v1",
      basePriority: 0.8,
    });
    expect(entry).toMatchObject({ kind: "native", status: "draft", sourceFileId: file.id, sourceVersion: "v1" });
    expect(() => createMemoryEntry({ projectId: other, title: "越权引用", kind: "derived", sourceFileId: file.id }))
      .toThrow(/不属于该项目/);

    const skill = upsertSkill(project, entry.id, {
      summary: "林彻的左手旧伤设定",
      purpose: "写林彻时保持伤势一致",
      keywords: ["林彻", "旧伤"],
      related: ["档案馆"],
      sourceVersion: "v2",
    });
    expect(getSkill(project, entry.id)).toMatchObject({
      summary: "林彻的左手旧伤设定",
      purpose: "写林彻时保持伤势一致",
      keywords: ["林彻", "旧伤"],
      related: ["档案馆"],
      sourceVersion: "v2",
    });
    const replaced = upsertSkill(project, entry.id, { summary: "更新后的摘要" });
    expect(replaced.id).toBe(skill.id);
    expect(getSkill(project, entry.id)?.keywords).toEqual([]);
    expect(getSkill(project, entry.id)?.sourceVersion).toBe("v2");
    expect(getSkill(other, entry.id)).toBeNull();

    const updated = updateMemoryEntry(project, entry.id, { status: "formal", basePriority: 0.9, expectedStatus: "draft" });
    expect(updated.status).toBe("formal");
    expect(updated.basePriority).toBe(0.9);
    expect(listMemoryEntries(project, { status: "formal" })).toHaveLength(1);
    expect(() => updateMemoryEntry(project, entry.id, { status: "archived", expectedStatus: "draft" }))
      .toThrow(/当前状态为 formal/);

    expect(getCatalog(project, "style")).toBeNull();
    const catalog = upsertCatalog(project, "style", "冷峻克制");
    expect(catalog.content).toBe("冷峻克制");
    const second = upsertCatalog(project, "style", "冷峻克制，多用短句");
    expect(second.content).toBe("冷峻克制，多用短句");
    expect(second.createdAt).toBe(catalog.createdAt);
    expect(getCatalog(other, "style")).toBeNull();
  });

  it("tracks review status transitions and targets", () => {
    const project = projectId("reviews");
    const other = projectId("reviews-other");
    createProject({ id: project, name: "评审测试" });
    createProject({ id: other, name: "另一作品" });

    const file = createSourceFile({ projectId: project, kind: "prose", area: "formal", title: "定稿" });
    const report = createReviewReport({
      projectId: project,
      kind: "prose",
      targetFileId: file.id,
      content: "开篇节奏偏慢。",
      sourceRefs: [{ fileId: file.id, sourceVersion: "v1", note: "首章" }],
    });
    expect(report.status).toBe("open");
    expect(report.sourceRefs[0]).toMatchObject({ fileId: file.id, sourceVersion: "v1" });

    const resolved = updateReviewReport(project, report.id, { status: "resolved", expectedStatus: "open" });
    expect(resolved.status).toBe("resolved");
    expect(() => updateReviewReport(project, report.id, { status: "deferred", expectedStatus: "open" }))
      .toThrow(/当前状态为 resolved/);

    const task = createTask({ projectId: project, targetAgent: "logic_review", type: "review_logic" });
    const taskReport = createReviewReport({ projectId: project, kind: "logic", targetTaskId: task.id, status: "deferred" });
    expect(taskReport.targetTaskId).toBe(task.id);
    expect(listReviewReports(project, { kind: "logic" })).toHaveLength(1);
    expect(listReviewReports(project, { status: "resolved" }).map((entry) => entry.id)).toContain(report.id);
    expect(listReviewReports(other)).toHaveLength(0);
    expect(() => createReviewReport({ projectId: project, kind: "fidelity" })).toThrow(/targetFileId/);
    expect(() => createReviewReport({ projectId: other, kind: "prose", targetFileId: file.id })).toThrow(/不属于该项目/);
  });

  it("tracks task status, payload, result and error", () => {
    const project = projectId("tasks");
    createProject({ id: project, name: "任务测试" });
    const session = createSession({ projectId: project, title: "写作会话" });

    const task = createTask({
      projectId: project,
      sessionId: session.id,
      targetAgent: "writer",
      type: "draft_scene",
      payload: { scene: "夜雨旧城", targetWords: 2000 },
    });
    expect(task).toMatchObject({ targetAgent: "writer", type: "draft_scene", status: "queued" });
    expect(task.payload).toEqual({ scene: "夜雨旧城", targetWords: 2000 });

    const running = updateTask(project, task.id, { status: "running", expectedStatus: "queued" });
    expect(running.status).toBe("running");
    expect(running.startedAt).toBeTruthy();
    const done = updateTask(project, task.id, { status: "succeeded", result: { text: "成稿" }, expectedStatus: "running" });
    expect(done.status).toBe("succeeded");
    expect(done.result).toEqual({ text: "成稿" });
    expect(done.finishedAt).toBeTruthy();
    expect(() => updateTask(project, task.id, { status: "failed", expectedStatus: "running" }))
      .toThrow(/当前状态为 succeeded/);

    const failed = createTask({ projectId: project, targetAgent: "memory_manager", type: "summarize" });
    updateTask(project, failed.id, { status: "failed", error: "模型超时" });
    const failedTask = listTasks(project, { status: "failed" })[0];
    expect(failedTask).toMatchObject({ error: "模型超时", status: "failed" });
    expect(listTasks(project, { sessionId: session.id })).toHaveLength(1);
    expect(listTasks(project, { targetAgent: "writer" })[0]?.id).toBe(task.id);
    expect(() => createTask({ projectId: project, targetAgent: "hacker" as never, type: "x" }))
      .toThrow(/targetAgent/);
    expect(() => createTask({ projectId: project, targetAgent: "writer", type: "" })).toThrow(/type/);
    expect(() => updateTask(project, task.id, {})).toThrow(/至少需要一个可更新字段/);
  });

  it("versions source updates and promotes source plus memory atomically", () => {
    const project = projectId("promotion");
    createProject({ id: project, name: "晋级测试" });
    const draft = createSourceFile({ projectId: project, kind: "setting", area: "draft", title: "城中设定", content: "旧内容" });
    const updated = updateSourceFile(project, draft.id, { content: "新内容", expectedVersion: 1 });
    expect(updated.version).toBe(2);
    expect(() => updateSourceFile(project, draft.id, { content: "冲突", expectedVersion: 1 })).toThrow(/当前版本为 2/);

    const promoted = promoteSourceAtomically({
      projectId: project,
      sourceFileId: draft.id,
      memoryContent: "新内容",
      memorySummary: "城中设定摘要",
      memoryPurpose: "维持设定一致",
      keywords: ["城中"],
      basePriority: 0.75,
    });
    expect(promoted.source).toMatchObject({ area: "formal", sourceFileId: draft.id, version: 1 });
    expect(promoted.memory).toMatchObject({ status: "formal", sourceFileId: promoted.source.id });
    expect(promoted.skill.summary).toBe("城中设定摘要");
    expect(promoted.catalog.content).toContain("城中设定");

    const failedDraft = createSourceFile({ projectId: project, kind: "setting", area: "draft", title: "触发回滚", content: "回滚内容" });
    sqlite.exec("CREATE TEMP TRIGGER modern_test_fail_memory BEFORE INSERT ON modern_memory_entries WHEN NEW.title = '触发回滚' BEGIN SELECT RAISE(ABORT, '测试故障'); END");
    try {
      expect(() => promoteSourceAtomically({ projectId: project, sourceFileId: failedDraft.id, memoryContent: "x", memorySummary: "x", memoryPurpose: "x" })).toThrow(/测试故障/);
    } finally {
      sqlite.exec("DROP TRIGGER modern_test_fail_memory");
    }
    expect(listSourceFiles(project, { area: "formal" }).some((file) => file.title === "触发回滚")).toBe(false);
    expect(listMemoryEntries(project).some((entry) => entry.title === "触发回滚")).toBe(false);
  });

  it("requires explicit lifecycle rules for deleting memory and resolved reviews", () => {
    const project = projectId("deletion");
    createProject({ id: project, name: "删除测试" });
    const memory = createMemoryEntry({ projectId: project, title: "待退役", kind: "native", status: "formal" });
    expect(() => deleteMemoryEntry(project, memory.id, "draft")).toThrow(/当前状态为 formal/);
    deleteMemoryEntry(project, memory.id, "formal");
    expect(listMemoryEntries(project).some((entry) => entry.id === memory.id)).toBe(false);

    const source = createSourceFile({ projectId: project, kind: "setting", area: "formal", title: "评审对象" });
    const report = createReviewReport({ projectId: project, kind: "logic", targetFileId: source.id });
    expect(() => deleteReviewReport(project, report.id)).toThrow(/只有已解决/);
    updateReviewReport(project, report.id, { status: "resolved", expectedStatus: "open" });
    deleteReviewReport(project, report.id);
    expect(listReviewReports(project).some((entry) => entry.id === report.id)).toBe(false);
  });

  it("seeds scoped ordered prompt blocks and protects pinned blocks", () => {
    const projectA = projectId("prompt-blocks-a");
    const projectB = projectId("prompt-blocks-b");
    createProject({ id: projectA, name: "提示块作品 A" });
    createProject({ id: projectB, name: "提示块作品 B" });

    const allRoles = listAgentPromptBlocksByProject(projectA);
    expect(Object.keys(allRoles).sort()).toEqual([...AGENT_ROLES].sort());
    for (const role of AGENT_ROLES) {
      expect(allRoles[role].length).toBeGreaterThan(0);
      expect(allRoles[role][0].enabled).toBe(true);
      expect(allRoles[role][0].pinned).toBe(true);
    }

    const mainDefaults = listAgentPromptBlocks(projectA, "main");
    expect(mainDefaults.map((block) => block.name)).toContain("主 Agent 职责");
    expect(mainDefaults[0]).toMatchObject({ role: "system", depth: 0, position: 0, triggerScope: "always" });
    expect(listAgentPromptBlocks(projectB, "main").map((block) => block.name)).toContain("主 Agent 职责");

    const pinned = mainDefaults.find((block) => block.pinned)!;
    const saved = saveAgentPromptBlocks(projectA, "main", {
      blocks: [
        { ...pinned, enabled: true, pinned: true },
        { name: "追加约束", role: "user", position: 0, depth: 1, triggerScope: "task", content: "只输出结论", enabled: true, pinned: false },
      ],
    });
    expect(saved.map((block) => block.name)).toEqual(["主 Agent 职责", "追加约束"]);
    expect(saved[1]).toMatchObject({ role: "user", depth: 1, position: 0, triggerScope: "task" });
    expect(listAgentPromptBlocks(projectB, "main").some((block) => block.name === "追加约束")).toBe(false);

    expect(() => saveAgentPromptBlocks(projectA, "main", { blocks: [{ name: "没有固定块", role: "system", content: "x" }] }))
      .toThrow(/固定提示块「主 Agent 职责」不能删除/);
    const currentPinned = saved[0];
    const disabled = saveAgentPromptBlocks(projectA, "main", { blocks: [{ ...currentPinned, enabled: false, pinned: true }] });
    expect(disabled.find((block) => block.name === currentPinned.name)?.enabled).toBe(false);
    expect(() => saveAgentPromptBlocks(projectA, "main", { blocks: [{ ...disabled[0], enabled: true, pinned: false }] }))
      .toThrow(/固定提示块「主 Agent 职责」不能取消固定/);
  });

  it("migrates legacy custom prompts into blocks and supports profile-level block saves", () => {
    const project = projectId("legacy-prompt");
    const other = projectId("legacy-prompt-other");
    createProject({ id: project, name: "旧提示词迁移" });
    createProject({ id: other, name: "另一作品" });

    const profile = upsertAgentProfile(project, { role: "writer", prompt: "旧的自定义提示词" });
    expect(profile.prompt).toBe("旧的自定义提示词");
    const legacy = profile.promptBlocks.find((block) => block.name === LEGACY_PROMPT_BLOCK_NAME);
    expect(legacy).toMatchObject({ role: "system", depth: 1, position: 10, triggerScope: "always", content: "旧的自定义提示词" });
    expect(getAgentProfile(other, "writer")).toBeNull();
    expect(listAgentPromptBlocks(other, "writer").some((block) => block.name === LEGACY_PROMPT_BLOCK_NAME)).toBe(false);

    const cleared = upsertAgentProfile(project, { role: "writer", prompt: "" });
    expect(cleared.promptBlocks.some((block) => block.name === LEGACY_PROMPT_BLOCK_NAME)).toBe(false);

    const contextPinned = listAgentPromptBlocks(project, "context").find((block) => block.pinned)!;
    const blocked = upsertAgentProfile(project, {
      role: "context",
      promptBlocks: [
        { ...contextPinned, enabled: true, pinned: true },
        { name: "上下文职责", role: "system", position: 1, depth: 0, triggerScope: "always", content: "筛选记忆", enabled: true, pinned: true },
        { name: "输出要求", role: "user", position: 0, depth: 1, triggerScope: "task", content: "输出 JSON", enabled: true, pinned: false },
      ],
    });
    expect(blocked.prompt).toBe("");
    expect(blocked.promptBlocks.map((block) => block.name)).toEqual(["上下文 Agent 职责", "上下文职责", "输出要求"]);
  });

  it("keeps one shared style prompt injected into writer and prose review blocks only", () => {
    const project = projectId("style-prompt");
    const other = projectId("style-prompt-other");
    createProject({ id: project, name: "文风共用" });
    createProject({ id: other, name: "另一作品" });

    expect(getStylePrompt(project)).toBe("");
    expect(getStylePrompt(other)).toBe("");
    saveStylePrompt(project, "冷峻短句，对话克制。");
    expect(getStylePrompt(project)).toBe("冷峻短句，对话克制。");
    expect(getStylePrompt(other)).toBe("");

    const writerBlocks = assembleRolePromptBlocks(project, "writer");
    const reviewBlocks = assembleRolePromptBlocks(project, "prose_review");
    const mainBlocks = assembleRolePromptBlocks(project, "main");
    expect(writerBlocks[0]).toMatchObject({ name: STYLE_PROMPT_BLOCK_NAME, role: "system", content: "冷峻短句，对话克制。" });
    expect(reviewBlocks[0]?.name).toBe(STYLE_PROMPT_BLOCK_NAME);
    expect(mainBlocks.some((block) => block.name === STYLE_PROMPT_BLOCK_NAME)).toBe(false);
    expect(writerBlocks[1]?.name).toBe("正文 Agent 职责");
    expect(reviewBlocks[1]?.name).toBe("正文审查 Agent 职责");
    // 列表视图不合成文风块，只出现在组装结果中
    expect(listAgentPromptBlocks(project, "writer").some((block) => block.name === STYLE_PROMPT_BLOCK_NAME)).toBe(false);

    saveStylePrompt(project, "");
    expect(assembleRolePromptBlocks(project, "writer").some((block) => block.name === STYLE_PROMPT_BLOCK_NAME)).toBe(false);

    expect(() => saveStylePrompt(project, "x".repeat(8_001))).toThrow(/超过长度限制/);
  });
});
