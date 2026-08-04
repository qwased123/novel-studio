import { describe, expect, it } from "vitest";
import { buildContext } from "./context.js";
import { countHanWords, isoNow, newId, sqlite, vectorAvailable } from "./db.js";
import { exportEpub, exportManuscript, exportProjectBundle, importProjectBundle } from "./exporter.js";
import { createChapter, createEntity, createProject, getDocument, getProjectDocuments, getProjectTree, listFacts, saveDocument } from "./repository.js";
import { replaceSelection } from "./document-content.js";
import { queryActiveMemory } from "./memory-query.js";
import { scanAiStyle } from "./style-review.js";

function fixtureProject() {
  const { id } = createProject({
    title: `测试作品-${crypto.randomUUID()}`,
    genre: "悬疑",
    premise: "林彻必须在七天内找出旧城停电的真相。",
    targetWords: 500_000,
    pov: "第三人称限知",
    audience: "中文网文读者",
  });
  return id;
}

describe("domain core", () => {
  it("counts Chinese characters and Latin words predictably", () => {
    expect(countHanWords("第一章 Hello world 2026")).toBe(6);
  });

  it("loads sqlite-vec and calculates cosine distance locally", () => {
    expect(vectorAvailable).toBe(true);
    const result = sqlite.prepare("SELECT vec_distance_cosine(?, ?) AS distance").get("[1,0]", "[0,1]") as { distance: number };
    expect(result.distance).toBeCloseTo(1);
  });

  it("creates a complete writable project tree", () => {
    const projectId = fixtureProject();
    const tree = getProjectTree(projectId);
    expect(tree?.volumes).toHaveLength(1);
    expect(tree?.volumes[0]?.chapters).toHaveLength(1);
    expect(tree?.volumes[0]?.chapters[0]?.documentId).toBeTruthy();
  });

  it("keeps immutable versions and rejects stale writes", () => {
    const projectId = fixtureProject();
    const documentId = String(getProjectTree(projectId)?.volumes[0]?.chapters[0]?.documentId);
    const before = getDocument(documentId)!;
    saveDocument(documentId, {
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "雨落旧城。" }] }] },
      plainText: "雨落旧城。",
      html: "<p>雨落旧城。</p>",
      expectedVersionId: before.currentVersionId,
      message: "测试保存",
    });
    expect(() => saveDocument(documentId, {
      contentJson: { type: "doc" }, plainText: "过期写入", html: "", expectedVersionId: before.currentVersionId, message: "过期",
    })).toThrow("文档已被其他修改更新");
  });

  it("rewrites only the selected range and preserves surrounding rich text", () => {
    const contentJson = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "雨落" }, { type: "text", text: "旧城街口。" }] },
        { type: "paragraph", content: [{ type: "text", text: "林彻推门而入。" }] },
      ],
    };
    const changed = replaceSelection(contentJson, { from: 2, to: 12, text: "落旧城街口。\n\n林彻" }, "骤雨敲打街口。\n\n林彻仍旧");
    expect(changed.plainText).toBe("雨骤雨敲打街口。\n\n林彻仍旧推门而入。");
    expect(JSON.stringify(changed.contentJson)).toContain('"type":"bold"');
    expect(changed.html).toContain("<strong>雨</strong>");
  });

  it("prioritizes hard constraints and explicitly mentioned entities", async () => {
    const projectId = fixtureProject();
    createEntity(projectId, { type: "character", name: "林彻", summary: "旧城刑警，左手有旧伤。", aliases: [], attributes: {}, visibility: "author" });
    const documentId = String(getProjectTree(projectId)?.volumes[0]?.chapters[0]?.documentId);
    const context = await buildContext({ projectId, documentId, type: "draft_chapter", instruction: "写林彻进入停电的旧城", includeIds: [], excludeIds: [] });
    expect(context.items.some((entry) => entry.title.includes("叙事约束") && entry.required)).toBe(true);
    expect(context.items.some((entry) => entry.title.includes("林彻") && entry.category === "entity")).toBe(true);
    expect(context.items.filter((entry) => entry.required).every((entry) => entry.temperature === "blue" && entry.included)).toBe(true);
    expect(context.estimatedTokens).toBeLessThanOrEqual(context.maxInputTokens);
  });

  it("keeps blue memory inside the hard budget and exposes older summaries as cold archives", async () => {
    const projectId = fixtureProject();
    const initialTree = getProjectTree(projectId)!;
    const volumeId = String(initialTree.volumes[0]?.id);
    for (let index = 2; index <= 5; index += 1) createChapter(volumeId, `第${index}章`);
    const chapters = getProjectTree(projectId)!.volumes[0]!.chapters;
    for (const chapter of chapters.slice(0, 4)) {
      const document = getDocument(String(chapter.documentId))!;
      sqlite.prepare(`INSERT INTO chapter_summaries(id,project_id,chapter_id,source_version_id,summary,continuation_excerpt,stale,created_at)
        VALUES (?,?,?,?,?,?,0,?)`).run(newId(), projectId, chapter.id, document.currentVersionId, `${chapter.title}发生了可追溯事件。`, `${chapter.title}的章末原文。`, isoNow());
    }
    const targetId = String(chapters[4]!.documentId);
    const context = await buildContext({ projectId, documentId: targetId, type: "draft_chapter", instruction: "承接前情" });
    const archive = context.items.find((entry) => entry.id.startsWith("archive:"));
    expect(archive).toMatchObject({ temperature: "cold", included: false, sourceVersionId: expect.any(String) });
    const forced = await buildContext({ projectId, documentId: targetId, type: "draft_chapter", instruction: "承接前情", includeIds: [archive!.id] });
    expect(forced.includedItems.some((entry) => entry.id === archive!.id)).toBe(true);

    const documents = getProjectDocuments(projectId) as Array<{ id: string; kind: string; currentVersionId: string }>;
    for (const kind of ["style_guide", "book_outline"]) {
      const document = documents.find((entry) => entry.kind === kind)!;
      saveDocument(document.id, { contentJson: { type: "doc" }, plainText: "约束".repeat(70_000), html: "", expectedVersionId: document.currentVersionId, message: "预算测试" });
    }
    const bounded = await buildContext({ projectId, documentId: targetId, type: "draft_chapter", instruction: "预算测试" });
    expect(bounded.estimatedTokens).toBeLessThanOrEqual(bounded.maxInputTokens - 2_000);
    expect(bounded.items.some((entry) => entry.required && entry.reason.includes("已按预算截断"))).toBe(true);
  });

  it("includes active facts and invalidates them when their source chapter changes", async () => {
    const projectId = fixtureProject();
    const entity = createEntity(projectId, { type: "character", name: "林彻", summary: "旧城刑警", aliases: [], attributes: {}, visibility: "author" });
    const documentId = String(getProjectTree(projectId)?.volumes[0]?.chapters[0]?.documentId);
    const document = getDocument(documentId)!;
    const now = isoNow();
    sqlite.prepare(`INSERT INTO facts(id,project_id,subject_entity_id,predicate,object_text,source_document_id,source_version_id,evidence,fact_kind,mutable,confidence,visibility,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,1,'author','active',?,?)`).run(newId(), projectId, entity.id, "所在地", "旧城档案馆", documentId, document.currentVersionId, "站在档案馆门前", "location", now, now);
    const context = await buildContext({ projectId, documentId, type: "draft_chapter", instruction: "继续写林彻", includeIds: [], excludeIds: [] });
    expect(context.items.find((entry) => entry.title === "当前事实状态")?.excerpt).toContain("旧城档案馆");
    expect(queryActiveMemory(projectId, "林彻现在在哪里").matches.some((entry) => entry.excerpt.includes("旧城档案馆") && entry.sourceVersionId === document.currentVersionId)).toBe(true);
    saveDocument(documentId, { contentJson: { type: "doc" }, plainText: "修订后的章节", html: "", expectedVersionId: document.currentVersionId, message: "修订" });
    expect((sqlite.prepare("SELECT status FROM facts WHERE project_id=?").get(projectId) as { status: string }).status).toBe("stale");
    expect(queryActiveMemory(projectId, "林彻现在在哪里").matches.some((entry) => entry.excerpt.includes("旧城档案馆"))).toBe(false);
  });

  it("finds concrete AI-style patterns without truncating or rewriting the chapter", () => {
    const content = "他深吸一口气，推开门。突然，灯灭了。\n\n他摸到墙边。突然，楼上传来脚步。\n\n这一刻他终于明白，真正的答案一直藏在这里。";
    const findings = scanAiStyle(content);
    expect(findings.map((finding) => finding.title)).toEqual(expect.arrayContaining([
      expect.stringContaining("深吸一口气"),
      expect.stringContaining("突然"),
      "章末总结式升华",
    ]));
    expect(content).toContain("真正的答案");
  });

  it("exports manuscripts, EPUB and a re-importable project bundle", async () => {
    const projectId = fixtureProject();
    const entity = createEntity(projectId, { type: "character", name: "顾遥", summary: "档案管理员", aliases: [], attributes: {}, visibility: "author" });
    const now = isoNow();
    sqlite.prepare(`INSERT INTO facts(id,project_id,subject_entity_id,predicate,object_text,evidence,fact_kind,mutable,confidence,visibility,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'identity',0,1,'author','active',?,?)`).run(newId(), projectId, entity.id, "职业", "档案管理员", "值班表", now, now);
    expect(exportManuscript(projectId, "txt").toString("utf8")).toContain("第一章");
    expect((await exportEpub(projectId)).subarray(0, 2).toString()).toBe("PK");
    const imported = await importProjectBundle(await exportProjectBundle(projectId));
    expect(getProjectTree(imported.id)?.project.title).toContain("导入");
    expect(listFacts(imported.id)).toHaveLength(1);
  });
});
