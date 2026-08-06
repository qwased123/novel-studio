import { describe, expect, it } from "vitest";
import { isoNow, newId, sqlite } from "./db.js";
import { acceptProposal } from "./proposal-accept.js";
import { createEntity, createProject, getDocument, getProjectTree, saveDocument } from "./repository.js";

function fixtureProject() {
  const { id } = createProject({
    title: `提案测试-${crypto.randomUUID()}`,
    genre: "悬疑",
    premise: "林彻在旧城档案馆寻找停电真相。",
    targetWords: 500_000,
    pov: "第三人称限知",
    audience: "中文网文读者",
  });
  return id;
}

function insertProposal(projectId: string, documentId: string, baseVersionId: string, targetType: string, payload: Record<string, unknown>) {
  const id = newId();
  sqlite.prepare(`
    INSERT INTO proposals(id, project_id, target_type, target_id, base_version_id, status, title, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', '测试提案', ?, ?)
  `).run(id, projectId, targetType, documentId, baseVersionId, JSON.stringify(payload), isoNow());
  return id;
}

describe("legacy proposal acceptance", () => {
  it("commits document canonical writes with the accepted status and blocks duplicates", () => {
    const projectId = fixtureProject();
    const documentId = String(getProjectTree(projectId)?.volumes[0]?.chapters[0]?.documentId);
    const before = getDocument(documentId)!;
    const versionCountBefore = (sqlite.prepare("SELECT COUNT(*) AS count FROM document_versions WHERE document_id=?").get(documentId) as { count: number }).count;
    const proposalId = insertProposal(projectId, documentId, String(before.currentVersionId), "document", {
      plainText: "接受后的正文。",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "接受后的正文。" }] }] },
      html: "<p>接受后的正文。</p>",
    });

    const outcome = acceptProposal(proposalId);
    expect(outcome).toMatchObject({ kind: "accepted", projectId, targetType: "document", targetId: documentId });
    expect(getDocument(documentId)?.plainText).toBe("接受后的正文。");
    expect((sqlite.prepare("SELECT status FROM proposals WHERE id=?").get(proposalId) as { status: string }).status).toBe("accepted");
    const versionCountAfter = (sqlite.prepare("SELECT COUNT(*) AS count FROM document_versions WHERE document_id=?").get(documentId) as { count: number }).count;
    expect(versionCountAfter).toBe(versionCountBefore + 1);

    expect(acceptProposal(proposalId)).toMatchObject({ kind: "not_found" });
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM document_versions WHERE document_id=?").get(documentId) as { count: number }).count).toBe(versionCountAfter);
  });

  it("rolls back canonical writes and the accepted status together", () => {
    const projectId = fixtureProject();
    const documentId = String(getProjectTree(projectId)?.volumes[0]?.chapters[0]?.documentId);
    const before = getDocument(documentId)!;
    const versionCountBefore = (sqlite.prepare("SELECT COUNT(*) AS count FROM document_versions WHERE document_id=?").get(documentId) as { count: number }).count;
    const proposalId = insertProposal(projectId, documentId, String(before.currentVersionId), "document", {
      plainText: "不应写入。",
      contentJson: { type: "doc" },
      html: "",
    });

    sqlite.exec("CREATE TEMP TRIGGER proposal_test_fail BEFORE INSERT ON document_versions BEGIN SELECT RAISE(ABORT, '测试故障'); END");
    try {
      expect(() => acceptProposal(proposalId)).toThrow(/测试故障/);
    } finally {
      sqlite.exec("DROP TRIGGER proposal_test_fail");
    }
    expect((sqlite.prepare("SELECT status FROM proposals WHERE id=?").get(proposalId) as { status: string }).status).toBe("pending");
    expect(getDocument(documentId)?.currentVersionId).toBe(before.currentVersionId);
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM document_versions WHERE document_id=?").get(documentId) as { count: number }).count).toBe(versionCountBefore);
  });

  it("commits memory canonical writes and marks stale source versions conflicted", () => {
    const projectId = fixtureProject();
    const entity = createEntity(projectId, { type: "character", name: "林彻", summary: "旧城刑警", aliases: [], attributes: {}, visibility: "author" });
    const documentId = String(getProjectTree(projectId)?.volumes[0]?.chapters[0]?.documentId);
    const baseVersionId = String(getDocument(documentId)!.currentVersionId);
    const proposalId = insertProposal(projectId, documentId, baseVersionId, "memory", {
      summary: "林彻在档案馆门前确认停电。",
      facts: [{ subject: "林彻", predicate: "所在地", object: "旧城档案馆", kind: "location", mutable: true, evidence: "站在档案馆门前" }],
      foreshadows: [{ title: "撕毁的值班表", detail: "二楼传来纸张翻动声", status: "open", evidence: "楼内有人活动" }],
    });

    expect(acceptProposal(proposalId)).toMatchObject({ kind: "accepted", targetType: "memory" });
    expect((sqlite.prepare("SELECT status FROM proposals WHERE id=?").get(proposalId) as { status: string }).status).toBe("accepted");
    const fact = sqlite.prepare("SELECT predicate, object_text AS objectText FROM facts WHERE project_id=? AND subject_entity_id=?").get(projectId, entity.id) as { predicate: string; objectText: string };
    expect(fact).toMatchObject({ predicate: "所在地", objectText: "旧城档案馆" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter_summaries WHERE project_id=?").get(projectId) as { count: number }).toMatchObject({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM foreshadows WHERE project_id=?").get(projectId) as { count: number }).toMatchObject({ count: 1 });

    const staleProposalId = insertProposal(projectId, documentId, baseVersionId, "memory", {
      facts: [{ subject: "林彻", predicate: "所在地", object: "旧城档案馆地下", mutable: true }],
    });
    saveDocument(documentId, {
      contentJson: { type: "doc" },
      plainText: "章节已被修改。",
      html: "",
      expectedVersionId: baseVersionId,
      message: "测试修改",
    });
    expect(acceptProposal(staleProposalId)).toMatchObject({ kind: "conflict", error: "来源章节已经变化，旧记忆提案已失效" });
    expect((sqlite.prepare("SELECT status FROM proposals WHERE id=?").get(staleProposalId) as { status: string }).status).toBe("conflicted");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM facts WHERE project_id=?").get(projectId) as { count: number }).toMatchObject({ count: 1 });
  });
});
