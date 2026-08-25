import { openDatabase } from "./database.js";
import { MemoryService, type MemoryModelProvider } from "./memory-service.js";
import { RetrievalService } from "./retrieval.js";
import type { MemoryCandidateInput } from "./types.js";

const DEMO_SERIES_KEY = "mcp-retrieval-demo";
const content = "龙门是世界规则。林舟位于北城。林舟持有青铜钥匙。";

const evidence = (spanText: string) => {
  const spanStart = content.indexOf(spanText);
  if (spanStart < 0) throw new Error(`演示证据不存在: ${spanText}`);
  return { spanStart, spanEnd: spanStart + spanText.length, spanText };
};

const candidates: MemoryCandidateInput[] = [
  {
    kind: "world_rule",
    scope: "world_truth",
    subject: "龙门",
    predicate: "is",
    object: "世界规则",
    confidence: 1,
    ...evidence("龙门是世界规则"),
  },
  {
    kind: "location_topology",
    scope: "world_truth",
    subject: "林舟",
    predicate: "location",
    object: "北城",
    confidence: 1,
    ...evidence("林舟位于北城"),
  },
  {
    kind: "state_change",
    scope: "world_truth",
    subject: "林舟",
    predicate: "holds_item",
    object: "青铜钥匙",
    confidence: 1,
    ...evidence("林舟持有青铜钥匙"),
  },
];

const models: MemoryModelProvider = {
  extract: async () => [],
  verifyConflict: async ({ explanation }) => ({ confirmed: true, explanation }),
};

const db = openDatabase();
try {
  const memory = new MemoryService(db, models);
  const existing = db.prepare("SELECT id FROM projects WHERE series_key=? ORDER BY created_at LIMIT 1")
    .get(DEMO_SERIES_KEY) as { id: string } | undefined;
  const project = existing ? memory.getProject(existing.id) : memory.createProject("MCP 检索演示", DEMO_SERIES_KEY);
  const submission = memory.createSubmission(project.id, {
    title: "检索演示设定",
    kind: "setting",
    content,
    candidates,
  });
  const review = await memory.reviewSubmission(project.id, submission.id);
  const context = await new RetrievalService(db).compileContext(project.id, {
    intent: "current_state",
    instruction: "林舟目前在哪里，持有什么？",
    mentionedEntities: ["林舟"],
    tokenBudget: 200,
  });
  console.log(JSON.stringify({
    projectId: project.id,
    submissionId: submission.id,
    submissionStatus: review.submission.status,
    memoryCount: memory.listMemories(project.id).length,
    retrievalPreview: {
      tokenUsed: context.tokenUsed,
      worldState: context.worldState.map((item) => item.text),
      traceId: context.traceId,
    },
  }, null, 2));
} finally {
  db.close();
}
