export const SOURCE_KINDS = ["setting", "prose", "outline"] as const;
export const MEMORY_KINDS = [
  "entity", "attribute", "relationship", "event", "state_change", "world_rule",
  "location_topology", "causal_link", "foreshadowing", "plan_goal", "theme", "style_constraint",
] as const;
export const EPISTEMIC_SCOPES = ["world_truth", "character_belief", "rumor_or_lie", "narrator_claim", "author_plan"] as const;
export const SUBMISSION_STATUSES = ["draft", "reviewing", "blocked", "committed", "failed", "rejected"] as const;
export const CONFLICT_SEVERITIES = ["definite_conflict", "needs_explanation"] as const;

export type SourceKind = typeof SOURCE_KINDS[number];
export type MemoryKind = typeof MEMORY_KINDS[number];
export type EpistemicScope = typeof EPISTEMIC_SCOPES[number];
export type SubmissionStatus = typeof SUBMISSION_STATUSES[number];
export type ConflictSeverity = typeof CONFLICT_SEVERITIES[number];

export interface EvidenceInput {
  spanStart: number;
  spanEnd: number;
  spanText: string;
}

export interface MemoryCandidateInput extends EvidenceInput {
  kind: MemoryKind;
  scope: EpistemicScope;
  subject: string;
  predicate: string;
  object: string;
  perspective?: string | null;
  storyTimeStart?: string | null;
  storyTimeEnd?: string | null;
  confidence?: number;
  threadKey?: string | null;
  lifecycle?: "active" | "planned" | "seeded" | "reinforced" | "resolved" | "abandoned";
}

export interface SubmissionInput {
  title: string;
  kind: SourceKind;
  content: string;
  chapter?: string | null;
  scene?: string | null;
  storyTime?: string | null;
  revealOrder?: number;
  candidates?: MemoryCandidateInput[];
}

export interface MemoryRecord extends Omit<MemoryCandidateInput, "lifecycle"> {
  id: string;
  projectId: string;
  sourceVersionId: string;
  sourceTitle: string;
  lifecycle: "active" | "planned" | "seeded" | "reinforced" | "resolved" | "abandoned" | "superseded" | "retracted";
  confidence: number;
  revealOrder: number;
  disputed: boolean;
  createdAt: string;
  validUntil: string | null;
}

export interface ConflictRecord {
  id: string;
  projectId: string;
  submissionId: string | null;
  candidateId: string | null;
  existingMemoryId: string | null;
  laterMemoryId: string | null;
  severity: ConflictSeverity;
  category: "fact" | "time" | "state" | "rule" | "space" | "epistemic" | "foreshadowing" | "plan_drift";
  impactKey: string;
  explanation: string;
  status: "open" | "resolved" | "dismissed";
  resolutionAction: string | null;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ContextRequest {
  intent: "current_state" | "scene_generation" | "timeline" | "causal" | "foreshadowing" | "evidence" | "summary";
  instruction: string;
  chapter?: string | null;
  scene?: string | null;
  pov?: string | null;
  storyTime?: string | null;
  location?: string | null;
  recentText?: string;
  mentionedEntities?: string[];
  tokenBudget: number;
}

export interface ContextItem {
  memoryId: string;
  text: string;
  score: number;
  sourceTitle: string;
  spanStart: number;
  spanEnd: number;
  quote: string;
  scope: EpistemicScope;
  kind: MemoryKind;
  disputed: boolean;
}

export interface ContextPack {
  hardConstraints: ContextItem[];
  worldState: ContextItem[];
  povKnowledge: ContextItem[];
  readerRevealed: ContextItem[];
  relevantHistory: ContextItem[];
  openCommitments: ContextItem[];
  planDrift: ContextItem[];
  disputes: ContextItem[];
  tokenBudget: number;
  tokenUsed: number;
  omitted: Array<{ memoryId: string; reason: string }>;
  insufficientEvidence: string[];
  traceId: string;
}

export interface ModelConfig {
  role: "extractor" | "verifier" | "embedding";
  baseUrl: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  enabled: boolean;
}
