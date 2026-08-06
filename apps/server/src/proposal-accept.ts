import { textSelectionSchema } from "@novel-studio/contracts";
import { scheduleDrain } from "./ai-runner.js";
import { buildContext } from "./context.js";
import { isoNow, newId, parseJson, sqlite } from "./db.js";
import { replaceSelection } from "./document-content.js";
import { enqueueEmbeddingJob } from "./embeddings.js";
import { createForeshadow, getDocument, saveDocument } from "./repository.js";

type Row = Record<string, unknown>;

export type AcceptProposalOutcome =
  | { kind: "accepted"; projectId: string; targetType: string; targetId: string }
  | { kind: "not_found"; error: string }
  | { kind: "conflict"; error: string };

function markConflicted(proposal: Row, error: string): AcceptProposalOutcome {
  sqlite.prepare("UPDATE proposals SET status='conflicted', decided_at=? WHERE id=? AND status='pending'")
    .run(isoNow(), proposal.id);
  return { kind: "conflict", error };
}

const acceptProposalTransaction = sqlite.transaction((proposalId: string): AcceptProposalOutcome => {
  const proposal = sqlite.prepare("SELECT * FROM proposals WHERE id=?").get(proposalId) as Row | undefined;
  if (!proposal || String(proposal.status) !== "pending") {
    return { kind: "not_found", error: "待处理提案不存在" };
  }
  const payload = parseJson<Record<string, unknown>>(proposal.payload_json, {});
  const targetType = String(proposal.target_type);

  if (targetType === "document") {
    const document = getDocument(String(proposal.target_id));
    if (!document || document.currentVersionId !== proposal.base_version_id) {
      return markConflicted(proposal, "正文已发生变化，提案不能直接覆盖");
    }
    const nextContent = payload.kind === "selection_rewrite"
      ? replaceSelection(document.contentJson, textSelectionSchema.parse(payload.selection), String(payload.replacementText ?? ""))
      : { contentJson: payload.contentJson as Record<string, unknown>, plainText: String(payload.plainText ?? ""), html: String(payload.html ?? "") };
    try {
      saveDocument(String(proposal.target_id), {
        ...nextContent,
        expectedVersionId: String(proposal.base_version_id),
        message: "接受 AI 提案",
      }, "ai");
    } catch (error) {
      if ((error as { code?: string }).code === "VERSION_CONFLICT") {
        return markConflicted(proposal, "正文已发生变化，提案不能直接覆盖");
      }
      throw error;
    }
  } else if (targetType === "memory") {
    const document = getDocument(String(proposal.target_id));
    if (!document) throw new Error("记忆来源文档不存在");
    if (document.currentVersionId !== proposal.base_version_id) {
      return markConflicted(proposal, "来源章节已经变化，旧记忆提案已失效");
    }
    const facts = Array.isArray(payload.facts) ? payload.facts as Record<string, unknown>[] : [];
    for (const fact of facts) {
      const entity = sqlite.prepare("SELECT id FROM entities WHERE project_id=? AND (name=? OR aliases_json LIKE ?) LIMIT 1")
        .get(proposal.project_id, fact.subject, `%${String(fact.subject)}%`) as { id: string } | undefined;
      const predicate = String(fact.predicate ?? "状态");
      const objectText = String(fact.object ?? "");
      if (!entity && fact.subject) {
        sqlite.prepare(`INSERT INTO memory_conflicts(id,project_id,proposal_id,predicate,candidate_json,reason,status,created_at) VALUES (?,?,?,?,?,'无法解析事实主体','open',?)`)
          .run(newId(), proposal.project_id, proposal.id, predicate, JSON.stringify(fact), isoNow());
        continue;
      }
      const existing = sqlite.prepare(`SELECT * FROM facts WHERE project_id=? AND subject_entity_id IS ? AND predicate=? AND status='active' ORDER BY created_at DESC LIMIT 1`)
        .get(proposal.project_id, entity?.id ?? null, predicate) as Row | undefined;
      if (existing && String(existing.object_text) === objectText) continue;
      const mutable = fact.mutable !== false;
      if (existing && !mutable) {
        sqlite.prepare(`INSERT INTO memory_conflicts(id,project_id,proposal_id,subject_entity_id,predicate,existing_fact_id,candidate_json,reason,status,created_at) VALUES (?,?,?,?,?,?,?,'永久事实与现有记录冲突','open',?)`)
          .run(newId(), proposal.project_id, proposal.id, entity?.id ?? null, predicate, existing.id, JSON.stringify(fact), isoNow());
        continue;
      }
      if (existing && mutable) {
        sqlite.prepare("UPDATE facts SET status='historical',valid_to_chapter_id=?,updated_at=? WHERE id=?")
          .run(document.ownerType === "chapter" ? document.ownerId : null, isoNow(), existing.id);
      }
      sqlite.prepare(`INSERT INTO facts(id,project_id,subject_entity_id,predicate,object_text,valid_from_chapter_id,source_document_id,source_version_id,evidence,fact_kind,mutable,confidence,visibility,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,'active',?,?)`)
        .run(newId(), proposal.project_id, entity?.id ?? null, predicate, objectText, document.ownerType === "chapter" ? document.ownerId : null, document.id, document.currentVersionId, fact.evidence ?? "", fact.kind ?? "state", mutable ? 1 : 0, fact.visibility ?? "author", isoNow(), isoNow());
    }
    if (document.ownerType === "chapter" && payload.summary) {
      sqlite.prepare(`INSERT OR REPLACE INTO chapter_summaries(id,project_id,chapter_id,source_version_id,summary,continuation_excerpt,state_delta_json,stale,created_at) VALUES (?,?,?,?,?,?,?,0,?)`)
        .run(newId(), proposal.project_id, document.ownerId, document.currentVersionId, payload.summary, String(document.plainText).slice(-1000), JSON.stringify({ facts }), isoNow());
    }
    const foreshadows = Array.isArray(payload.foreshadows) ? payload.foreshadows as Record<string, unknown>[] : [];
    for (const entry of foreshadows) {
      const existing = sqlite.prepare("SELECT id FROM foreshadows WHERE project_id=? AND title=?").get(proposal.project_id, entry.title) as { id: string } | undefined;
      if (existing) sqlite.prepare("UPDATE foreshadows SET detail=?,status=?,evidence=?,updated_at=? WHERE id=?").run(entry.detail ?? "", entry.status ?? "advanced", entry.evidence ?? "", isoNow(), existing.id);
      else createForeshadow(String(proposal.project_id), { title: String(entry.title ?? "未命名伏笔"), detail: String(entry.detail ?? "") });
    }
  } else if (targetType === "arc_memory") {
    const sourceChapterIds = Array.isArray(payload.sourceChapterIds) ? payload.sourceChapterIds.map(String) : [];
    const sourceVersionIds = Array.isArray(payload.sourceVersionIds) ? payload.sourceVersionIds.map(String) : [];
    if (sourceChapterIds.length < 2 || sourceChapterIds.length !== sourceVersionIds.length) throw new Error("弧线记忆缺少完整来源");
    const validSources = sqlite.prepare(`SELECT COUNT(*) AS count FROM chapter_summaries s
      JOIN documents d ON d.owner_type='chapter' AND d.owner_id=s.chapter_id AND d.kind='chapter_content'
      WHERE s.project_id=? AND s.stale=0 AND s.source_version_id=d.current_version_id
        AND s.source_version_id IN (${sourceVersionIds.map(() => "?").join(",")})`).get(proposal.project_id, ...sourceVersionIds) as { count: number };
    if (validSources.count !== sourceVersionIds.length) {
      return markConflicted(proposal, "弧线来源已经变化，请重新蒸馏");
    }
    sqlite.prepare(`INSERT OR IGNORE INTO arc_summaries(id,project_id,start_chapter_id,end_chapter_id,source_versions_json,summary,open_threads_json,stale,created_at)
      VALUES (?,?,?,?,?,?,?,0,?)`).run(newId(), proposal.project_id, sourceChapterIds[0], sourceChapterIds[sourceChapterIds.length - 1], JSON.stringify(sourceVersionIds), String(payload.summary ?? ""), JSON.stringify(payload.openThreads ?? []), isoNow());
  } else {
    throw new Error("不支持的提案类型");
  }

  sqlite.prepare("UPDATE proposals SET status='accepted', decided_at=? WHERE id=?").run(isoNow(), proposal.id);
  return { kind: "accepted", projectId: String(proposal.project_id), targetType, targetId: String(proposal.target_id) };
});

export function acceptProposal(proposalId: string): AcceptProposalOutcome {
  return acceptProposalTransaction(proposalId);
}

export async function scheduleAcceptedProposalWork(outcome: AcceptProposalOutcome): Promise<void> {
  if (outcome.kind !== "accepted") return;
  if (outcome.targetType === "document") {
    const acceptedDocument = getDocument(outcome.targetId);
    const extractor = sqlite.prepare("SELECT enabled FROM model_profiles WHERE role='extractor'").get() as { enabled: number } | undefined;
    if (acceptedDocument?.kind === "chapter_content" && extractor?.enabled) {
      const context = await buildContext({ projectId: outcome.projectId, documentId: String(acceptedDocument.id), type: "extract_memory", instruction: "从当前已确认章节提取可追溯记忆。" });
      sqlite.prepare(`INSERT INTO ai_jobs(id,project_id,document_id,type,status,model_profile,instruction,context_snapshot_json,base_version_id,created_at)
        VALUES (?,?,?,'extract_memory','queued','extractor',?,?,?,?)`)
        .run(newId(), outcome.projectId, String(acceptedDocument.id), "从当前已确认章节提取可追溯记忆。", JSON.stringify(context.includedItems), String(acceptedDocument.currentVersionId), isoNow());
      scheduleDrain();
    }
    if (acceptedDocument && enqueueEmbeddingJob(outcome.projectId, String(acceptedDocument.id), "document")) scheduleDrain();
  } else if (outcome.targetType === "memory") {
    const document = getDocument(outcome.targetId);
    const extractor = sqlite.prepare("SELECT enabled FROM model_profiles WHERE role='extractor'").get() as { enabled: number } | undefined;
    if (document?.ownerType === "chapter" && extractor?.enabled) {
      const count = (sqlite.prepare("SELECT COUNT(*) AS count FROM chapter_summaries WHERE project_id=? AND stale=0").get(outcome.projectId) as { count: number }).count;
      if (count >= 5 && count % 5 === 0) {
        const context = await buildContext({ projectId: outcome.projectId, documentId: String(document.id), type: "distill_arc", instruction: "将最近五个已确认章节摘要蒸馏为阶段弧线记忆。" });
        const sources = context.includedItems.filter((entry) => entry.id.startsWith("arc-chapter:"));
        const sourceVersions = JSON.stringify(sources.map((entry) => entry.sourceVersionId));
        const exists = sqlite.prepare("SELECT id FROM arc_summaries WHERE project_id=? AND source_versions_json=?").get(outcome.projectId, sourceVersions);
        if (sources.length === 5 && !exists) {
          sqlite.prepare(`INSERT INTO ai_jobs(id,project_id,document_id,type,status,model_profile,instruction,context_snapshot_json,base_version_id,created_at)
            VALUES (?,?,?,'distill_arc','queued','extractor',?,?,?,?)`)
            .run(newId(), outcome.projectId, document.id, "将最近五个已确认章节摘要蒸馏为阶段弧线记忆。", JSON.stringify(context.includedItems), document.currentVersionId, isoNow());
          scheduleDrain();
        }
      }
    }
  }
}
