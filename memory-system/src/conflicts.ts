import type { MemoryDatabase } from "./database.js";
import { normalizeName } from "./ids.js";
import type { ConflictSeverity, EpistemicScope, MemoryCandidateInput } from "./types.js";

export interface ExistingComparable {
  id: string;
  kind: string;
  scope: EpistemicScope;
  subject: string;
  predicate: string;
  object: string;
  perspective: string | null;
  storyTimeStart: string | null;
  storyTimeEnd: string | null;
  threadKey: string | null;
  lifecycle: string;
  spanText: string;
  sourceTitle: string;
}

export interface ConflictProposal {
  existing: ExistingComparable;
  severity: ConflictSeverity;
  category: "fact" | "time" | "state" | "rule" | "space" | "epistemic" | "foreshadowing" | "plan_drift";
  impactKey: string;
  explanation: string;
}

const functionalPredicates = new Set([
  "is", "name", "age", "alive", "dead", "gender", "eye_color", "hair_color", "location", "current_location",
  "holds_item", "owner", "leader", "parent", "birthplace", "world_rule", "status",
]);

const overlap = (aStart: string | null | undefined, aEnd: string | null | undefined, bStart: string | null, bEnd: string | null) => {
  if (!aStart && !aEnd || !bStart && !bEnd) return true;
  const as = aStart ?? aEnd ?? ""; const ae = aEnd ?? aStart ?? "\uffff";
  const bs = bStart ?? bEnd ?? ""; const be = bEnd ?? bStart ?? "\uffff";
  return as <= be && bs <= ae;
};

export const impactKeyFor = (candidate: Pick<MemoryCandidateInput, "subject" | "predicate" | "scope" | "perspective" | "threadKey">) =>
  [normalizeName(candidate.subject), normalizeName(candidate.predicate), candidate.scope, normalizeName(candidate.perspective ?? ""), normalizeName(candidate.threadKey ?? "")].join("|");

export function findConflicts(db: MemoryDatabase, projectId: string, candidate: MemoryCandidateInput): ConflictProposal[] {
  const rows = db.prepare(`SELECT m.id,m.kind,m.scope,m.subject,m.predicate,m.object,m.perspective,
      m.story_time_start AS storyTimeStart,m.story_time_end AS storyTimeEnd,m.thread_key AS threadKey,
      m.lifecycle,m.span_text AS spanText,sv.title AS sourceTitle
    FROM memories m JOIN source_versions sv ON sv.id=m.source_version_id
    WHERE m.project_id=? AND m.valid_until IS NULL AND m.disputed=0
      AND (lower(m.subject)=lower(?) OR (m.thread_key IS NOT NULL AND m.thread_key=?))`)
    .all(projectId, candidate.subject.trim(), candidate.threadKey ?? "") as ExistingComparable[];
  const output: ConflictProposal[] = [];
  for (const existing of rows) {
    const samePredicate = normalizeName(existing.predicate) === normalizeName(candidate.predicate);
    const samePerspective = normalizeName(existing.perspective ?? "") === normalizeName(candidate.perspective ?? "");
    const sameObject = normalizeName(existing.object) === normalizeName(candidate.object);
    if (sameObject || !overlap(candidate.storyTimeStart, candidate.storyTimeEnd, existing.storyTimeStart, existing.storyTimeEnd)) continue;

    const impactKey = impactKeyFor(candidate);
    if (existing.scope === candidate.scope && samePerspective && samePredicate) {
      const predicate = normalizeName(candidate.predicate);
      const category = candidate.kind === "world_rule" ? "rule" : candidate.kind === "location_topology" ? "space" : candidate.kind === "foreshadowing" ? "foreshadowing" : candidate.kind === "state_change" ? "state" : "fact";
      output.push({ existing, severity: functionalPredicates.has(predicate) || category === "rule" ? "definite_conflict" : "needs_explanation", category, impactKey,
        explanation: `同一认知域和有效时间内，“${candidate.subject} ${candidate.predicate} ${candidate.object}”与既有“${existing.subject} ${existing.predicate} ${existing.object}”不相容。` });
      continue;
    }
    if (samePredicate && existing.scope === "author_plan" && candidate.scope === "world_truth") {
      output.push({ existing, severity: "needs_explanation", category: "plan_drift", impactKey,
        explanation: `新正文事实“${candidate.object}”偏离作者计划“${existing.object}”，需要用户确认是否改线。` });
    }
    if (candidate.kind === "foreshadowing" && existing.kind === "foreshadowing" && candidate.threadKey && candidate.threadKey === existing.threadKey && existing.lifecycle !== candidate.lifecycle) {
      const validProgression = ["planned", "seeded", "reinforced", "resolved", "abandoned"].indexOf(candidate.lifecycle ?? "active") >= ["planned", "seeded", "reinforced", "resolved", "abandoned"].indexOf(existing.lifecycle);
      if (!validProgression) output.push({ existing, severity: "definite_conflict", category: "foreshadowing", impactKey, explanation: `伏笔“${candidate.threadKey}”的生命周期发生逆行。` });
    }
  }
  return output;
}
