import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { MemoryService, type MemoryModelProvider } from "./memory-service.js";
import { RetrievalService, type RetrievalModelProvider } from "./retrieval.js";

const models: MemoryModelProvider = {
  extract: async () => [],
  verifyConflict: async ({ explanation }) => ({ confirmed: true, explanation }),
};

describe("RetrievalService", () => {
  it("partitions context, excludes disputed records from normal buckets, and persists a trace", async () => {
    const db = openDatabase(":memory:");
    const memory = new MemoryService(db, models);
    const retrieval = new RetrievalService(db);
    const project = memory.createProject("检索书");
    const content = "龙门是世界规则。林舟位于北城。";
    const submission = memory.createSubmission(project.id, {
      title: "设定", kind: "setting", content,
      candidates: [
        { kind: "world_rule", scope: "world_truth", subject: "龙门", predicate: "is", object: "世界规则", spanStart: 0, spanEnd: 7, spanText: content.slice(0, 7) },
        { kind: "location_topology", scope: "world_truth", subject: "林舟", predicate: "location", object: "北城", spanStart: 8, spanEnd: 14, spanText: content.slice(8, 14) },
      ],
    });
    await memory.reviewSubmission(project.id, submission.id);
    const locationId = (db.prepare("SELECT id FROM memories WHERE subject='林舟'").get() as { id: string }).id;
    db.prepare("UPDATE memories SET disputed=1 WHERE id=?").run(locationId);

    const pack = await retrieval.compileContext(project.id, {
      intent: "scene_generation", instruction: "林舟在北城的状态", mentionedEntities: ["林舟"], tokenBudget: 100,
    });
    expect(pack.hardConstraints.some((item) => item.text.includes("龙门"))).toBe(false);
    expect(pack.disputes).toHaveLength(1);
    expect(pack.disputes[0]!.memoryId).toBe(locationId);
    expect(pack.worldState.some((item) => item.memoryId === locationId)).toBe(false);
    expect(pack.tokenUsed).toBeGreaterThan(0);
    expect((db.prepare("SELECT count(*) AS count FROM retrieval_traces WHERE id=?").get(pack.traceId) as { count: number }).count).toBe(1);
  });

  it("never exceeds the token budget and records omitted reasons", async () => {
    const db = openDatabase(":memory:");
    const memory = new MemoryService(db, models);
    const retrieval = new RetrievalService(db);
    const project = memory.createProject("预算书");
    const content = "林舟位于北城。";
    const submission = memory.createSubmission(project.id, {
      title: "正文", kind: "prose", content,
      candidates: [{ kind: "location_topology", scope: "world_truth", subject: "林舟", predicate: "location", object: "北城", spanStart: 0, spanEnd: 6, spanText: content.slice(0, 6) }],
    });
    await memory.reviewSubmission(project.id, submission.id);
    const pack = await retrieval.compileContext(project.id, { intent: "evidence", instruction: "林舟", mentionedEntities: ["林舟"], tokenBudget: 1 });
    expect(pack.tokenUsed).toBeLessThanOrEqual(1);
    expect(pack.omitted.length).toBeGreaterThan(0);
    expect(pack.insufficientEvidence).toHaveLength(1);
    db.close();
  });

  it("keeps project retrieval isolated", async () => {
    const db = openDatabase(":memory:");
    const memory = new MemoryService(db, models);
    const retrieval = new RetrievalService(db);
    const projectA = memory.createProject("A");
    const projectB = memory.createProject("B");
    const content = "林舟位于北城。";
    const submission = memory.createSubmission(projectA.id, {
      title: "A", kind: "setting", content,
      candidates: [{ kind: "location_topology", scope: "world_truth", subject: "林舟", predicate: "location", object: "北城", spanStart: 0, spanEnd: 6, spanText: content.slice(0, 6) }],
    });
    await memory.reviewSubmission(projectA.id, submission.id);
    const pack = await retrieval.compileContext(projectB.id, { intent: "current_state", instruction: "林舟", mentionedEntities: ["林舟"], tokenBudget: 50 });
    expect(pack.hardConstraints).toHaveLength(0);
    expect(pack.worldState).toHaveLength(0);
    expect(pack.insufficientEvidence.length).toBeGreaterThan(0);
    db.close();
  });

  it("indexes memory embeddings and uses cosine similarity in ranking", async () => {
    const db = openDatabase(":memory:");
    const memory = new MemoryService(db, models);
    const embeddingModels: RetrievalModelProvider = {
      embed: async (value) => value.includes("目标") ? [1, 0] : [0, 1],
    };
    const retrieval = new RetrievalService(db, embeddingModels);
    const project = memory.createProject("向量书");
    const firstContent = "目标人物位于北城。";
    const first = memory.createSubmission(project.id, { title: "目标", kind: "setting", content: firstContent, candidates: [{ kind: "location_topology", scope: "world_truth", subject: "目标人物", predicate: "location", object: "北城", spanStart: 0, spanEnd: 8, spanText: firstContent.slice(0, 8) }] });
    const secondContent = "旁支人物位于南城。";
    const second = memory.createSubmission(project.id, { title: "旁支", kind: "setting", content: secondContent, candidates: [{ kind: "location_topology", scope: "world_truth", subject: "旁支人物", predicate: "location", object: "南城", spanStart: 0, spanEnd: 8, spanText: secondContent.slice(0, 8) }] });
    await memory.reviewSubmission(project.id, first.id);
    await memory.reviewSubmission(project.id, second.id);
    const indexed = await retrieval.indexEmbeddings(project.id);
    expect(indexed).toMatchObject({ indexed: 2, skipped: 0, failed: [] });
    expect((db.prepare("SELECT count(*) AS count FROM memory_embeddings").get() as { count: number }).count).toBe(2);
    const pack = await retrieval.compileContext(project.id, { intent: "current_state", instruction: "目标", tokenBudget: 100 });
    expect(pack.worldState[0]?.text).toContain("目标人物");
    db.close();
  });
});
