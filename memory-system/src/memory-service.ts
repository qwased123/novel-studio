import { chunkText } from "./chunking.js";
import type { MemoryDatabase } from "./database.js";
import { findConflicts, impactKeyFor, type ConflictProposal } from "./conflicts.js";
import { newId, normalizeName, nowIso, sha256 } from "./ids.js";
import { OpenAiCompatibleModels } from "./models.js";
import {
  EPISTEMIC_SCOPES,
  MEMORY_KINDS,
  type ConflictRecord,
  type MemoryCandidateInput,
  type MemoryKind,
  type MemoryRecord,
  type ModelConfig,
  type SubmissionInput,
  type SubmissionStatus,
} from "./types.js";

export interface ProjectRecord {
  id: string;
  name: string;
  seriesKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionRecord {
  id: string;
  projectId: string;
  title: string;
  kind: SubmissionInput["kind"];
  content: string;
  contentHash: string;
  chapter: string | null;
  scene: string | null;
  storyTime: string | null;
  revealOrder: number;
  status: SubmissionStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewResult {
  submission: SubmissionRecord;
  candidateIds: string[];
  memoryIds: string[];
  conflicts: ConflictRecord[];
}

export interface ConflictResolutionInput {
  action: "intentional_coexist" | "reclassify" | "retcon_existing" | "reject_submission";
  note: string;
  payload?: Record<string, unknown>;
}

export interface AuditReport {
  projectId: string;
  ok: boolean;
  issues: string[];
  counts: Record<string, number>;
  impactKeys: string[];
}

export interface MemoryModelProvider {
  extract(content: string, context: string, chunkOffset: number): Promise<MemoryCandidateInput[]>;
  verifyConflict(input: { candidate: MemoryCandidateInput; existing: string; explanation: string }): Promise<{ confirmed: boolean; explanation: string }>;
}

type CandidateRow = {
  id: string;
  kind: MemoryKind;
  scope: MemoryCandidateInput["scope"];
  subject: string;
  predicate: string;
  object: string;
  perspective: string | null;
  storyTimeStart: string | null;
  storyTimeEnd: string | null;
  confidence: number;
  threadKey: string | null;
  lifecycle: NonNullable<MemoryCandidateInput["lifecycle"]>;
  spanStart: number;
  spanEnd: number;
  spanText: string;
  status: string;
};

type PreparedCandidate = { id: string; input: MemoryCandidateInput };

const candidateKinds = new Set<string>(MEMORY_KINDS);
const candidateScopes = new Set<string>(EPISTEMIC_SCOPES);

export class MemoryService {
  private readonly models: MemoryModelProvider;

  constructor(private readonly db: MemoryDatabase, models?: MemoryModelProvider) {
    this.models = models ?? new OpenAiCompatibleModels(db);
  }

  createProject(name: string, seriesKey = "standalone"): ProjectRecord {
    const cleanName = name.trim();
    const cleanSeriesKey = seriesKey.trim() || "standalone";
    if (!cleanName) throw new Error("项目名称不能为空");
    const id = newId();
    const timestamp = nowIso();
    this.db.prepare("INSERT INTO projects(id,name,series_key,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run(id, cleanName, cleanSeriesKey, timestamp, timestamp);
    return this.getProject(id);
  }

  getProject(projectId: string): ProjectRecord {
    const row = this.db.prepare(`SELECT id,name,series_key AS seriesKey,created_at AS createdAt,updated_at AS updatedAt
      FROM projects WHERE id=?`).get(projectId) as ProjectRecord | undefined;
    if (!row) throw new Error(`项目不存在: ${projectId}`);
    return row;
  }

  createSubmission(projectId: string, input: SubmissionInput): SubmissionRecord {
    this.getProject(projectId);
    const title = input.title.trim();
    if (!title) throw new Error("提交标题不能为空");
    if (!input.content.trim()) throw new Error("提交正文不能为空");
    const contentHash = sha256(input.content);
    const existing = this.db.prepare(`SELECT id,project_id AS projectId,title,source_kind AS kind,content,content_hash AS contentHash,
        chapter,scene,story_time AS storyTime,reveal_order AS revealOrder,status,error,created_at AS createdAt,updated_at AS updatedAt
      FROM submissions WHERE project_id=? AND content_hash=? AND source_kind=?`).get(projectId, contentHash, input.kind) as SubmissionRecord | undefined;
    if (existing) return existing;

    const id = newId();
    const timestamp = nowIso();
    const revealOrder = input.revealOrder ?? this.nextRevealOrder(projectId);
    const insert = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO submissions(id,project_id,title,source_kind,content,content_hash,chapter,scene,story_time,reveal_order,status,error,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`)
        .run(id, projectId, title, input.kind, input.content, contentHash, input.chapter ?? null, input.scene ?? null,
          input.storyTime ?? null, revealOrder, "draft", timestamp, timestamp);
      for (const candidate of input.candidates ?? []) this.insertCandidate(id, this.validateCandidate(input.content, candidate), "pending");
    });
    insert();
    return this.getSubmission(projectId, id);
  }

  getSubmission(projectId: string, submissionId: string): SubmissionRecord {
    const row = this.db.prepare(`SELECT id,project_id AS projectId,title,source_kind AS kind,content,content_hash AS contentHash,
        chapter,scene,story_time AS storyTime,reveal_order AS revealOrder,status,error,created_at AS createdAt,updated_at AS updatedAt
      FROM submissions WHERE id=? AND project_id=?`).get(submissionId, projectId) as SubmissionRecord | undefined;
    if (!row) throw new Error(`提交不存在或不属于项目: ${submissionId}`);
    return row;
  }

  listSubmissions(projectId: string, options: { status?: SubmissionStatus; limit?: number } = {}): SubmissionRecord[] {
    this.getProject(projectId);
    const clauses = ["project_id=?"];
    const params: unknown[] = [projectId];
    if (options.status) { clauses.push("status=?"); params.push(options.status); }
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
    return this.db.prepare(`SELECT id,project_id AS projectId,title,source_kind AS kind,content,content_hash AS contentHash,
        chapter,scene,story_time AS storyTime,reveal_order AS revealOrder,status,error,created_at AS createdAt,updated_at AS updatedAt
      FROM submissions WHERE ${clauses.join(" AND ")} ORDER BY reveal_order DESC,created_at DESC,id DESC LIMIT ?`).all(...params, limit) as SubmissionRecord[];
  }

  async reviewSubmission(projectId: string, submissionId: string): Promise<ReviewResult> {
    const submission = this.getSubmission(projectId, submissionId);
    if (submission.status === "committed") return this.resultForCommitted(submission);
    if (submission.status === "rejected") throw new Error("已拒绝的提交不能再次审查");
    if (submission.status === "reviewing") throw new Error("提交正在审查中");
    if (submission.status === "blocked" && this.openConflictCount(projectId, submissionId) > 0) {
      return { submission, candidateIds: this.candidateIds(submissionId), memoryIds: [], conflicts: this.listConflicts(projectId, { submissionId, status: "open" }) };
    }

    this.db.prepare("UPDATE submissions SET status='reviewing',error=NULL,updated_at=? WHERE id=? AND project_id=?")
      .run(nowIso(), submissionId, projectId);

    try {
      const pendingRows = this.loadCandidateRows(submissionId).filter((row) => row.status === "pending" || row.status === "accepted");
      const extracted = pendingRows.length > 0
        ? pendingRows.map((row) => this.inputFromCandidateRow(row))
        : await this.extractCandidates(projectId, submission);
      const candidates = extracted.map((candidate) => this.validateCandidate(submission.content, candidate));
      const prepared = pendingRows.length
        ? candidates.map((input, index) => ({ id: pendingRows[index]!.id, input }))
        : candidates.map((input) => ({ id: newId(), input }));
      const proposals = await this.verifyProposals(projectId, prepared);
      const transaction = this.db.transaction(() => {
        const existingCandidateIds = new Set(pendingRows.map((candidate) => candidate.id));
        for (const candidate of prepared) {
          if (existingCandidateIds.has(candidate.id)) {
            this.db.prepare(`UPDATE submission_candidates SET kind=?,scope=?,subject=?,predicate=?,object=?,perspective=?,story_time_start=?,story_time_end=?,confidence=?,thread_key=?,lifecycle=?,span_start=?,span_end=?,span_text=?,status='pending' WHERE id=? AND submission_id=?`)
              .run(candidate.input.kind, candidate.input.scope, candidate.input.subject, candidate.input.predicate, candidate.input.object,
                candidate.input.perspective ?? null, candidate.input.storyTimeStart ?? null, candidate.input.storyTimeEnd ?? null, candidate.input.confidence ?? 0.5,
                candidate.input.threadKey ?? null, candidate.input.lifecycle ?? "active", candidate.input.spanStart, candidate.input.spanEnd, candidate.input.spanText,
                candidate.id, submissionId);
          } else {
            this.insertCandidate(submissionId, candidate.input, "pending", candidate.id);
          }
        }
        if (proposals.length > 0) {
          const candidateIdsWithConflict = new Set(proposals.map(({ candidateId }) => candidateId));
          for (const candidate of prepared) {
            if (candidateIdsWithConflict.has(candidate.id)) this.db.prepare("UPDATE submission_candidates SET status='conflict' WHERE id=?").run(candidate.id);
          }
          for (const proposal of proposals) this.insertConflict(projectId, submissionId, proposal);
          this.db.prepare("UPDATE submissions SET status='blocked',error=NULL,updated_at=? WHERE id=?").run(nowIso(), submissionId);
          return { memoryIds: [] as string[], blocked: true };
        }
        const memoryIds = this.commitSubmissionTx(projectId, submissionId, prepared.map((candidate) => candidate.id));
        return { memoryIds, blocked: false };
      });
      const result = transaction() as { memoryIds: string[]; blocked: boolean };
      const updated = this.getSubmission(projectId, submissionId);
      return {
        submission: updated,
        candidateIds: this.candidateIds(submissionId),
        memoryIds: result.memoryIds,
        conflicts: result.blocked ? this.listConflicts(projectId, { submissionId, status: "open" }) : [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.prepare("UPDATE submissions SET status='failed',error=?,updated_at=? WHERE id=? AND project_id=?")
        .run(message.slice(0, 2000), nowIso(), submissionId, projectId);
      throw error;
    }
  }

  listConflicts(projectId: string, filter: { submissionId?: string; status?: ConflictRecord["status"] } = {}): ConflictRecord[] {
    this.getProject(projectId);
    const clauses = ["project_id=?"];
    const params: unknown[] = [projectId];
    if (filter.submissionId) { clauses.push("submission_id=?"); params.push(filter.submissionId); }
    if (filter.status) { clauses.push("status=?"); params.push(filter.status); }
    const rows = this.db.prepare(`SELECT id,project_id AS projectId,submission_id AS submissionId,candidate_id AS candidateId,
        existing_memory_id AS existingMemoryId,later_memory_id AS laterMemoryId,severity,category,impact_key AS impactKey,
        explanation,status,resolution_action AS resolutionAction,resolution_note AS resolutionNote,created_at AS createdAt,resolved_at AS resolvedAt
      FROM conflicts WHERE ${clauses.join(" AND ")} ORDER BY created_at,id`).all(...params) as ConflictRecord[];
    return rows;
  }

  resolveConflict(projectId: string, conflictId: string, input: ConflictResolutionInput): ReviewResult | ConflictRecord {
    this.getProject(projectId);
    if (!input.note.trim()) throw new Error("裁决说明不能为空");
    const conflict = this.db.prepare(`SELECT id,project_id AS projectId,submission_id AS submissionId,candidate_id AS candidateId,
        existing_memory_id AS existingMemoryId,later_memory_id AS laterMemoryId,severity,category,impact_key AS impactKey,
        explanation,status,resolution_action AS resolutionAction,resolution_note AS resolutionNote,created_at AS createdAt,resolved_at AS resolvedAt
      FROM conflicts WHERE id=? AND project_id=?`).get(conflictId, projectId) as ConflictRecord | undefined;
    if (!conflict) throw new Error(`冲突不存在或不属于项目: ${conflictId}`);
    if (conflict.status !== "open") throw new Error("冲突已经处理");
    const allowed = new Set(["intentional_coexist", "reclassify", "retcon_existing", "reject_submission"]);
    if (!allowed.has(input.action)) throw new Error(`不支持的裁决动作: ${input.action}`);

    const transaction = this.db.transaction(() => {
      const timestamp = nowIso();
      const recordResolution = (id: string) => {
        this.db.prepare("UPDATE conflicts SET status=?,resolution_action=?,resolution_note=?,resolved_at=? WHERE id=?")
          .run(input.action === "reject_submission" ? "dismissed" : "resolved", input.action, input.note.trim(), timestamp, id);
        this.db.prepare("INSERT INTO resolutions(id,conflict_id,project_id,action,note,payload_json,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(newId(), id, projectId, input.action, input.note.trim(), JSON.stringify(input.payload ?? {}), timestamp);
      };
      if (input.action === "retcon_existing") {
        if (!conflict.existingMemoryId) throw new Error("retcon 缺少既有记忆");
        this.retconTx(projectId, conflict.existingMemoryId, input.note);
      }
      if (input.action === "reclassify") this.reclassifyCandidateTx(projectId, conflict, input.payload ?? {});
      if (input.action === "intentional_coexist" && conflict.candidateId) {
        this.db.prepare("UPDATE submission_candidates SET status='accepted' WHERE id=?").run(conflict.candidateId);
      }
      if (input.action === "reject_submission" && conflict.submissionId) {
        this.db.prepare("UPDATE submissions SET status='rejected',error=?,updated_at=? WHERE id=? AND project_id=?")
          .run(input.note.slice(0, 2000), timestamp, conflict.submissionId, projectId);
        this.db.prepare("UPDATE submission_candidates SET status='rejected' WHERE submission_id=?").run(conflict.submissionId);
        const openConflicts = this.db.prepare("SELECT id FROM conflicts WHERE project_id=? AND submission_id=? AND status='open'")
          .all(projectId, conflict.submissionId) as Array<{ id: string }>;
        for (const openConflict of openConflicts) recordResolution(openConflict.id);
      } else {
        recordResolution(conflictId);
      }
      if (input.action === "reject_submission" || !conflict.submissionId || this.openConflictCount(projectId, conflict.submissionId) > 0) return null;
      const candidateIds = this.candidateIds(conflict.submissionId);
      const memoryIds = this.commitSubmissionTx(projectId, conflict.submissionId, candidateIds);
      return { memoryIds };
    });
    const outcome = transaction() as { memoryIds: string[] } | null;
    if (input.action === "reject_submission") {
      const rejectedConflicts = this.listConflicts(projectId, { submissionId: conflict.submissionId ?? undefined, status: "dismissed" });
      return rejectedConflicts.find((item) => item.id === conflictId) ?? { ...conflict, status: "dismissed", resolutionAction: input.action, resolutionNote: input.note.trim(), resolvedAt: nowIso() };
    }
    if (!conflict.submissionId || !outcome) return this.listConflicts(projectId, { status: "resolved" }).find((item) => item.id === conflictId) ?? conflict;
    const submission = this.getSubmission(projectId, conflict.submissionId);
    return { submission, candidateIds: this.candidateIds(conflict.submissionId), memoryIds: outcome.memoryIds, conflicts: [] };
  }

  retcon(projectId: string, memoryId: string, note: string): MemoryRecord {
    this.getProject(projectId);
    if (!note.trim()) throw new Error("retcon 说明不能为空");
    const transaction = this.db.transaction(() => this.retconTx(projectId, memoryId, note));
    transaction();
    return this.getMemory(projectId, memoryId);
  }

  listMemories(projectId: string, options: { subject?: string; scope?: MemoryRecord["scope"]; includeRetconned?: boolean } = {}): MemoryRecord[] {
    this.getProject(projectId);
    const clauses = ["m.project_id=?"];
    const params: unknown[] = [projectId];
    if (!options.includeRetconned) clauses.push("m.valid_until IS NULL");
    if (options.subject) { clauses.push("lower(m.subject)=lower(?)"); params.push(options.subject.trim()); }
    if (options.scope) { clauses.push("m.scope=?"); params.push(options.scope); }
    const rows = this.db.prepare(`SELECT m.id,m.project_id AS projectId,m.source_version_id AS sourceVersionId,sv.title AS sourceTitle,
        m.kind,m.scope,m.subject,m.predicate,m.object,m.perspective,m.story_time_start AS storyTimeStart,m.story_time_end AS storyTimeEnd,
        m.confidence,m.thread_key AS threadKey,m.lifecycle,m.span_start AS spanStart,m.span_end AS spanEnd,m.span_text AS spanText,
        m.disputed,m.created_at AS createdAt,m.valid_until AS validUntil,m.reveal_order AS revealOrder
      FROM memories m JOIN source_versions sv ON sv.id=m.source_version_id
      WHERE ${clauses.join(" AND ")} ORDER BY m.reveal_order,m.created_at,m.id`).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.memoryFromRow(row));
  }

  auditProject(projectId: string, options: { impactKeys?: string[] } = {}): AuditReport {
    this.getProject(projectId);
    const issues: string[] = [];
    const impactKeys = [...new Set((options.impactKeys ?? []).map((key) => key.trim()).filter(Boolean))];
    const scoped = impactKeys.length > 0 ? new Set(impactKeys) : null;
    const count = (sql: string, ...params: unknown[]) => Number((this.db.prepare(sql).get(...params) as { count: number }).count);
    const counts = {
      submissions: count("SELECT count(*) AS count FROM submissions WHERE project_id=?", projectId),
      sourceVersions: count("SELECT count(*) AS count FROM source_versions WHERE project_id=?", projectId),
      memories: count("SELECT count(*) AS count FROM memories WHERE project_id=?", projectId),
      conflictsOpen: count("SELECT count(*) AS count FROM conflicts WHERE project_id=? AND status='open'", projectId),
    };
    const conflictRows = this.db.prepare(`SELECT id,submission_id AS submissionId,impact_key AS impactKey,status FROM conflicts WHERE project_id=?`).all(projectId) as Array<{ id: string; submissionId: string | null; impactKey: string; status: string }>;
    const scopedConflicts = conflictRows.filter((row) => !scoped || scoped.has(row.impactKey));
    const scopedSubmissionIds = new Set(scopedConflicts.map((row) => row.submissionId).filter((id): id is string => Boolean(id)));
    const submissionScopeClause = scoped
      ? scopedSubmissionIds.size > 0 ? ` AND s.id IN (${[...scopedSubmissionIds].map(() => "?").join(",")})` : " AND 1=0"
      : "";
    const blockedWithCanonical = count(`SELECT count(*) AS count FROM submissions s
      WHERE s.project_id=? AND s.status='blocked' AND EXISTS(SELECT 1 FROM source_versions sv WHERE sv.submission_id=s.id)${submissionScopeClause}`,
      projectId, ...[...scopedSubmissionIds]);
    if (blockedWithCanonical > 0) issues.push(`${blockedWithCanonical} 个 blocked 提交已有 source_version`);
    const committedOpenConflicts = scoped
      ? scopedConflicts.filter((row) => row.status === "open" && row.submissionId && this.getSubmission(projectId, row.submissionId).status === "committed").length
      : count(`SELECT count(*) AS count FROM conflicts c JOIN submissions s ON s.id=c.submission_id
        WHERE c.project_id=? AND c.status='open' AND s.status='committed'`, projectId);
    if (committedOpenConflicts > 0) issues.push(`${committedOpenConflicts} 个已提交来源仍有 open conflict`);
    const rows = this.db.prepare(`SELECT m.id,m.subject,m.predicate,m.scope,m.perspective,m.thread_key AS threadKey,m.span_start AS spanStart,m.span_end AS spanEnd,m.span_text AS spanText,sv.content
      FROM memories m JOIN source_versions sv ON sv.id=m.source_version_id WHERE m.project_id=?`).all(projectId) as Array<{ id: string; subject: string; predicate: string; scope: string; perspective: string | null; threadKey: string | null; spanStart: number; spanEnd: number; spanText: string; content: string }>;
    for (const row of rows) {
      const key = impactKeyFor({ subject: row.subject, predicate: row.predicate, scope: row.scope as MemoryRecord["scope"], perspective: row.perspective, threadKey: row.threadKey });
      if (scoped && !scoped.has(key)) continue;
      if (row.content.slice(row.spanStart, row.spanEnd) !== row.spanText) issues.push(`记忆 ${row.id} 的 evidence span 与原文不一致`);
    }
    for (const conflict of scopedConflicts.filter((row) => row.status === "open")) {
      this.db.prepare(`INSERT OR IGNORE INTO line_blocks(id,project_id,impact_key,conflict_id,created_at) VALUES(?,?,?,?,?)`)
        .run(newId(), projectId, conflict.impactKey, conflict.id, nowIso());
    }
    const duplicateSource = count(`SELECT count(*) AS count FROM (
      SELECT content_hash,source_kind FROM source_versions WHERE project_id=? GROUP BY content_hash,source_kind HAVING count(*)>1
    )`, projectId);
    if (duplicateSource > 0) issues.push(`${duplicateSource} 组 source_version 重复`);
    return { projectId, ok: issues.length === 0, issues, counts, impactKeys };
  }

  private async extractCandidates(projectId: string, submission: SubmissionRecord): Promise<MemoryCandidateInput[]> {
    const chunks = chunkText(submission.content);
    const context = this.extractionContext(projectId);
    const all: MemoryCandidateInput[] = [];
    for (const chunk of chunks) all.push(...await this.models.extract(chunk.content, context, chunk.spanStart));
    return all;
  }

  private extractionContext(projectId: string): string {
    const rows = this.db.prepare(`SELECT subject,predicate,object,scope,span_text AS spanText FROM memories
      WHERE project_id=? AND valid_until IS NULL AND disputed=0 ORDER BY reveal_order DESC,created_at DESC LIMIT 100`).all(projectId) as Array<Record<string, string>>;
    return rows.map((row) => `${row.scope}: ${row.subject} ${row.predicate} ${row.object}（证据：${row.spanText}）`).join("\n");
  }

  private async verifyProposals(projectId: string, candidates: PreparedCandidate[]): Promise<Array<ConflictProposal & { candidateId: string }>> {
    const proposals: Array<ConflictProposal & { candidateId: string }> = [];
    for (const candidate of candidates) {
      for (const proposal of findConflicts(this.db, projectId, candidate.input)) {
        const verification = await this.models.verifyConflict({
          candidate: candidate.input,
          existing: `${proposal.existing.subject} ${proposal.existing.predicate} ${proposal.existing.object}（证据：${proposal.existing.spanText}）`,
          explanation: proposal.explanation,
        });
        if (verification.confirmed) proposals.push({ ...proposal, explanation: verification.explanation, candidateId: candidate.id });
      }
    }
    return proposals.filter((proposal, index, all) => all.findIndex((other) => other.candidateId === proposal.candidateId && other.existing.id === proposal.existing.id && other.category === proposal.category) === index);
  }

  private validateCandidate(content: string, candidate: MemoryCandidateInput): MemoryCandidateInput {
    if (!candidateKinds.has(candidate.kind)) throw new Error(`非法记忆类型: ${candidate.kind}`);
    if (!candidateScopes.has(candidate.scope)) throw new Error(`非法认知域: ${candidate.scope}`);
    if (!candidate.subject.trim() || !candidate.predicate.trim() || !candidate.object.trim()) throw new Error("candidate 的 subject/predicate/object 不能为空");
    if (!Number.isInteger(candidate.spanStart) || !Number.isInteger(candidate.spanEnd) || candidate.spanStart < 0 || candidate.spanEnd <= candidate.spanStart) throw new Error("candidate span 必须是合法的 UTF-16 左闭右开区间");
    if (candidate.spanEnd > content.length || content.slice(candidate.spanStart, candidate.spanEnd) !== candidate.spanText) throw new Error(`evidence span 不匹配: ${candidate.spanStart}-${candidate.spanEnd}`);
    if (candidate.confidence !== undefined && (candidate.confidence < 0 || candidate.confidence > 1)) throw new Error("confidence 必须在 0 到 1 之间");
    return {
      ...candidate,
      subject: candidate.subject.trim(), predicate: candidate.predicate.trim(), object: candidate.object.trim(),
      perspective: candidate.perspective?.trim() || null, storyTimeStart: candidate.storyTimeStart?.trim() || null,
      storyTimeEnd: candidate.storyTimeEnd?.trim() || null, threadKey: candidate.threadKey?.trim() || null,
      confidence: candidate.confidence ?? 0.5, lifecycle: candidate.lifecycle ?? "active",
    };
  }

  private insertCandidate(submissionId: string, candidate: MemoryCandidateInput, status: string, id: string = newId()) {
    this.db.prepare(`INSERT INTO submission_candidates(id,submission_id,kind,scope,subject,predicate,object,perspective,story_time_start,story_time_end,confidence,thread_key,lifecycle,span_start,span_end,span_text,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, submissionId, candidate.kind, candidate.scope, candidate.subject, candidate.predicate, candidate.object,
      candidate.perspective ?? null, candidate.storyTimeStart ?? null, candidate.storyTimeEnd ?? null, candidate.confidence ?? 0.5,
      candidate.threadKey ?? null, candidate.lifecycle ?? "active", candidate.spanStart, candidate.spanEnd, candidate.spanText, status, nowIso());
    return id;
  }

  private insertConflict(projectId: string, submissionId: string, proposal: ConflictProposal & { candidateId: string }) {
    this.db.prepare(`INSERT INTO conflicts(id,project_id,submission_id,candidate_id,existing_memory_id,later_memory_id,severity,category,impact_key,explanation,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(newId(), projectId, submissionId, proposal.candidateId, proposal.existing.id, null, proposal.severity,
      proposal.category, proposal.impactKey, proposal.explanation, "open", nowIso());
  }

  private commitSubmissionTx(projectId: string, submissionId: string, candidateIds: string[]): string[] {
    const submission = this.getSubmission(projectId, submissionId);
    const candidateRows = this.loadCandidateRows(submissionId).filter((row) => candidateIds.includes(row.id) && row.status !== "rejected");
    const sourceVersionId = newId();
    const committedAt = nowIso();
    this.db.prepare(`INSERT INTO source_versions(id,project_id,submission_id,title,source_kind,content,content_hash,chapter,scene,story_time,reveal_order,committed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(sourceVersionId, projectId, submissionId, submission.title, submission.kind, submission.content,
      submission.contentHash, submission.chapter, submission.scene, submission.storyTime, submission.revealOrder, committedAt);
    const insertChunk = this.db.prepare(`INSERT INTO source_chunks(id,source_version_id,seq,span_start,span_end,content,content_hash,chapter_label) VALUES(?,?,?,?,?,?,?,?)`);
    const insertChunkFts = this.db.prepare("INSERT INTO source_chunks_fts(chunk_id,project_id,title,content) VALUES(?,?,?,?)");
    for (const chunk of chunkText(submission.content)) {
      const chunkId = newId();
      insertChunk.run(chunkId, sourceVersionId, chunk.seq, chunk.spanStart, chunk.spanEnd, chunk.content, chunk.contentHash, chunk.chapterLabel);
      insertChunkFts.run(chunkId, projectId, submission.title, chunk.content);
    }

    const memoryIds: string[] = [];
    const insertMemory = this.db.prepare(`INSERT INTO memories(id,project_id,source_version_id,candidate_id,kind,scope,subject_entity_id,subject,predicate,object,object_entity_id,perspective_entity_id,perspective,story_time_start,story_time_end,reveal_order,lifecycle,confidence,thread_key,span_start,span_end,span_text,disputed,intentional_conflict,valid_from,valid_until,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertMemoryFts = this.db.prepare("INSERT INTO memories_fts(memory_id,project_id,subject,predicate,object,span_text) VALUES(?,?,?,?,?,?)");
    for (const row of candidateRows) {
      const subjectEntityId = this.ensureEntity(projectId, row.subject, row.kind);
      const objectEntityId = this.entityObjectKind(row.kind) ? this.ensureEntity(projectId, row.object, "object") : null;
      const perspectiveEntityId = row.perspective ? this.ensureEntity(projectId, row.perspective, "perspective") : null;
      const memoryId = newId();
      const intentional = Number((this.db.prepare(`SELECT count(*) AS count FROM conflicts c JOIN resolutions r ON r.conflict_id=c.id
        WHERE c.submission_id=? AND c.candidate_id=? AND r.action='intentional_coexist'`).get(submissionId, row.id) as { count: number }).count) > 0;
      insertMemory.run(memoryId, projectId, sourceVersionId, row.id, row.kind, row.scope, subjectEntityId, row.subject, row.predicate, row.object,
        objectEntityId, perspectiveEntityId, row.perspective, row.storyTimeStart, row.storyTimeEnd, submission.revealOrder, row.lifecycle,
        row.confidence, row.threadKey, row.spanStart, row.spanEnd, row.spanText, 0, intentional ? 1 : 0, committedAt, null, committedAt);
      insertMemoryFts.run(memoryId, projectId, row.subject, row.predicate, row.object, row.spanText);
      if (objectEntityId) this.db.prepare("INSERT INTO memory_edges(id,project_id,from_entity_id,to_entity_id,memory_id,relation) VALUES(?,?,?,?,?,?)")
        .run(newId(), projectId, subjectEntityId, objectEntityId, memoryId, row.predicate);
      if (perspectiveEntityId) this.db.prepare("INSERT INTO memory_edges(id,project_id,from_entity_id,to_entity_id,memory_id,relation) VALUES(?,?,?,?,?,?)")
        .run(newId(), projectId, perspectiveEntityId, subjectEntityId, memoryId, "perspective");
      this.db.prepare("UPDATE submission_candidates SET status='accepted' WHERE id=?").run(row.id);
      memoryIds.push(memoryId);
    }
    this.db.prepare("UPDATE submissions SET status='committed',error=NULL,updated_at=? WHERE id=? AND project_id=?").run(committedAt, submissionId, projectId);
    this.db.prepare("UPDATE projects SET updated_at=? WHERE id=?").run(committedAt, projectId);
    return memoryIds;
  }

  private ensureEntity(projectId: string, name: string, entityType: string): string {
    const normalized = normalizeName(name);
    const existing = this.db.prepare("SELECT id FROM entities WHERE project_id=? AND normalized_name=?").get(projectId, normalized) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = newId();
    this.db.prepare("INSERT INTO entities(id,project_id,name,normalized_name,entity_type,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, projectId, name, normalized, entityType, nowIso());
    return id;
  }

  private entityObjectKind(kind: MemoryKind) {
    return new Set<MemoryKind>(["relationship", "event", "state_change", "location_topology", "causal_link", "entity"]).has(kind);
  }

  private retconTx(projectId: string, memoryId: string, _note: string) {
    const result = this.db.prepare("UPDATE memories SET valid_until=?,lifecycle='superseded' WHERE id=? AND project_id=? AND valid_until IS NULL")
      .run(nowIso(), memoryId, projectId);
    if (result.changes === 0) throw new Error(`有效记忆不存在或已经 retcon: ${memoryId}`);
  }

  private reclassifyCandidateTx(projectId: string, conflict: ConflictRecord, payload: Record<string, unknown>) {
    if (!conflict.candidateId || !conflict.submissionId) throw new Error("reclassify 缺少候选");
    const submission = this.db.prepare("SELECT project_id AS projectId FROM submissions WHERE id=?").get(conflict.submissionId) as { projectId: string } | undefined;
    if (!submission || submission.projectId !== projectId) throw new Error("候选不属于项目");
    const candidate = this.db.prepare("SELECT id FROM submission_candidates WHERE id=? AND submission_id=?").get(conflict.candidateId, conflict.submissionId);
    if (!candidate) throw new Error("候选不存在");
    const fields: string[] = [];
    const values: unknown[] = [];
    if (payload.scope !== undefined) {
      if (typeof payload.scope !== "string" || !candidateScopes.has(payload.scope)) throw new Error("reclassify.scope 非法");
      fields.push("scope=?"); values.push(payload.scope);
    }
    if (payload.kind !== undefined) {
      if (typeof payload.kind !== "string" || !candidateKinds.has(payload.kind)) throw new Error("reclassify.kind 非法");
      fields.push("kind=?"); values.push(payload.kind);
    }
    if (payload.perspective !== undefined) {
      if (payload.perspective !== null && typeof payload.perspective !== "string") throw new Error("reclassify.perspective 非法");
      fields.push("perspective=?"); values.push(payload.perspective);
    }
    if (fields.length === 0) throw new Error("reclassify 至少需要 scope、kind 或 perspective");
    values.push(conflict.candidateId);
    this.db.prepare(`UPDATE submission_candidates SET ${fields.join(",")},status='accepted' WHERE id=?`).run(...values);
  }

  private getMemory(projectId: string, memoryId: string): MemoryRecord {
    const row = this.db.prepare(`SELECT m.id,m.project_id AS projectId,m.source_version_id AS sourceVersionId,sv.title AS sourceTitle,
        m.kind,m.scope,m.subject,m.predicate,m.object,m.perspective,m.story_time_start AS storyTimeStart,m.story_time_end AS storyTimeEnd,
        m.confidence,m.thread_key AS threadKey,m.lifecycle,m.span_start AS spanStart,m.span_end AS spanEnd,m.span_text AS spanText,
        m.disputed,m.created_at AS createdAt,m.valid_until AS validUntil,m.reveal_order AS revealOrder
      FROM memories m JOIN source_versions sv ON sv.id=m.source_version_id WHERE m.id=? AND m.project_id=?`).get(memoryId, projectId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`记忆不存在或不属于项目: ${memoryId}`);
    return this.memoryFromRow(row);
  }

  private memoryFromRow(row: Record<string, unknown>): MemoryRecord {
    return {
      id: String(row.id), projectId: String(row.projectId), sourceVersionId: String(row.sourceVersionId), sourceTitle: String(row.sourceTitle),
      kind: row.kind as MemoryKind, scope: row.scope as MemoryRecord["scope"], subject: String(row.subject), predicate: String(row.predicate), object: String(row.object),
      perspective: row.perspective === null ? null : String(row.perspective), storyTimeStart: row.storyTimeStart === null ? null : String(row.storyTimeStart),
      storyTimeEnd: row.storyTimeEnd === null ? null : String(row.storyTimeEnd), confidence: Number(row.confidence), threadKey: row.threadKey === null ? null : String(row.threadKey),
      spanStart: Number(row.spanStart), spanEnd: Number(row.spanEnd), spanText: String(row.spanText), lifecycle: row.lifecycle as MemoryRecord["lifecycle"],
      disputed: Boolean(row.disputed), createdAt: String(row.createdAt), validUntil: row.validUntil === null ? null : String(row.validUntil),
      revealOrder: Number(row.revealOrder),
    };
  }

  private resultForCommitted(submission: SubmissionRecord): ReviewResult {
    const memories = this.listMemories(submission.projectId, { includeRetconned: true }).filter((memory) => memory.sourceVersionId === this.sourceVersionId(submission.id));
    return { submission, candidateIds: this.candidateIds(submission.id), memoryIds: memories.filter((memory) => !memory.validUntil).map((memory) => memory.id), conflicts: [] };
  }

  private sourceVersionId(submissionId: string): string {
    const row = this.db.prepare("SELECT id FROM source_versions WHERE submission_id=?").get(submissionId) as { id: string } | undefined;
    return row?.id ?? "";
  }

  private loadCandidateRows(submissionId: string): CandidateRow[] {
    return this.db.prepare(`SELECT id,kind,scope,subject,predicate,object,perspective,story_time_start AS storyTimeStart,story_time_end AS storyTimeEnd,
        confidence,thread_key AS threadKey,lifecycle,span_start AS spanStart,span_end AS spanEnd,span_text AS spanText,status
      FROM submission_candidates WHERE submission_id=? ORDER BY created_at,id`).all(submissionId) as CandidateRow[];
  }

  private inputFromCandidateRow(row: CandidateRow): MemoryCandidateInput {
    return { kind: row.kind, scope: row.scope, subject: row.subject, predicate: row.predicate, object: row.object, perspective: row.perspective,
      storyTimeStart: row.storyTimeStart, storyTimeEnd: row.storyTimeEnd, confidence: row.confidence, threadKey: row.threadKey, lifecycle: row.lifecycle,
      spanStart: row.spanStart, spanEnd: row.spanEnd, spanText: row.spanText };
  }

  private candidateIds(submissionId: string): string[] {
    return (this.db.prepare("SELECT id FROM submission_candidates WHERE submission_id=? ORDER BY created_at,id").all(submissionId) as Array<{ id: string }>).map((row) => row.id);
  }

  private openConflictCount(projectId: string, submissionId: string): number {
    return Number((this.db.prepare("SELECT count(*) AS count FROM conflicts WHERE project_id=? AND submission_id=? AND status='open'").get(projectId, submissionId) as { count: number }).count);
  }

  private nextRevealOrder(projectId: string): number {
    return Number((this.db.prepare("SELECT coalesce(max(reveal_order),0)+1 AS next FROM submissions WHERE project_id=?").get(projectId) as { next: number }).next);
  }
}
