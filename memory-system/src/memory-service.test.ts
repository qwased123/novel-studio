import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { MemoryService, type MemoryModelProvider, type ReviewResult } from "./memory-service.js";
import type { ConflictRecord, MemoryCandidateInput } from "./types.js";

const models = (): MemoryModelProvider => ({
  extract: async () => [],
  verifyConflict: async ({ explanation }) => ({ confirmed: true, explanation }),
});

const candidate = (content: string, overrides: Partial<MemoryCandidateInput> = {}): MemoryCandidateInput => ({
  kind: "location_topology",
  scope: "world_truth",
  subject: "林舟",
  predicate: "location",
  object: "北城",
  spanStart: 0,
  spanEnd: 6,
  spanText: content.slice(0, 6),
  ...overrides,
});

const setup = () => {
  const db = openDatabase(":memory:");
  const service = new MemoryService(db, models());
  return { db, service, project: service.createProject("测试书") };
};

describe("MemoryService", () => {
  it("commits a submission atomically and is idempotent by content hash", async () => {
    const { db, service, project } = setup();
    try {
      const content = "林舟位于北城。";
      const input = { title: "第一章", kind: "prose" as const, content, candidates: [candidate(content)] };
      const first = service.createSubmission(project.id, input);
      const duplicate = service.createSubmission(project.id, input);
      expect(duplicate.id).toBe(first.id);

      const result = await service.reviewSubmission(project.id, first.id);
      expect(result.submission.status).toBe("committed");
      expect(result.memoryIds).toHaveLength(1);
      expect(service.listMemories(project.id)).toHaveLength(1);
      expect(service.auditProject(project.id)).toMatchObject({ ok: true, counts: { sourceVersions: 1, memories: 1 } });
    } finally {
      db.close();
    }
  });

  it("rejects evidence spans that do not match the source", () => {
    const { db, service, project } = setup();
    try {
      expect(() => service.createSubmission(project.id, {
        title: "坏证据", kind: "setting", content: "林舟位于北城。",
        candidates: [candidate("林舟位于北城。", { spanText: "伪造证据" })],
      })).toThrow(/evidence span 不匹配/);
      expect((db.prepare("SELECT count(*) AS count FROM submissions").get() as { count: number }).count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("blocks same-domain contradictions and commits only after explicit retcon", async () => {
    const { db, service, project } = setup();
    try {
      const firstContent = "林舟位于北城。";
      const first = service.createSubmission(project.id, { title: "一", kind: "setting", content: firstContent, candidates: [candidate(firstContent)] });
      await service.reviewSubmission(project.id, first.id);

      const secondContent = "林舟位于南城。";
      const secondCandidate = candidate(secondContent, { object: "南城" });
      const second = service.createSubmission(project.id, { title: "二", kind: "prose", content: secondContent, candidates: [secondCandidate] });
      const blocked = await service.reviewSubmission(project.id, second.id);
      expect(blocked.submission.status).toBe("blocked");
      expect(blocked.conflicts).toHaveLength(1);
      expect(service.listMemories(project.id)).toHaveLength(1);
      expect((db.prepare("SELECT count(*) AS count FROM source_versions").get() as { count: number }).count).toBe(1);
      const delayedAudit = service.auditProject(project.id, { impactKeys: [blocked.conflicts[0]!.impactKey] });
      expect(delayedAudit.impactKeys).toEqual([blocked.conflicts[0]!.impactKey]);
      expect((db.prepare("SELECT count(*) AS count FROM line_blocks WHERE project_id=?").get(project.id) as { count: number }).count).toBe(1);

      const resolved = service.resolveConflict(project.id, blocked.conflicts[0]!.id, { action: "retcon_existing", note: "用户明确改线" }) as ReviewResult;
      expect(resolved.submission.status).toBe("committed");
      expect(service.listMemories(project.id)).toHaveLength(1);
      expect(service.listMemories(project.id, { includeRetconned: true })).toHaveLength(2);
      expect(service.listMemories(project.id, { includeRetconned: true }).find((memory) => memory.object === "北城")?.validUntil).not.toBeNull();
      expect(service.listConflicts(project.id, { status: "open" })).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("allows different epistemic scopes to coexist without overwriting world truth", async () => {
    const { db, service, project } = setup();
    try {
      const truthContent = "林舟位于北城。";
      const truth = service.createSubmission(project.id, { title: "事实", kind: "setting", content: truthContent, candidates: [candidate(truthContent)] });
      await service.reviewSubmission(project.id, truth.id);
      const beliefContent = "林舟位于南城。";
      const belief = service.createSubmission(project.id, {
        title: "误解", kind: "prose", content: beliefContent,
        candidates: [candidate(beliefContent, { object: "南城", scope: "character_belief", perspective: "林舟" })],
      });
      const result = await service.reviewSubmission(project.id, belief.id);
      expect(result.submission.status).toBe("committed");
      expect(result.conflicts).toHaveLength(0);
      expect(service.listMemories(project.id)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("keeps projects isolated", async () => {
    const { db, service, project } = setup();
    try {
      const otherProject = service.createProject("另一部书");
      const content = "林舟位于北城。";
      const first = service.createSubmission(project.id, { title: "A", kind: "setting", content, candidates: [candidate(content)] });
      await service.reviewSubmission(project.id, first.id);
      const second = service.createSubmission(otherProject.id, { title: "B", kind: "setting", content, candidates: [candidate(content)] });
      await service.reviewSubmission(otherProject.id, second.id);
      expect(service.listMemories(project.id)).toHaveLength(1);
      expect(service.listMemories(otherProject.id)).toHaveLength(1);
      expect(() => service.listMemories(project.id, { subject: "不存在" })).not.toThrow();
      expect(() => service.getSubmission(project.id, second.id)).toThrow(/不属于项目/);
    } finally {
      db.close();
    }
  });

  it("marks model failures failed without canonical writes", async () => {
    const db = openDatabase(":memory:");
    const failingModels: MemoryModelProvider = {
      extract: async () => { throw new Error("模型不可用"); },
      verifyConflict: async ({ explanation }) => ({ confirmed: true, explanation }),
    };
    const service = new MemoryService(db, failingModels);
    const project = service.createProject("失败书");
    const submission = service.createSubmission(project.id, { title: "正文", kind: "prose", content: "没有显式候选。" });
    try {
      await expect(service.reviewSubmission(project.id, submission.id)).rejects.toThrow("模型不可用");
      expect(service.getSubmission(project.id, submission.id).status).toBe("failed");
      expect((db.prepare("SELECT count(*) AS count FROM source_versions").get() as { count: number }).count).toBe(0);
      expect((db.prepare("SELECT count(*) AS count FROM memories").get() as { count: number }).count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rejects every open conflict belonging to a rejected submission", async () => {
    const { db, service, project } = setup();
    try {
      const firstContent = "林舟位于北城。林舟是守门人。";
      const first = service.createSubmission(project.id, {
        title: "初始设定", kind: "setting", content: firstContent,
        candidates: [
          candidate(firstContent),
          candidate(firstContent, { kind: "attribute", predicate: "is", object: "守门人", spanStart: 7, spanEnd: 14, spanText: firstContent.slice(7, 14) }),
        ],
      });
      await service.reviewSubmission(project.id, first.id);
      const secondContent = "林舟位于南城。林舟是叛徒。";
      const second = service.createSubmission(project.id, {
        title: "冲突设定", kind: "setting", content: secondContent,
        candidates: [
          candidate(secondContent, { object: "南城" }),
          candidate(secondContent, { kind: "attribute", predicate: "is", object: "叛徒", spanStart: 7, spanEnd: 13, spanText: secondContent.slice(7, 13) }),
        ],
      });
      const blocked = await service.reviewSubmission(project.id, second.id);
      expect(blocked.conflicts).toHaveLength(2);
      const rejected = service.resolveConflict(project.id, blocked.conflicts[0]!.id, { action: "reject_submission", note: "整份提交不纳入正式记忆" }) as ConflictRecord;
      expect(rejected.status).toBe("dismissed");
      expect(service.listConflicts(project.id, { submissionId: second.id, status: "open" })).toHaveLength(0);
      expect(service.getSubmission(project.id, second.id).status).toBe("rejected");
      expect((db.prepare("SELECT count(*) AS count FROM resolutions WHERE conflict_id IN (SELECT id FROM conflicts WHERE submission_id=?)").get(second.id) as { count: number }).count).toBe(2);
    } finally {
      db.close();
    }
  });

  it("supports explicit intentional coexistence", async () => {
    const { db, service, project } = setup();
    try {
      const firstContent = "林舟位于北城。";
      const first = service.createSubmission(project.id, { title: "一", kind: "setting", content: firstContent, candidates: [candidate(firstContent)] });
      await service.reviewSubmission(project.id, first.id);
      const secondContent = "林舟位于南城。";
      const second = service.createSubmission(project.id, { title: "二", kind: "prose", content: secondContent, candidates: [candidate(secondContent, { object: "南城" })] });
      const blocked = await service.reviewSubmission(project.id, second.id);
      const resolved = service.resolveConflict(project.id, blocked.conflicts[0]!.id, { action: "intentional_coexist", note: "两个视角在当前文本中都保留" }) as ReviewResult;
      expect(resolved.submission.status).toBe("committed");
      expect(service.listMemories(project.id)).toHaveLength(2);
      expect((db.prepare("SELECT intentional_conflict FROM memories WHERE object='南城'").get() as { intentional_conflict: number }).intentional_conflict).toBe(1);
    } finally {
      db.close();
    }
  });
});
