import type { MemoryDatabase } from "./database.js";
import { newId, nowIso } from "./ids.js";

export interface ReviewJobResult {
  status: string;
  memoryIds: string[];
  conflicts: number;
}

export interface ReviewJobWorkerOptions {
  intervalMs?: number;
  maxAttempts?: number;
}

interface JobRow {
  id: string;
  projectId: string;
  submissionId: string;
  attempts: number;
  maxAttempts: number;
}

export class ReviewJobWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  private stopped = true;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly db: MemoryDatabase,
    private readonly processReview: (projectId: string, submissionId: string) => Promise<ReviewJobResult>,
    options: ReviewJobWorkerOptions = {},
  ) {
    this.intervalMs = Math.max(25, options.intervalMs ?? 100);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.recoverStaleJobs();
    this.timer = setInterval(() => { void this.pump(); }, this.intervalMs);
    void this.pump();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  enqueue(projectId: string, submissionId: string): { id: string; status: "queued" | "running"; reused: boolean } {
    const submission = this.db.prepare("SELECT id FROM submissions WHERE id=? AND project_id=?").get(submissionId, projectId) as { id: string } | undefined;
    if (!submission) throw new Error("提交不存在或不属于项目");
    const existing = this.db.prepare(`SELECT id,status FROM jobs WHERE project_id=? AND submission_id=?
      AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`).get(projectId, submissionId) as { id: string; status: "queued" | "running" } | undefined;
    if (existing) return { ...existing, reused: true };
    const id = newId();
    const timestamp = nowIso();
    this.db.prepare(`INSERT INTO jobs(id,project_id,submission_id,job_type,status,attempts,max_attempts,available_at,locked_at,last_error,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, submissionId, "review", "queued", 0, this.maxAttempts, timestamp, null, null, timestamp, timestamp);
    this.writeEvent(id, projectId, "review_queued", { submissionId });
    void this.pump();
    return { id, status: "queued", reused: false };
  }

  getJob(projectId: string, jobId: string) {
    const row = this.db.prepare(`SELECT id,project_id AS projectId,submission_id AS submissionId,job_type AS jobType,status,attempts,
        max_attempts AS maxAttempts,available_at AS availableAt,locked_at AS lockedAt,last_error AS lastError,created_at AS createdAt,updated_at AS updatedAt
      FROM jobs WHERE id=? AND project_id=?`).get(jobId, projectId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("job 不存在或不属于项目");
    return row;
  }

  private recoverStaleJobs() {
    const timestamp = nowIso();
    this.db.prepare(`UPDATE jobs SET status='queued',locked_at=NULL,available_at=?,updated_at=?
      WHERE status='running'`).run(timestamp, timestamp);
  }

  private async pump() {
    if (this.stopped || this.pumping) return;
    this.pumping = true;
    try {
      const job = this.claimNext();
      if (job) await this.run(job);
    } finally {
      this.pumping = false;
    }
  }

  private claimNext(): JobRow | null {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id,project_id AS projectId,submission_id AS submissionId,attempts,max_attempts AS maxAttempts
        FROM jobs WHERE status='queued' AND available_at<=? ORDER BY created_at,id LIMIT 1`).get(nowIso()) as JobRow | undefined;
      if (!row) return null;
      const updatedAt = nowIso();
      this.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,locked_at=?,updated_at=? WHERE id=? AND status='queued'")
        .run(updatedAt, updatedAt, row.id);
      return { ...row, attempts: row.attempts + 1 };
    });
    return transaction() as JobRow | null;
  }

  private async run(job: JobRow) {
    this.writeEvent(job.id, job.projectId, "review_started", { submissionId: job.submissionId, attempt: job.attempts });
    try {
      const result = await this.processReview(job.projectId, job.submissionId);
      const timestamp = nowIso();
      this.db.prepare("UPDATE jobs SET status='succeeded',locked_at=NULL,last_error=NULL,updated_at=? WHERE id=?").run(timestamp, job.id);
      this.writeEvent(job.id, job.projectId, "review_finished", { status: result.status, memoryIds: result.memoryIds, conflicts: result.conflicts, attempt: job.attempts });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timestamp = nowIso();
      if (job.attempts < job.maxAttempts && !this.stopped) {
        const delayMs = Math.min(30_000, 250 * 2 ** (job.attempts - 1));
        const availableAt = new Date(Date.now() + delayMs).toISOString();
        this.db.prepare("UPDATE jobs SET status='queued',locked_at=NULL,available_at=?,last_error=?,updated_at=? WHERE id=?")
          .run(availableAt, message.slice(0, 2000), timestamp, job.id);
        this.writeEvent(job.id, job.projectId, "review_retry_scheduled", { error: message, attempt: job.attempts, nextAttemptAt: availableAt });
      } else {
        this.db.prepare("UPDATE jobs SET status='failed',locked_at=NULL,last_error=?,updated_at=? WHERE id=?")
          .run(message.slice(0, 2000), timestamp, job.id);
        this.writeEvent(job.id, job.projectId, "review_failed", { error: message, attempt: job.attempts });
      }
    }
  }

  private writeEvent(jobId: string, projectId: string, eventType: string, payload: unknown) {
    this.db.prepare("INSERT INTO job_events(job_id,project_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?)")
      .run(jobId, projectId, eventType, JSON.stringify(payload), nowIso());
  }
}
