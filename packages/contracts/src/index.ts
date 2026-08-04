import { z } from "zod";

export const projectStatusSchema = z.enum(["planning", "writing", "paused", "completed"]);
export const documentKindSchema = z.enum([
  "premise",
  "synopsis",
  "style_guide",
  "book_outline",
  "volume_outline",
  "chapter_outline",
  "chapter_content",
]);
export const entityTypeSchema = z.enum(["character", "location", "faction", "item", "rule", "concept"]);
export const jobTypeSchema = z.enum([
  "expand_concept",
  "outline_book",
  "outline_volume",
  "outline_chapter",
  "draft_chapter",
  "draft_scene",
  "rewrite_selection",
  "review_consistency",
  "review_plot",
  "review_style",
  "extract_memory",
  "distill_arc",
  "embed_knowledge",
]);
export const jobStatusSchema = z.enum(["queued", "running", "awaiting_input", "succeeded", "failed", "cancelled", "interrupted"]);
export const proposalStatusSchema = z.enum(["pending", "accepted", "rejected", "conflicted"]);

export const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(120),
  genre: z.string().trim().max(80).default(""),
  premise: z.string().trim().max(20_000).default(""),
  targetWords: z.number().int().min(1_000).max(20_000_000).default(1_000_000),
  pov: z.string().trim().max(80).default("第三人称限知"),
  audience: z.string().trim().max(120).default("中文网文读者"),
});

export const saveDocumentSchema = z.object({
  contentJson: z.record(z.string(), z.unknown()),
  plainText: z.string().max(2_000_000),
  html: z.string().max(4_000_000).default(""),
  expectedVersionId: z.string().nullable().optional(),
  message: z.string().max(200).default("人工保存"),
});

export const createEntitySchema = z.object({
  type: entityTypeSchema,
  name: z.string().trim().min(1).max(120),
  summary: z.string().max(10_000).default(""),
  aliases: z.array(z.string().trim().min(1).max(120)).default([]),
  attributes: z.record(z.string(), z.unknown()).default({}),
  visibility: z.enum(["author", "public", "limited"]).default("author"),
});

export const textSelectionSchema = z.object({
  from: z.number().int().min(1),
  to: z.number().int().min(2),
  text: z.string().min(1).max(200_000),
}).refine((selection) => selection.to > selection.from, {
  message: "选区结束位置必须晚于开始位置",
  path: ["to"],
}).refine((selection) => selection.text.trim().length > 0, {
  message: "选区不能只包含空白字符",
  path: ["text"],
});

export const createJobSchema = z.object({
  type: jobTypeSchema,
  projectId: z.string().min(1),
  documentId: z.string().nullable().optional(),
  sceneId: z.string().nullable().optional(),
  instruction: z.string().max(20_000).default(""),
  modelProfile: z.enum(["planner", "writer", "reviewer", "extractor"]).default("writer"),
  selection: textSelectionSchema.nullable().optional(),
  contextOverrides: z.object({
    includeIds: z.array(z.string()).default([]),
    excludeIds: z.array(z.string()).default([]),
  }).default({ includeIds: [], excludeIds: [] }),
});

export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type DocumentKind = z.infer<typeof documentKindSchema>;
export type EntityType = z.infer<typeof entityTypeSchema>;
export type JobType = z.infer<typeof jobTypeSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type SaveDocumentInput = z.infer<typeof saveDocumentSchema>;
export type CreateEntityInput = z.infer<typeof createEntitySchema>;
export type CreateJobInput = z.infer<typeof createJobSchema>;
export type TextSelection = z.infer<typeof textSelectionSchema>;

export interface ProjectSummary {
  id: string;
  title: string;
  genre: string;
  status: ProjectStatus;
  targetWords: number;
  wordCount: number;
  updatedAt: string;
}

export interface TreeScene {
  id: string;
  title: string;
  position: number;
  summary: string;
  goal: string;
  conflict: string;
  outcome: string;
}

export interface TreeChapter {
  id: string;
  title: string;
  position: number;
  status: string;
  wordCount: number;
  documentId: string;
  scenes: TreeScene[];
}

export interface TreeVolume {
  id: string;
  title: string;
  position: number;
  chapters: TreeChapter[];
}

export interface ProjectTree {
  project: ProjectSummary & { premise: string; pov: string; audience: string };
  volumes: TreeVolume[];
}

export interface ContextItem {
  id: string;
  category: "constraint" | "outline" | "continuity" | "entity" | "foreshadow" | "retrieval";
  temperature: "blue" | "green" | "cold";
  title: string;
  excerpt: string;
  sourceVersionId: string | null;
  required: boolean;
  included: boolean;
  estimatedTokens: number;
  reason: string;
}
