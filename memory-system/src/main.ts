import cors from "@fastify/cors";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { openDatabase, type MemoryDatabase } from "./database.js";
import { newId, nowIso } from "./ids.js";
import { MemoryService, type ConflictResolutionInput } from "./memory-service.js";
import { OpenAiCompatibleModels } from "./models.js";
import { ReviewJobWorker } from "./job-worker.js";
import { RetrievalService } from "./retrieval.js";
import { APP_VERSION } from "./version.js";

import type { ContextRequest } from "./types.js";

type JsonObject = Record<string, unknown>;

export interface ServerContext {
  app: FastifyInstance;
  db: MemoryDatabase;
  memory: MemoryService;
  retrieval: RetrievalService;
  worker: ReviewJobWorker;
}

const contextRequestOf = (body: JsonObject): ContextRequest => {
  const intent = body.intent;
  const intents = ["current_state", "scene_generation", "timeline", "causal", "foreshadowing", "evidence", "summary"] as const;
  if (typeof intent !== "string" || !intents.includes(intent as typeof intents[number])) throw new Error("intent 非法");
  const instruction = requiredString(body, "instruction");
  const tokenBudget = body.tokenBudget;
  if (typeof tokenBudget !== "number" || !Number.isInteger(tokenBudget) || tokenBudget <= 0) throw new Error("tokenBudget 必须是正整数");
  const optionalString = (key: string) => {
    const value = body[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new Error(`${key} 必须是字符串`);
    return value;
  };
  const mentionedEntities = body.mentionedEntities;
  if (mentionedEntities !== undefined && (!Array.isArray(mentionedEntities) || mentionedEntities.some((value) => typeof value !== "string"))) {
    throw new Error("mentionedEntities 必须是字符串数组");
  }
  return {
    intent: intent as ContextRequest["intent"], instruction, tokenBudget,
    chapter: optionalString("chapter"), scene: optionalString("scene"), pov: optionalString("pov"),
    storyTime: optionalString("storyTime"), location: optionalString("location"),
    recentText: body.recentText === undefined ? undefined : requiredString(body, "recentText"),
    mentionedEntities: mentionedEntities as string[] | undefined,
  };
};

const optionalPositiveInteger = (value: string | undefined, key: string) => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${key} 必须是正整数`);
  return parsed;
};

const objectBody = (request: FastifyRequest): JsonObject => {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求 body 必须是 JSON 对象");
  return body as JsonObject;
};

const paramsOf = (request: FastifyRequest) => {
  const raw = request.params as Record<string, string | undefined>;
  return {
    projectId: raw.projectId ?? "",
    submissionId: raw.submissionId ?? "",
    conflictId: raw.conflictId ?? "",
    jobId: raw.jobId ?? "",
    role: raw.role ?? "",
    traceId: raw.traceId ?? "",
  };
};

const requiredString = (body: JsonObject, key: string) => {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} 必须是非空字符串`);
  return value;
};

const writeJobEvent = (db: MemoryDatabase, jobId: string, projectId: string, eventType: string, payload: unknown) => {
  db.prepare("INSERT INTO job_events(job_id,project_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?)")
    .run(jobId, projectId, eventType, JSON.stringify(payload), new Date().toISOString());
};

const sendError = (reply: FastifyReply, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode = /不存在|不属于项目|非法|不能为空|必须|已经处理|正在审查|不能再次|正整数|字符串数组|范围|缺少|Base URL|temperature|maxOutputTokens|HTTP\(S\)/.test(message) ? 400 : 500;
  return reply.code(statusCode).send({ error: message });
};

export function buildServer(db = openDatabase()): ServerContext {
  const app = fastify({ logger: false });
  const models = new OpenAiCompatibleModels(db);
  const memory = new MemoryService(db, models);
  const retrieval = new RetrievalService(db, models);
  const worker = new ReviewJobWorker(db, async (projectId, submissionId) => {
    const result = await memory.reviewSubmission(projectId, submissionId);
    return { status: result.submission.status, memoryIds: result.memoryIds, conflicts: result.conflicts.length };
  });
  worker.start();
  app.register(cors, { origin: true });
  const staticRoot = resolve(process.cwd(), "dist-web");
  if (existsSync(staticRoot)) app.register(fastifyStatic, { root: staticRoot, prefix: "/" });

  app.get("/api/health", async () => ({ ok: true, version: APP_VERSION }));

  app.get("/api/models/:role", async (request, reply) => {
    try {
      const role = paramsOf(request).role;
      if (role !== "extractor" && role !== "verifier" && role !== "embedding") throw new Error("模型角色非法");
      return reply.send(models.getConfig(role));
    } catch (error) { return sendError(reply, error); }
  });

  app.put("/api/models/:role", async (request, reply) => {
    try {
      const role = paramsOf(request).role;
      if (role !== "extractor" && role !== "verifier" && role !== "embedding") throw new Error("模型角色非法");
      const body = objectBody(request);
      const temperature = typeof body.temperature === "number" ? body.temperature : 0;
      const maxOutputTokens = typeof body.maxOutputTokens === "number" ? body.maxOutputTokens : 4096;
      return reply.send(models.saveConfig({ role, baseUrl: requiredString(body, "baseUrl"), model: requiredString(body, "model"), temperature, maxOutputTokens, enabled: body.enabled === true }));
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/models/metrics/summary", async (_request, reply) => {
    try { return reply.send(models.getMetricSummary()); }
    catch (error) { return sendError(reply, error); }
  });

  app.get("/api/models/metrics/requests", async (request, reply) => {
    try {
      const query = request.query as Record<string, string | undefined>;
      const role = query.role === "extractor" || query.role === "verifier" || query.role === "embedding" ? query.role : undefined;
      const operation = query.operation === "chat" || query.operation === "embedding" ? query.operation : undefined;
      const limit = optionalPositiveInteger(query.limit, "limit");
      return reply.send(models.listMetrics({ role, operation, limit }));
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/projects", async (_request, reply) => {
    try {
      return reply.send(db.prepare("SELECT id,name,series_key AS seriesKey,created_at AS createdAt,updated_at AS updatedAt FROM projects ORDER BY updated_at DESC").all());
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/projects", async (request, reply) => {
    try {
      const body = objectBody(request);
      return reply.code(201).send(memory.createProject(requiredString(body, "name"), typeof body.seriesKey === "string" ? body.seriesKey : "standalone"));
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/projects/:projectId/submissions", async (request, reply) => {
    try {
      const query = request.query as Record<string, string | undefined>;
      const status = query.status;
      if (status !== undefined && !["draft", "reviewing", "blocked", "committed", "failed", "rejected"].includes(status)) throw new Error("status 非法");
      return reply.send(memory.listSubmissions(paramsOf(request).projectId, { status: status as never, limit: optionalPositiveInteger(query.limit, "limit") }));
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/projects/:projectId/submissions/:submissionId", async (request, reply) => {
    try { return reply.send(memory.getSubmission(paramsOf(request).projectId, paramsOf(request).submissionId)); }
    catch (error) { return sendError(reply, error); }
  });

  app.post("/api/projects/:projectId/submissions", async (request, reply) => {
    try {
      const params = paramsOf(request);
      const body = objectBody(request);
      const kind = body.kind;
      if (kind !== "setting" && kind !== "prose" && kind !== "outline") throw new Error("kind 必须是 setting、prose 或 outline");
      return reply.code(201).send(memory.createSubmission(params.projectId, {
        title: requiredString(body, "title"), kind, content: requiredString(body, "content"),
        chapter: typeof body.chapter === "string" ? body.chapter : null,
        scene: typeof body.scene === "string" ? body.scene : null,
        storyTime: typeof body.storyTime === "string" ? body.storyTime : null,
        revealOrder: typeof body.revealOrder === "number" ? body.revealOrder : undefined,
        candidates: Array.isArray(body.candidates) ? body.candidates as never : undefined,
      }));
    } catch (error) { return sendError(reply, error); }
  });

  const runReviewJob = async (jobId: string, projectId: string, submissionId: string) => {
    memory.getSubmission(projectId, submissionId);
    const timestamp = nowIso();
    db.prepare(`INSERT INTO jobs(id,project_id,submission_id,job_type,status,attempts,max_attempts,available_at,locked_at,last_error,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(jobId, projectId, submissionId, "review", "running", 1, 1, timestamp, timestamp, null, timestamp, timestamp);
    writeJobEvent(db, jobId, projectId, "review_queued", { submissionId, synchronous: true });
    writeJobEvent(db, jobId, projectId, "review_started", { submissionId });
    try {
      const result = await memory.reviewSubmission(projectId, submissionId);
      db.prepare("UPDATE jobs SET status='succeeded',locked_at=NULL,updated_at=? WHERE id=?").run(nowIso(), jobId);
      writeJobEvent(db, jobId, projectId, "review_finished", { status: result.submission.status, memoryIds: result.memoryIds, conflicts: result.conflicts.length });
      return result;
    } catch (error) {
      db.prepare("UPDATE jobs SET status='failed',locked_at=NULL,last_error=?,updated_at=? WHERE id=?")
        .run(error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000), nowIso(), jobId);
      writeJobEvent(db, jobId, projectId, "review_failed", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };

  const reviewHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = paramsOf(request);
    const jobId = newId();
    try {
      const query = request.query as Record<string, string | undefined>;
      if (query.async === "true") {
        const queued = worker.enqueue(params.projectId, params.submissionId);
        return reply.code(202).send({ jobId: queued.id, submissionId: params.submissionId, status: queued.status, reused: queued.reused });
      }
      return reply.send({ jobId, ...(await runReviewJob(jobId, params.projectId, params.submissionId)) });
    } catch (error) {
      return sendError(reply, error);
    }
  };
  app.post("/api/projects/:projectId/submissions/:submissionId/review", reviewHandler);
  app.post("/api/submissions/:submissionId/review", async (request, reply) => {
    try {
      const params = paramsOf(request);
      const body = objectBody(request);
      const projectId = requiredString(body, "projectId");
      return reviewHandler({ ...request, params: { projectId, submissionId: params.submissionId } } as FastifyRequest, reply);
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/projects/:projectId/conflicts", async (request, reply) => {
    try {
      const params = paramsOf(request);
      const query = request.query as Record<string, string | undefined>;
      const status = query.status === "open" || query.status === "resolved" || query.status === "dismissed" ? query.status : undefined;
      return reply.send(memory.listConflicts(params.projectId, { submissionId: query.submissionId, status }));
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/projects/:projectId/conflicts/:conflictId/resolve", async (request, reply) => {
    try {
      const params = paramsOf(request);
      const body = objectBody(request);
      const action = body.action;
      if (action !== "intentional_coexist" && action !== "reclassify" && action !== "retcon_existing" && action !== "reject_submission") throw new Error("action 非法");
      const input: ConflictResolutionInput = { action, note: requiredString(body, "note"), payload: body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : undefined };
      return reply.send(memory.resolveConflict(params.projectId, params.conflictId, input));
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/projects/:projectId/memories", async (request, reply) => {
    try {
      const params = paramsOf(request);
      const query = request.query as Record<string, string | undefined>;
      return reply.send(memory.listMemories(params.projectId, { subject: query.subject, scope: query.scope as never, includeRetconned: query.includeRetconned === "true" }));
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/projects/:projectId/context", async (request, reply) => {
    try {
      const params = paramsOf(request);
      const body = objectBody(request);
      return reply.send(await retrieval.compileContext(params.projectId, contextRequestOf(body)));
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/projects/:projectId/embeddings/index", async (request, reply) => {
    try {
      const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as JsonObject : {};
      const memoryIds = Array.isArray(body.memoryIds) && body.memoryIds.every((value) => typeof value === "string") ? body.memoryIds as string[] : undefined;
      return reply.send(await retrieval.indexEmbeddings(paramsOf(request).projectId, memoryIds));
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/projects/:projectId/traces/:traceId", async (request, reply) => {
    try {
      const params = paramsOf(request);
      const row = db.prepare(`SELECT id,project_id AS projectId,request_json AS request,candidates_json AS candidates,selected_json AS selected,
          omitted_json AS omitted,token_budget AS tokenBudget,token_used AS tokenUsed,created_at AS createdAt
        FROM retrieval_traces WHERE id=? AND project_id=?`).get(params.traceId, params.projectId) as Record<string, unknown> | undefined;
      if (!row) throw new Error("检索 trace 不存在或不属于项目");
      for (const key of ["request", "candidates", "selected", "omitted"]) row[key] = JSON.parse(String(row[key]));
      return reply.send(row);
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/projects/:projectId/audit", async (request, reply) => {
    try {
      const query = request.query as Record<string, string | undefined>;
      const impactKeys = query.impactKey?.split(",").map((key) => key.trim()).filter(Boolean);
      return reply.send(memory.auditProject(paramsOf(request).projectId, { impactKeys }));
    }
    catch (error) { return sendError(reply, error); }
  });

  app.get("/api/jobs/:jobId/events", async (request, reply) => {
    const jobId = paramsOf(request).jobId;
    const job = db.prepare("SELECT id FROM jobs WHERE id=?").get(jobId) as { id: string } | undefined;
    if (!job) return reply.code(404).send({ error: "job 不存在" });
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    let lastId = 0;
    let closed = false;
    const flush = () => {
      if (closed) return;
      const rows = db.prepare(`SELECT id,event_type AS eventType,payload_json AS payload,created_at AS createdAt FROM job_events WHERE job_id=? AND id>? ORDER BY id`).all(jobId, lastId) as Array<{ id: number; eventType: string; payload: string; createdAt: string }>;
      for (const row of rows) {
        lastId = row.id;
        response.write(`id: ${row.id}\nevent: ${row.eventType}\ndata: ${JSON.stringify({ ...JSON.parse(row.payload), createdAt: row.createdAt })}\n\n`);
      }
      if (rows.some((row) => row.eventType === "review_finished" || row.eventType === "review_failed")) {
        response.write("event: close\ndata: {}\n\n");
        clearInterval(timer);
        response.end();
      }
    };
    const timer = setInterval(flush, 250);
    request.raw.on("close", () => { closed = true; clearInterval(timer); });
    flush();
  });

  app.get("/api/projects/:projectId/jobs/:jobId", async (request, reply) => {
    try { return reply.send(worker.getJob(paramsOf(request).projectId, paramsOf(request).jobId)); }
    catch (error) { return sendError(reply, error); }
  });

  app.addHook("onClose", async () => { worker.stop(); if (db.open) db.close(); });
  return { app, db, memory, retrieval, worker };
}

export async function startServer() {
  const context = buildServer();
  const port = Number(process.env.MEMORY_PORT ?? 8790);
  const host = process.env.MEMORY_HOST ?? "127.0.0.1";
  await context.app.listen({ port, host });
  return context;
}

const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) void startServer();
