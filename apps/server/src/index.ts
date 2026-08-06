import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import {
  createEntitySchema,
  createJobSchema,
  createProjectSchema,
  saveDocumentSchema,
} from "@novel-studio/contracts";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { cancelJob, resumeJobWithDecision, scheduleDrain } from "./ai-runner.js";
import { buildContext } from "./context.js";
import { hasCredential, setCredential } from "./credentials.js";
import { isoNow, newId, parseJson, sqlite } from "./db.js";
import { exportEpub, exportManuscript, exportProjectBundle, importProjectBundle } from "./exporter.js";
import { embeddingStatus, enqueueEmbeddingJob } from "./embeddings.js";
import { replaceSelection, validateSelection } from "./document-content.js";
import { registerModernRoutes } from "./modern-api.js";
import { acceptProposal, scheduleAcceptedProposalWork } from "./proposal-accept.js";
import {
  createChapter,
  createEntity,
  createForeshadow,
  createProject,
  createScene,
  createVolume,
  getDocument,
  getProjectDocuments,
  getProjectTree,
  listEntities,
  listFacts,
  listMemoryConflicts,
  listForeshadows,
  listProjects,
  listVersions,
  restoreVersion,
  saveDocument,
  searchKnowledge,
  updateEntity,
} from "./repository.js";

const app = Fastify({ logger: true, bodyLimit: 50 * 1024 * 1024 });
await app.register(cors, {
  origin: [/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
});

app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

app.setErrorHandler((error, _request, reply) => {
  const caught = error as Error & { code?: string; statusCode?: number };
  const status = caught.code === "VERSION_CONFLICT" ? 409 : (caught.statusCode && caught.statusCode >= 400 ? caught.statusCode : 400);
  reply.status(status).send({ error: caught.message });
});

app.get("/api/health", async () => ({ ok: true, version: "0.1.0" }));
app.get("/api/projects", async () => listProjects());
app.post("/api/projects", async (request, reply) => reply.status(201).send(createProject(createProjectSchema.parse(request.body))));
app.delete<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
  const result = sqlite.prepare("DELETE FROM projects WHERE id=?").run(request.params.projectId);
  if (!result.changes) return reply.status(404).send({ error: "作品不存在" });
  return { ok: true };
});
app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/tree", async (request, reply) => {
  const tree = getProjectTree(request.params.projectId);
  if (!tree) return reply.status(404).send({ error: "作品不存在" });
  return tree;
});
app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/documents", async (request) => getProjectDocuments(request.params.projectId));
app.get<{ Params: { projectId: string }; Querystring: { q?: string } }>("/api/projects/:projectId/search", async (request) => {
  const query = String(request.query.q ?? "").trim();
  return query.length >= 2 ? searchKnowledge(request.params.projectId, query, 20) : [];
});
app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/volumes", async (request, reply) => {
  const body = z.object({ title: z.string().max(120).default("") }).parse(request.body);
  return reply.status(201).send(createVolume(request.params.projectId, body.title));
});
app.post<{ Params: { volumeId: string } }>("/api/volumes/:volumeId/chapters", async (request, reply) => {
  const body = z.object({ title: z.string().max(120).default("") }).parse(request.body);
  return reply.status(201).send(createChapter(request.params.volumeId, body.title));
});
app.post<{ Params: { chapterId: string } }>("/api/chapters/:chapterId/scenes", async (request, reply) => {
  const body = z.object({ title: z.string().max(120).default("") }).parse(request.body);
  return reply.status(201).send(createScene(request.params.chapterId, body.title));
});
app.patch<{ Params: { sceneId: string } }>("/api/scenes/:sceneId", async (request) => {
  const body = z.object({ title: z.string().max(120), summary: z.string().max(20_000), goal: z.string().max(10_000), conflict: z.string().max(10_000), outcome: z.string().max(10_000) }).partial().parse(request.body);
  const current = sqlite.prepare("SELECT * FROM scenes WHERE id=?").get(request.params.sceneId) as Record<string, unknown> | undefined;
  if (!current) throw new Error("场景不存在");
  sqlite.prepare("UPDATE scenes SET title=?,summary=?,goal=?,conflict=?,outcome=?,updated_at=? WHERE id=?")
    .run(body.title ?? current.title, body.summary ?? current.summary, body.goal ?? current.goal, body.conflict ?? current.conflict, body.outcome ?? current.outcome, isoNow(), request.params.sceneId);
  return { ok: true };
});

app.get<{ Params: { documentId: string } }>("/api/documents/:documentId", async (request, reply) => {
  const document = getDocument(request.params.documentId);
  if (!document) return reply.status(404).send({ error: "文档不存在" });
  return document;
});
app.put<{ Params: { documentId: string } }>("/api/documents/:documentId", async (request) => {
  const result = saveDocument(request.params.documentId, saveDocumentSchema.parse(request.body));
  const document = getDocument(request.params.documentId);
  if (document && enqueueEmbeddingJob(String(document.projectId), document.id as string, "document")) scheduleDrain();
  return result;
});
app.get<{ Params: { documentId: string } }>("/api/documents/:documentId/versions", async (request) => listVersions(request.params.documentId));
app.post<{ Params: { documentId: string; versionId: string } }>("/api/documents/:documentId/versions/:versionId/restore", async (request) => restoreVersion(request.params.documentId, request.params.versionId));

app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/entities", async (request) => listEntities(request.params.projectId));
app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/entities", async (request, reply) => {
  const result = createEntity(request.params.projectId, createEntitySchema.parse(request.body));
  if (enqueueEmbeddingJob(request.params.projectId, result.id, "entity")) scheduleDrain();
  return reply.status(201).send(result);
});
app.put<{ Params: { entityId: string } }>("/api/entities/:entityId", async (request) => {
  const entity = sqlite.prepare("SELECT project_id AS projectId FROM entities WHERE id=?").get(request.params.entityId) as { projectId: string } | undefined;
  const result = updateEntity(request.params.entityId, createEntitySchema.parse(request.body));
  if (entity && enqueueEmbeddingJob(entity.projectId, request.params.entityId, "entity")) scheduleDrain();
  return result;
});
app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/facts", async (request) => listFacts(request.params.projectId));
app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/memory-conflicts", async (request) => listMemoryConflicts(request.params.projectId));
app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/embedding-status", async (request) => embeddingStatus(request.params.projectId));
app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/reindex", async (request, reply) => {
  const id = enqueueEmbeddingJob(request.params.projectId);
  if (!id) return reply.status(400).send({ error: "向量模型尚未启用，或当前平台不支持 sqlite-vec" });
  scheduleDrain();
  return reply.status(201).send({ id });
});
app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/foreshadows", async (request) => listForeshadows(request.params.projectId));
app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/foreshadows", async (request, reply) => {
  const input = z.object({ title: z.string().min(1).max(160), detail: z.string().max(20_000).default(""), targetChapterId: z.string().nullable().optional() }).parse(request.body);
  return reply.status(201).send(createForeshadow(request.params.projectId, input));
});

app.get("/api/model-profiles", async () => (sqlite.prepare("SELECT * FROM model_profiles ORDER BY CASE role WHEN 'planner' THEN 1 WHEN 'writer' THEN 2 WHEN 'reviewer' THEN 3 WHEN 'extractor' THEN 4 ELSE 5 END").all() as Record<string, unknown>[]).map((row) => ({
  role: row.role, provider: row.provider, model: row.model, baseUrl: row.base_url, temperature: row.temperature,
  maxOutputTokens: row.max_output_tokens, inputPrice: row.input_price, outputPrice: row.output_price,
  enabled: Boolean(row.enabled), hasApiKey: hasCredential(String(row.role)),
})));
app.put<{ Params: { role: string } }>("/api/model-profiles/:role", async (request) => {
  const body = z.object({
    provider: z.enum(["openai", "anthropic", "openai-compatible"]), model: z.string().max(200), baseUrl: z.string().max(500).default(""),
    temperature: z.number().min(0).max(2), maxOutputTokens: z.number().int().min(256).max(100_000),
    inputPrice: z.number().nullable().optional(), outputPrice: z.number().nullable().optional(), enabled: z.boolean(), apiKey: z.string().max(1000).optional(),
  }).parse(request.body);
  sqlite.prepare(`UPDATE model_profiles SET provider=?,model=?,base_url=?,temperature=?,max_output_tokens=?,input_price=?,output_price=?,enabled=?,updated_at=? WHERE role=?`)
    .run(body.provider, body.model, body.baseUrl, body.temperature, body.maxOutputTokens, body.inputPrice ?? null, body.outputPrice ?? null, body.enabled ? 1 : 0, isoNow(), request.params.role);
  if (body.apiKey !== undefined) setCredential(request.params.role, body.apiKey);
  return { ok: true };
});

app.post("/api/context/preview", async (request) => {
  const input = createJobSchema.parse(request.body);
  if (input.type === "rewrite_selection") {
    if (!input.documentId || !input.selection) throw new Error("请先在已保存的文档中选择要改写的文字");
    const document = getDocument(input.documentId);
    if (!document) throw new Error("文档不存在");
    validateSelection(document.contentJson, input.selection);
  }
  return await buildContext({ ...input, documentId: input.documentId ?? null, sceneId: input.sceneId ?? null, includeIds: input.contextOverrides.includeIds, excludeIds: input.contextOverrides.excludeIds });
});
app.get<{ Querystring: { projectId: string } }>("/api/jobs", async (request) => {
  const rows = sqlite.prepare(`SELECT j.id,j.project_id AS projectId,j.document_id AS documentId,j.scene_id AS sceneId,j.type,j.status,
    j.model_profile AS modelProfile,j.instruction,j.error,j.input_tokens AS inputTokens,j.output_tokens AS outputTokens,
    j.decision_json AS decision,j.created_at AS createdAt,j.started_at AS startedAt,j.finished_at AS finishedAt,
    (SELECT je.type FROM job_events je WHERE je.job_id=j.id AND je.type IN ('memory_query','memory_result') ORDER BY je.id DESC LIMIT 1) AS activityType,
    (SELECT je.payload_json FROM job_events je WHERE je.job_id=j.id AND je.type IN ('memory_query','memory_result') ORDER BY je.id DESC LIMIT 1) AS activity
    FROM ai_jobs j WHERE j.project_id=? ORDER BY j.created_at DESC LIMIT 100`).all(request.query.projectId) as Record<string, unknown>[];
  return rows.map((row) => ({ ...row, decision: parseJson(row.decision, null), activity: row.activityType ? { type: row.activityType, ...parseJson<Record<string, unknown>>(row.activity, {}) } : null }));
});
app.post("/api/jobs", async (request, reply) => {
  const input = createJobSchema.parse(request.body);
  if (input.type === "rewrite_selection") {
    if (!input.documentId || !input.selection) throw new Error("请先在已保存的文档中选择要改写的文字");
    const selectedDocument = getDocument(input.documentId);
    if (!selectedDocument) throw new Error("文档不存在");
    validateSelection(selectedDocument.contentJson, input.selection);
  }
  const context = await buildContext({ ...input, documentId: input.documentId ?? null, sceneId: input.sceneId ?? null, includeIds: input.contextOverrides.includeIds, excludeIds: input.contextOverrides.excludeIds });
  const document = input.documentId ? getDocument(input.documentId) : null;
  const id = newId();
  sqlite.prepare(`INSERT INTO ai_jobs(id,project_id,document_id,scene_id,type,status,model_profile,instruction,selection_json,context_snapshot_json,base_version_id,created_at) VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?)`)
    .run(id, input.projectId, input.documentId ?? null, input.sceneId ?? null, input.type, input.modelProfile, input.instruction, input.selection ? JSON.stringify(input.selection) : null, JSON.stringify(context.includedItems), document?.currentVersionId ?? null, isoNow());
  scheduleDrain();
  return reply.status(201).send({ id });
});
app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/cancel", async (request) => { cancelJob(request.params.jobId); return { ok: true }; });
app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/decision", async (request, reply) => {
  const body = z.object({ decision: z.string().trim().min(1).max(2_000) }).parse(request.body);
  try {
    return reply.status(201).send(resumeJobWithDecision(request.params.jobId, body.decision));
  } catch (error) {
    return reply.status(409).send({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/retry", async (request, reply) => {
  const old = sqlite.prepare("SELECT * FROM ai_jobs WHERE id=?").get(request.params.jobId) as Record<string, unknown> | undefined;
  if (!old) return reply.status(404).send({ error: "任务不存在" });
  const id = newId();
  sqlite.prepare(`INSERT INTO ai_jobs(id,project_id,document_id,scene_id,type,status,model_profile,instruction,selection_json,context_snapshot_json,base_version_id,retry_of_job_id,created_at) VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?,?)`)
    .run(id, old.project_id, old.document_id, old.scene_id, old.type, old.model_profile, old.instruction, old.selection_json, old.context_snapshot_json, old.base_version_id, old.id, isoNow());
  scheduleDrain();
  return reply.status(201).send({ id });
});
app.get<{ Params: { jobId: string }; Querystring: { after?: string } }>("/api/jobs/:jobId/events", async (request, reply) => {
  const after = Number(request.query.after ?? 0);
  const rows = sqlite.prepare("SELECT id,type,payload_json AS payload,created_at AS createdAt FROM job_events WHERE job_id=? AND id>? ORDER BY id").all(request.params.jobId, after) as Record<string, unknown>[];
  return rows.map((row) => ({ ...row, payload: parseJson(row.payload, {}) }));
});

app.get<{ Querystring: { projectId: string } }>("/api/proposals", async (request) => (sqlite.prepare("SELECT * FROM proposals WHERE project_id=? ORDER BY created_at DESC LIMIT 100").all(request.query.projectId) as Record<string, unknown>[]).map((row) => ({
  id: row.id, jobId: row.job_id, targetType: row.target_type, targetId: row.target_id, baseVersionId: row.base_version_id,
  status: row.status, title: row.title, payload: parseJson(row.payload_json, {}), createdAt: row.created_at,
})));
app.post<{ Params: { proposalId: string } }>("/api/proposals/:proposalId/accept", async (request, reply) => {
  const outcome = acceptProposal(request.params.proposalId);
  if (outcome.kind === "not_found") return reply.status(404).send({ error: outcome.error });
  if (outcome.kind === "conflict") return reply.status(409).send({ error: outcome.error });
  try {
    await scheduleAcceptedProposalWork(outcome);
  } catch (error) {
    app.log.error({ error, proposalId: request.params.proposalId }, "接受提案后的后台任务调度失败");
  }
  return { ok: true };
});
app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/arc-summaries", async (request) => {
  const rows = sqlite.prepare(`SELECT a.id,a.summary,a.open_threads_json AS openThreads,a.stale,a.created_at AS createdAt,
    sc.title AS startChapter,ec.title AS endChapter
    FROM arc_summaries a JOIN chapters sc ON sc.id=a.start_chapter_id JOIN chapters ec ON ec.id=a.end_chapter_id
    WHERE a.project_id=? ORDER BY a.created_at DESC`).all(request.params.projectId) as Record<string, unknown>[];
  return rows.map((row) => ({ ...row, openThreads: parseJson(row.openThreads, []) }));
});
app.post<{ Params: { proposalId: string } }>("/api/proposals/:proposalId/reject", async (request) => {
  sqlite.prepare("UPDATE proposals SET status='rejected',decided_at=? WHERE id=? AND status='pending'").run(isoNow(), request.params.proposalId);
  return { ok: true };
});
app.get<{ Querystring: { projectId: string } }>("/api/review-findings", async (request) => sqlite.prepare(`SELECT id,job_id AS jobId,document_id AS documentId,category,severity,title,evidence,suggestion,status,created_at AS createdAt FROM review_findings WHERE project_id=? ORDER BY created_at DESC`).all(request.query.projectId));
app.patch<{ Params: { findingId: string } }>("/api/review-findings/:findingId", async (request) => {
  const body = z.object({ status: z.enum(["open", "resolved", "dismissed"]) }).parse(request.body);
  sqlite.prepare("UPDATE review_findings SET status=? WHERE id=?").run(body.status, request.params.findingId);
  return { ok: true };
});
app.patch<{ Params: { conflictId: string } }>("/api/memory-conflicts/:conflictId", async (request) => {
  const body = z.object({ status: z.enum(["resolved", "dismissed"]) }).parse(request.body);
  sqlite.prepare("UPDATE memory_conflicts SET status=?,resolved_at=? WHERE id=? AND status='open'").run(body.status, isoNow(), request.params.conflictId);
  return { ok: true };
});

await registerModernRoutes(app);

app.get<{ Params: { projectId: string; format: string } }>("/api/projects/:projectId/export/:format", async (request, reply) => {
  const project = getProjectTree(request.params.projectId)?.project;
  if (!project) return reply.status(404).send({ error: "作品不存在" });
  const format = request.params.format;
  const buffer = format === "epub" ? await exportEpub(request.params.projectId) : exportManuscript(request.params.projectId, format === "md" ? "md" : "txt");
  reply.header("Content-Type", format === "epub" ? "application/epub+zip" : "text/plain; charset=utf-8");
  reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(String(project.title))}.${format}`);
  return reply.send(buffer);
});
app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/backup", async (request, reply) => {
  const buffer = await exportProjectBundle(request.params.projectId);
  reply.header("Content-Type", "application/octet-stream").header("Content-Disposition", "attachment; filename=project.novelstudio");
  return reply.send(buffer);
});
app.post("/api/projects/import", async (request, reply) => reply.status(201).send(await importProjectBundle(request.body as Buffer)));

const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, "../../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.status(404).send({ error: "接口不存在" }) : reply.sendFile("index.html"));
}

const port = Number(process.env.PORT ?? 8787);
await app.listen({ host: "127.0.0.1", port });
scheduleDrain();
