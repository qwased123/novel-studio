import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { ReviewJobWorker } from "./job-worker.js";
import { MemoryService } from "./memory-service.js";

const waitFor = async (check: () => boolean, timeoutMs = 2000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待 worker 超时");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

describe("ReviewJobWorker", () => {
  it("persists jobs, retries failures, and records the final result", async () => {
    const db = openDatabase(":memory:");
    const memory = new MemoryService(db, { extract: async () => [], verifyConflict: async ({ explanation }) => ({ confirmed: true, explanation }) });
    const project = memory.createProject("worker 测试");
    const content = "林舟位于北城。";
    const submission = memory.createSubmission(project.id, {
      title: "正文", kind: "prose", content,
      candidates: [{ kind: "location_topology", scope: "world_truth", subject: "林舟", predicate: "location", object: "北城", spanStart: 0, spanEnd: 6, spanText: content.slice(0, 6) }],
    });
    let calls = 0;
    const worker = new ReviewJobWorker(db, async (projectId, submissionId) => {
      calls += 1;
      if (calls === 1) throw new Error("temporary worker error");
      const result = await memory.reviewSubmission(projectId, submissionId);
      return { status: result.submission.status, memoryIds: result.memoryIds, conflicts: result.conflicts.length };
    }, { intervalMs: 25, maxAttempts: 3 });
    worker.start();
    try {
      const job = worker.enqueue(project.id, submission.id);
      await waitFor(() => (db.prepare("SELECT count(*) AS count FROM jobs WHERE id=? AND status='succeeded'").get(job.id) as { count: number }).count === 1);
      expect(calls).toBe(2);
      expect((db.prepare("SELECT attempts FROM jobs WHERE id=?").get(job.id) as { attempts: number }).attempts).toBe(2);
      const events = (db.prepare("SELECT event_type AS eventType FROM job_events WHERE job_id=? ORDER BY id").all(job.id) as Array<{ eventType: string }>).map((row) => row.eventType);
      expect(events).toEqual(["review_queued", "review_started", "review_retry_scheduled", "review_started", "review_finished"]);
      expect(memory.listMemories(project.id)).toHaveLength(1);
    } finally {
      worker.stop();
      db.close();
    }
  });
});
