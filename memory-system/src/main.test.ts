import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { buildServer } from "./main.js";

describe("HTTP API", () => {
  it("creates, reviews, and retrieves a project through Fastify", async () => {
    const context = buildServer(openDatabase(":memory:"));
    try {
      const health = await context.app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true, version: "0.0.1" });

      const projectResponse = await context.app.inject({ method: "POST", url: "/api/projects", payload: { name: "API 测试" } });
      expect(projectResponse.statusCode).toBe(201);
      const project = projectResponse.json() as { id: string };
      const content = "林舟位于北城。";
      const submissionResponse = await context.app.inject({
        method: "POST", url: `/api/projects/${project.id}/submissions`,
        payload: { title: "第一章", kind: "prose", content, candidates: [{ kind: "location_topology", scope: "world_truth", subject: "林舟", predicate: "location", object: "北城", spanStart: 0, spanEnd: 6, spanText: content.slice(0, 6) }] },
      });
      expect(submissionResponse.statusCode).toBe(201);
      const submission = submissionResponse.json() as { id: string };
      const review = await context.app.inject({ method: "POST", url: `/api/projects/${project.id}/submissions/${submission.id}/review`, payload: {} });
      expect(review.statusCode).toBe(200);
      expect(review.json().submission.status).toBe("committed");
      const syncJobId = (review.json() as { jobId: string }).jobId;
      const syncJob = await context.app.inject({ method: "GET", url: `/api/projects/${project.id}/jobs/${syncJobId}` });
      expect(syncJob.statusCode).toBe(200);
      expect(syncJob.json()).toMatchObject({ id: syncJobId, status: "succeeded", attempts: 1 });

      const memories = await context.app.inject({ method: "GET", url: `/api/projects/${project.id}/memories` });
      expect(memories.statusCode).toBe(200);
      expect(memories.json()).toHaveLength(1);

      const submissions = await context.app.inject({ method: "GET", url: `/api/projects/${project.id}/submissions?status=committed` });
      expect(submissions.statusCode).toBe(200);
      expect(submissions.json()).toHaveLength(1);
      expect(submissions.json()[0]).toMatchObject({ id: submission.id, status: "committed" });

      const invalidContext = await context.app.inject({ method: "POST", url: `/api/projects/${project.id}/context`, payload: { intent: "scene_generation", instruction: "测试", tokenBudget: 0 } });
      expect(invalidContext.statusCode).toBe(400);

      const missingSubmission = await context.app.inject({ method: "POST", url: `/api/projects/${project.id}/submissions/missing/review`, payload: {} });
      expect(missingSubmission.statusCode).toBe(400);
      const missingEvents = await context.app.inject({ method: "GET", url: "/api/jobs/missing/events" });
      expect(missingEvents.statusCode).toBe(404);

      const config = await context.app.inject({ method: "GET", url: "/api/models/extractor" });
      expect(config.statusCode).toBe(200);
      expect(config.json()).toMatchObject({ role: "extractor", enabled: false });

      const secondContent = "林舟持有旧钥匙。";
      const secondSubmissionResponse = await context.app.inject({
        method: "POST", url: `/api/projects/${project.id}/submissions`,
        payload: { title: "第二章", kind: "prose", content: secondContent, candidates: [{ kind: "state_change", scope: "world_truth", subject: "林舟", predicate: "holds_item", object: "旧钥匙", spanStart: 0, spanEnd: 8, spanText: secondContent.slice(0, 8) }] },
      });
      const secondSubmission = secondSubmissionResponse.json() as { id: string };
      const queued = await context.app.inject({ method: "POST", url: `/api/projects/${project.id}/submissions/${secondSubmission.id}/review?async=true`, payload: {} });
      expect(queued.statusCode).toBe(202);
      const jobId = (queued.json() as { jobId: string }).jobId;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const done = (context.db.prepare("SELECT count(*) AS count FROM job_events WHERE job_id=? AND event_type='review_finished'").get(jobId) as { count: number }).count;
        if (done > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((context.db.prepare("SELECT count(*) AS count FROM job_events WHERE job_id=? AND event_type='review_finished'").get(jobId) as { count: number }).count).toBe(1);
    } finally {
      await context.app.close();
    }
  });
});
