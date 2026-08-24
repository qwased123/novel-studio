import { performance } from "node:perf_hooks";
import { openDatabase } from "./database.js";
import { MemoryService } from "./memory-service.js";
import { RetrievalService } from "./retrieval.js";

const targetChars = Math.max(10_000, Number(process.argv[2] ?? process.env.BENCHMARK_TARGET_CHARS ?? 1_500_000));
const db = openDatabase(":memory:");
const memory = new MemoryService(db, { extract: async () => [], verifyConflict: async ({ explanation }) => ({ confirmed: true, explanation }) });
const retrieval = new RetrievalService(db);
const project = memory.createProject("benchmark");
const filler = " 这是用于本地检索压测的正文片段。它不代表任何正式设定，只用于扩大来源规模。";
const setupStart = performance.now();
let generatedChars = 0;
let index = 0;
while (generatedChars < targetChars) {
  const label = `角色${String(index).padStart(6, "0")}`;
  const prefix = `${label}位于北城。`;
  const content = `${prefix}${filler.repeat(Math.max(1, Math.ceil(1200 / filler.length)))}`;
  const submission = memory.createSubmission(project.id, {
    title: `片段 ${index}`,
    kind: "prose",
    content,
    candidates: [{ kind: "location_topology", scope: "world_truth", subject: label, predicate: "location", object: "北城", spanStart: 0, spanEnd: prefix.length - 1, spanText: prefix.slice(0, -1) }],
  });
  await memory.reviewSubmission(project.id, submission.id);
  generatedChars += content.length;
  index += 1;
}
const setupMs = performance.now() - setupStart;
const timings: number[] = [];
for (let i = 0; i < 30; i += 1) {
  const start = performance.now();
  await retrieval.compileContext(project.id, { intent: "current_state", instruction: "北城中的角色状态", tokenBudget: 1200 });
  timings.push(performance.now() - start);
}
timings.sort((a, b) => a - b);
const percentile = (value: number) => timings[Math.min(timings.length - 1, Math.floor(timings.length * value))] ?? 0;
console.log(JSON.stringify({
  targetChars, generatedChars, memories: index, setupMs: Number(setupMs.toFixed(2)),
  retrievalMs: { p50: Number(percentile(0.5).toFixed(2)), p95: Number(percentile(0.95).toFixed(2)), max: Number(Math.max(...timings).toFixed(2)) },
}, null, 2));
db.close();
