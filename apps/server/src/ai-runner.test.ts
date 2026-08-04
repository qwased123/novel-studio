import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeJobWithDecision, scheduleDrain } from "./ai-runner.js";
import { buildContext } from "./context.js";
import { setCredential } from "./credentials.js";
import { isoNow, newId, sqlite } from "./db.js";
import { createProject, getDocument, getProjectTree, saveDocument } from "./repository.js";

function streamResponse(text: string) {
  const chunks = [
    { id: "mock-1", object: "chat.completion.chunk", created: 1, model: "mock-writer", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "mock-1", object: "chat.completion.chunk", created: 1, model: "mock-writer", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("persistent AI runner", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.prepare("UPDATE model_profiles SET enabled=0 WHERE role='writer'").run();
    setCredential("writer", "");
  });

  it("persists a compatible streaming response as a reviewable proposal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse("雨声越过破窗，落在档案封皮上。")));
    sqlite.prepare("UPDATE model_profiles SET provider='openai-compatible',model='mock-writer',base_url='http://mock.local/v1',enabled=1 WHERE role='writer'").run();
    setCredential("writer", "test-key");
    const { id: projectId } = createProject({ title: `AI测试-${crypto.randomUUID()}`, genre: "悬疑", premise: "旧城档案失踪", targetWords: 100000, pov: "第三人称限知", audience: "中文网文读者" });
    const documentId = String(getProjectTree(projectId)?.volumes[0]?.chapters[0]?.documentId);
    const document = getDocument(documentId)!;
    const context = await buildContext({ projectId, documentId, type: "draft_scene", instruction: "写一个雨夜场景" });
    const jobId = newId();
    sqlite.prepare(`INSERT INTO ai_jobs(id,project_id,document_id,type,status,model_profile,instruction,context_snapshot_json,base_version_id,created_at)
      VALUES (?,?,?,'draft_scene','queued','writer',?,?,?,?)`).run(jobId, projectId, documentId, "写一个雨夜场景", JSON.stringify(context.items), document.currentVersionId, isoNow());
    scheduleDrain();

    await vi.waitFor(() => {
      const job = sqlite.prepare("SELECT status FROM ai_jobs WHERE id=?").get(jobId) as { status: string };
      expect(job.status).toBe("succeeded");
    }, { timeout: 3_000, interval: 25 });
    const proposal = sqlite.prepare("SELECT payload_json FROM proposals WHERE job_id=?").get(jobId) as { payload_json: string };
    expect(JSON.parse(proposal.payload_json).plainText).toContain("档案封皮");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stores a rewrite as a selection proposal instead of a whole document", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse("冷雨斜穿破窗，敲响泛黄的档案封皮。")));
    sqlite.prepare("UPDATE model_profiles SET provider='openai-compatible',model='mock-writer',base_url='http://mock.local/v1',enabled=1 WHERE role='writer'").run();
    setCredential("writer", "test-key");
    const { id: projectId } = createProject({ title: `选区测试-${crypto.randomUUID()}`, genre: "悬疑", premise: "旧城档案失踪", targetWords: 100000, pov: "第三人称限知", audience: "中文网文读者" });
    const documentId = String(getProjectTree(projectId)?.volumes[0]?.chapters[0]?.documentId);
    const emptyDocument = getDocument(documentId)!;
    saveDocument(documentId, {
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "雨声越过破窗，落在档案封皮上。林彻没有回头。" }] }] },
      plainText: "雨声越过破窗，落在档案封皮上。林彻没有回头。",
      html: "<p>雨声越过破窗，落在档案封皮上。林彻没有回头。</p>",
      expectedVersionId: emptyDocument.currentVersionId,
      message: "选区测试正文",
    });
    const document = getDocument(documentId)!;
    const selection = { from: 1, to: 17, text: "雨声越过破窗，落在档案封皮上。" };
    const context = await buildContext({ projectId, documentId, type: "rewrite_selection", instruction: "增强雨夜氛围", selection });
    const jobId = newId();
    sqlite.prepare(`INSERT INTO ai_jobs(id,project_id,document_id,type,status,model_profile,instruction,selection_json,context_snapshot_json,base_version_id,created_at)
      VALUES (?,?,?,'rewrite_selection','queued','writer',?,?,?,?,?)`).run(jobId, projectId, documentId, "增强雨夜氛围", JSON.stringify(selection), JSON.stringify(context.items), document.currentVersionId, isoNow());
    scheduleDrain();

    await vi.waitFor(() => {
      const job = sqlite.prepare("SELECT status FROM ai_jobs WHERE id=?").get(jobId) as { status: string };
      expect(job.status).toBe("succeeded");
    }, { timeout: 3_000, interval: 25 });
    const proposal = sqlite.prepare("SELECT payload_json FROM proposals WHERE job_id=?").get(jobId) as { payload_json: string };
    const payload = JSON.parse(proposal.payload_json) as Record<string, unknown>;
    expect(payload.kind).toBe("selection_rewrite");
    expect(payload.replacementText).toContain("冷雨斜穿破窗");
    expect(payload).not.toHaveProperty("contentJson");
  });

  it("persists an author decision and resumes from the partial draft", () => {
    const { id: projectId } = createProject({ title: `决策测试-${crypto.randomUUID()}`, genre: "悬疑", premise: "旧城档案失踪", targetWords: 100000, pov: "第三人称限知", audience: "中文网文读者" });
    const documentId = String(getProjectTree(projectId)?.volumes[0]?.chapters[0]?.documentId);
    const document = getDocument(documentId)!;
    const sourceJobId = newId();
    sqlite.prepare(`INSERT INTO ai_jobs(id,project_id,document_id,type,status,model_profile,instruction,context_snapshot_json,base_version_id,output_text,decision_json,created_at)
      VALUES (?,?,?,'draft_scene','awaiting_input','writer',?,?,?,?,?,?)`).run(sourceJobId, projectId, documentId, "写林彻进入档案馆", "[]", document.currentVersionId, "林彻推开二楼的门。", JSON.stringify({ issue: "门后是谁？", suggestions: ["顾遥", "陌生人"] }), isoNow());
    const { id: resumedJobId } = resumeJobWithDecision(sourceJobId, "门后是顾遥，但她拒绝解释来意。");
    const resumed = sqlite.prepare("SELECT status,instruction,output_text,retry_of_job_id FROM ai_jobs WHERE id=?").get(resumedJobId) as Record<string, unknown>;
    expect(resumed).toMatchObject({ status: "queued", output_text: "林彻推开二楼的门。", retry_of_job_id: sourceJobId });
    expect(String(resumed.instruction)).toContain("门后是顾遥");
    expect((sqlite.prepare("SELECT status FROM ai_jobs WHERE id=?").get(sourceJobId) as { status: string }).status).toBe("cancelled");
  });
});
