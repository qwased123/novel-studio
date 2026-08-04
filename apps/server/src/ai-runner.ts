import type { JobType, TextSelection } from "@novel-studio/contracts";
import { z } from "zod";
import { agentRuntime, defineAgentTool, type AgentModelConfig } from "./agent-runtime.js";
import { getCredential } from "./credentials.js";
import { isoNow, newId, parseJson, sqlite } from "./db.js";
import { renderContext } from "./context.js";
import { plainTextToDocument } from "./document-content.js";
import { rebuildEmbeddings } from "./embeddings.js";
import { queryActiveMemory } from "./memory-query.js";
import { scanAiStyle, type StyleRuleFinding } from "./style-review.js";

type JobRow = Record<string, unknown>;

const controllers = new Map<string, AbortController>();
let drainScheduled = false;

const systemPrompts: Record<JobType, string> = {
  expand_concept: "你是中文长篇小说策划编辑。扩展创意时给出明确、可执行且互相一致的方案，不写套话。",
  outline_book: "你是中文长篇网文总编。生成能支撑长篇连载的分卷总纲，明确主线、阶段目标、升级节奏、人物弧与伏笔。",
  outline_volume: "你是分卷策划。输出本卷目标、冲突递进、关键转折、角色变化、伏笔安排和章节范围。",
  outline_chapter: "你是章节策划。输出本章目标、场景列表、冲突、信息揭示、情绪变化、结尾钩子。",
  draft_chapter: "你是成熟的中文网文作者。严格按章纲写正文，避免复述设定、空泛抒情、同义反复和对话原地打转。事实细节不确定时调用 memory_query；遇到重大剧情分叉或设定冲突时调用 request_author_decision，不要猜。只输出正文。",
  draft_scene: "你是成熟的中文网文作者。只写目标场景，保持承接，完成指定节拍后自然停止。事实细节不确定时调用 memory_query；遇到重大剧情分叉或设定冲突时调用 request_author_decision，不要猜。避免重复背景说明。只输出正文。",
  rewrite_selection: "你是小说文字编辑。只输出改写结果，保留事实、人物语气与叙事视角，不解释修改过程。",
  review_consistency: "你是小说连续性审校。检查人物状态、地点、时间线、物品归属、世界规则与前文是否冲突。",
  review_plot: "你是小说情节审校。检查因果、动机、节奏、冲突升级、信息铺垫与结尾推动力。",
  review_style: "你是中文小说文风审校。检查重复、流口水、解释性对白、视角漂移、句式单调和无效描写。",
  extract_memory: "你是小说事实记录员。只从已给原文抽取可证实的信息，不推测。每项必须附短证据。",
  distill_arc: "你是长篇小说记忆编辑。把连续章节压缩为可靠的阶段弧线摘要，保留关键转折、人物状态变化和未解决线索，不添加来源中没有的信息。",
  embed_knowledge: "",
};

function modelFor(profile: JobRow): AgentModelConfig {
  const key = getCredential(String(profile.role));
  if (!key) throw new Error(`模型角色 ${profile.role} 尚未配置 API Key`);
  const modelName = String(profile.model);
  if (!modelName) throw new Error(`模型角色 ${profile.role} 尚未配置模型名`);
  const provider = String(profile.provider) as AgentModelConfig["provider"];
  const baseUrl = String(profile.base_url || "") || undefined;
  if (provider === "openai-compatible" && !baseUrl) throw new Error("OpenAI-compatible 配置需要 Base URL");
  return { provider, model: modelName, apiKey: key, baseUrl, adapterName: `novel-studio-${profile.role}` };
}

function event(jobId: string, type: string, payload: Record<string, unknown>) {
  sqlite.prepare("INSERT INTO job_events(job_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(jobId, type, JSON.stringify(payload), isoNow());
}

function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function proposalForText(job: JobRow, text: string) {
  if (!job.document_id) return;
  const target = sqlite.prepare("SELECT current_version_id AS currentVersionId, title FROM documents WHERE id = ?").get(job.document_id) as JobRow | undefined;
  if (!target) return;
  const selection = parseJson<TextSelection | null>(job.selection_json, null);
  const selectionRewrite = job.type === "rewrite_selection";
  if (selectionRewrite && !selection) throw new Error("改写任务缺少选区快照");
  const payload = selectionRewrite
    ? { kind: "selection_rewrite", selection, originalText: selection?.text, replacementText: text.trim() }
    : { plainText: text, contentJson: plainTextToDocument(text), html: text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replaceAll("\n", "<br>")}</p>`).join("") };
  sqlite.prepare(`
    INSERT INTO proposals(id, project_id, job_id, target_type, target_id, base_version_id, status, title, payload_json, created_at)
    VALUES (?, ?, ?, 'document', ?, ?, 'pending', ?, ?, ?)
  `).run(
    newId(), job.project_id, job.id, job.document_id, job.base_version_id ?? target.currentVersionId,
    `${target.title} · ${selectionRewrite ? "选区改写" : "AI 提案"}`,
    JSON.stringify(payload),
    isoNow(),
  );
}

function enqueueDefaultReviews(job: JobRow, draft: string) {
  const reviewer = sqlite.prepare("SELECT enabled FROM model_profiles WHERE role='reviewer'").get() as { enabled: number } | undefined;
  if (!reviewer?.enabled) return;
  const insert = sqlite.prepare(`INSERT INTO ai_jobs(id,project_id,document_id,type,status,model_profile,instruction,context_snapshot_json,base_version_id,created_at)
    VALUES (?,?,?,?,'queued','reviewer',?,?,?,?)`);
  const reviewTypes = ["review_consistency", "review_plot", "review_style"] as const;
  for (const type of reviewTypes) {
    insert.run(newId(), job.project_id, job.document_id, type, `审校以下待确认草稿：\n\n<review-draft>\n${draft}\n</review-draft>`, job.context_snapshot_json, job.base_version_id, isoNow());
  }
}

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

function saveReview(job: JobRow, output: string, ruleFindings: StyleRuleFinding[] = []) {
  let parsed: { findings?: Array<Record<string, unknown>> } = {};
  try { parsed = extractJson(output) as typeof parsed; } catch {
    parsed = { findings: [{ severity: "medium", title: "审校结果", evidence: "", suggestion: output }] };
  }
  const category = String(job.type).replace("review_", "");
  const insert = sqlite.prepare(`INSERT INTO review_findings(id, project_id, job_id, document_id, category, severity, title, evidence, suggestion, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const finding of [...ruleFindings, ...(parsed.findings ?? [])]) {
    insert.run(newId(), job.project_id, job.id, job.document_id, category, finding.severity ?? "medium", finding.title ?? "审校问题", finding.evidence ?? "", finding.suggestion ?? "", isoNow());
  }
}

function saveMemoryProposal(job: JobRow, output: string) {
  let payload: unknown;
  try { payload = extractJson(output); } catch { payload = { summary: output, facts: [], foreshadows: [] }; }
  sqlite.prepare(`INSERT INTO proposals(id, project_id, job_id, target_type, target_id, base_version_id, status, title, payload_json, created_at)
    VALUES (?, ?, ?, 'memory', ?, ?, 'pending', '章节记忆回写', ?, ?)`)
    .run(newId(), job.project_id, job.id, job.document_id, job.base_version_id, JSON.stringify(payload), isoNow());
}

function saveArcProposal(job: JobRow, output: string, contextItems: Array<Record<string, unknown>>) {
  let parsed: Record<string, unknown>;
  try { parsed = extractJson(output) as Record<string, unknown>; } catch { parsed = { summary: output, openThreads: [] }; }
  const sources = contextItems.filter((entry) => String(entry.id ?? "").startsWith("arc-chapter:") && entry.sourceVersionId);
  const payload = {
    ...parsed,
    sourceChapterIds: sources.map((entry) => String(entry.id).replace("arc-chapter:", "")),
    sourceVersionIds: sources.map((entry) => String(entry.sourceVersionId)),
  };
  sqlite.prepare(`INSERT INTO proposals(id, project_id, job_id, target_type, target_id, base_version_id, status, title, payload_json, created_at)
    VALUES (?, ?, ?, 'arc_memory', ?, ?, 'pending', '阶段弧线记忆', ?, ?)`)
    .run(newId(), job.project_id, job.id, job.document_id, job.base_version_id, JSON.stringify(payload), isoNow());
}

function withOutputContract(type: JobType, instruction: string) {
  if (type.startsWith("review_")) {
    return `${instruction}\n\n只输出 JSON：{"findings":[{"severity":"low|medium|high","title":"问题标题","evidence":"原文证据","suggestion":"修改建议"}]}。没有问题时 findings 为空数组。`;
  }
  if (type === "extract_memory") {
    return `${instruction}\n\n只输出 JSON：{"summary":"客观章节摘要","facts":[{"subject":"实体名","predicate":"规范化属性或关系名","object":"新状态","kind":"identity|state|location|possession|relationship|knowledge|rule","mutable":true,"evidence":"原文证据","visibility":"author|public|limited"}],"foreshadows":[{"title":"伏笔名","detail":"新增或推进内容","status":"open|advanced|resolved","evidence":"原文证据"}]}。身份和世界规则通常 mutable=false，位置、持有物和状态通常 mutable=true。不得补充原文没有的信息。`;
  }
  if (type === "distill_arc") {
    return `${instruction}\n\n只输出 JSON：{"summary":"不超过500字的阶段弧线摘要","turningPoints":["关键转折"],"openThreads":["仍未解决的线索"]}。严格依据带来源版本的章节摘要，不得自行补情节。`;
  }
  return instruction;
}

function reviewSource(job: JobRow) {
  const instruction = String(job.instruction ?? "");
  const marked = instruction.match(/<review-draft>\n?([\s\S]*?)\n?<\/review-draft>/)?.[1];
  if (marked) return marked;
  if (!job.document_id) return "";
  const row = sqlite.prepare(`SELECT v.plain_text AS text FROM documents d JOIN document_versions v ON v.id=d.current_version_id WHERE d.id=?`)
    .get(job.document_id) as { text: string } | undefined;
  return row?.text ?? "";
}

interface AuthorDecision {
  issue: string;
  suggestions: string[];
}

function pauseForDecision(job: JobRow, decision: AuthorDecision, output: string, inputTokens: number, outputTokens: number) {
  sqlite.prepare("UPDATE ai_jobs SET status='awaiting_input',decision_json=?,output_text=?,input_tokens=?,output_tokens=? WHERE id=?")
    .run(JSON.stringify(decision), output, inputTokens || null, outputTokens || null, job.id);
  event(String(job.id), "decision_required", { issue: decision.issue, suggestions: decision.suggestions });
  event(String(job.id), "status", { status: "awaiting_input" });
}

async function runJob(job: JobRow) {
  const controller = new AbortController();
  controllers.set(String(job.id), controller);
  const startedAt = isoNow();
  const claimed = sqlite.prepare("UPDATE ai_jobs SET status='running', started_at=? WHERE id=? AND status='queued'").run(startedAt, job.id);
  if (claimed.changes === 0) return;
  event(String(job.id), "status", { status: "running" });
  try {
    const profile = sqlite.prepare("SELECT * FROM model_profiles WHERE role = ? AND enabled = 1").get(job.model_profile) as JobRow | undefined;
    if (!profile) throw new Error(`模型角色 ${job.model_profile} 尚未启用`);
    const type = String(job.type) as JobType;
    if (type === "embed_knowledge") {
      const options = parseJson<{ sourceId?: string | null; sourceKind?: string | null }>(job.instruction, {});
      const result = await rebuildEmbeddings({ projectId: String(job.project_id), sourceId: options.sourceId, sourceKind: options.sourceKind, abortSignal: controller.signal });
      sqlite.prepare("UPDATE ai_jobs SET status='succeeded',input_tokens=?,output_tokens=0,output_text=?,model_snapshot_json=?,finished_at=? WHERE id=?")
        .run(result.tokens, `已更新 ${result.chunksWritten} 个语义片段`, JSON.stringify({ provider: profile.provider, model: profile.model }), isoNow(), job.id);
      event(String(job.id), "status", { status: "succeeded", chunksWritten: result.chunksWritten });
      return;
    }
    const contextItems = parseJson<Array<Record<string, unknown>>>(job.context_snapshot_json, []);
    const context = renderContext(contextItems as never);
    const baseInstruction = String(job.instruction || "请根据上下文完成任务。");
    const selection = parseJson<TextSelection | null>(job.selection_json, null);
    if (type === "rewrite_selection" && !selection) throw new Error("改写任务缺少选区快照");
    const taskInstruction = type === "rewrite_selection"
      ? `${baseInstruction}\n\n只改写上下文中“待改写选区（原文）”的内容，输出将原位替换该选区。不得输出原文之外的前后段落。`
      : baseInstruction;
    const prompt = `${context}\n\n<task>\n${withOutputContract(type, taskInstruction)}\n</task>\n\n参考资料用于保持一致性，不代表必须在正文中逐条复述。`;
    sqlite.prepare("UPDATE ai_jobs SET prompt_snapshot=?, model_snapshot_json=? WHERE id=?")
      .run(type === "draft_chapter" ? `${prompt}\n\n<orchestration>整章按场景顺序分别生成；每场只接收上一场尾部与已完成场景列表。</orchestration>` : prompt, JSON.stringify({ provider: profile.provider, model: profile.model, temperature: profile.temperature, maxOutputTokens: profile.max_output_tokens }), job.id);
    let output = String(job.output_text ?? "");
    const resumedDraft = output;
    let inputTokens = 0;
    let outputTokens = 0;
    const runCompletion = async (completionType: JobType, completionPrompt: string, maxOutputTokens: number) => {
      const writerTools = [
        defineAgentTool({
          name: "memory_query",
          description: "当人物状态、地点、时间线、物品归属、世界规则或前情细节不确定时，主动查询当前有效记忆。使用具体关键词，不要靠猜测补全。",
          inputSchema: z.object({ query: z.string().trim().min(1).max(200) }),
          execute: async ({ query }) => {
            event(String(job.id), "memory_query", { query });
            const result = queryActiveMemory(String(job.project_id), query);
            event(String(job.id), "memory_result", { query, count: result.matches.length, sources: result.matches.map((match) => ({ title: match.title, sourceVersionId: match.sourceVersionId })) });
            return result;
          },
        }),
        defineAgentTool({
          name: "request_author_decision",
          description: "仅在重大剧情分叉、已知设定冲突或关键人物动机无法由现有材料确定时暂停，把选择交给作者。普通描写细节不要上报。",
          inputSchema: z.object({
            issue: z.string().trim().min(1).max(500),
            suggestions: z.array(z.string().trim().min(1).max(300)).min(2).max(4),
          }),
        }),
      ];
      const allowTools = completionType === "draft_chapter" || completionType === "draft_scene";
      const result = await agentRuntime.run({
        model: modelFor(profile),
        system: systemPrompts[completionType],
        prompt: completionPrompt,
        tools: allowTools ? writerTools : undefined,
        maxSteps: allowTools ? 5 : undefined,
        temperature: Number(profile.temperature),
        maxOutputTokens,
        abortSignal: controller.signal,
        maxRetries: 3,
        onTextDelta: (chunk) => {
          output += chunk;
          sqlite.prepare("UPDATE ai_jobs SET output_text=? WHERE id=?").run(output, job.id);
          event(String(job.id), "delta", { text: chunk });
        },
      });
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      const decisionCall = result.toolCalls.find((call) => call.toolName === "request_author_decision");
      const decision = decisionCall?.input as AuthorDecision | undefined;
      return { completion: result.text, decision };
    };

    if (resumedDraft && (type === "draft_chapter" || type === "draft_scene")) {
      const resumePrompt = `${context}\n\n<task>${baseInstruction}</task>\n<partial-draft-tail>${resumedDraft.slice(-1800)}</partial-draft-tail>\n\n作者已处理暂停问题。只从已有草稿末尾继续，保持无缝承接，不要复述、重写或解释前文。`;
      if (!/\s$/.test(output)) output += "\n\n";
      const result = await runCompletion(type, resumePrompt, Number(profile.max_output_tokens));
      if (result.decision) {
        pauseForDecision(job, result.decision, output, inputTokens, outputTokens);
        return;
      }
    } else if (type === "draft_chapter" && job.document_id) {
      const target = sqlite.prepare("SELECT owner_id FROM documents WHERE id=? AND owner_type='chapter'").get(job.document_id) as { owner_id: string } | undefined;
      const scenes = target ? sqlite.prepare("SELECT * FROM scenes WHERE chapter_id=? ORDER BY position").all(target.owner_id) as JobRow[] : [];
      const plannedScenes = scenes.length ? scenes : [{ id: "fallback", title: "完整章节", summary: "", goal: "", conflict: "", outcome: "" }];
      const perSceneTokens = Math.max(2048, Math.floor(Number(profile.max_output_tokens) / plannedScenes.length));
      const covered: string[] = [];
      for (const [index, scene] of plannedScenes.entries()) {
        if (index > 0) output += "\n\n";
        event(String(job.id), "scene", { index: index + 1, total: plannedScenes.length, title: scene.title });
        const scenePlan = [`摘要：${scene.summary || "未填写"}`, `目标：${scene.goal || "未填写"}`, `冲突：${scene.conflict || "未填写"}`, `结果：${scene.outcome || "未填写"}`].join("\n");
        const scenePrompt = `${context}\n\n<chapter-task>${baseInstruction}</chapter-task>\n<scene title="${scene.title}">\n${scenePlan}\n</scene>\n<continuity>\n已完成场景：${covered.join("、") || "无"}\n上一场尾部：${output.slice(-1600) || "无"}\n</continuity>\n\n只写当前场景。参考资料只用于保持一致性，不要复述设定；完成当前结果后停止，不要提前写下一场。`;
        const result = await runCompletion("draft_scene", scenePrompt, perSceneTokens);
        if (result.decision) {
          pauseForDecision(job, result.decision, output, inputTokens, outputTokens);
          return;
        }
        covered.push(String(scene.title));
      }
    } else {
      const result = await runCompletion(type, prompt, Number(profile.max_output_tokens));
      if (result.decision) {
        pauseForDecision(job, result.decision, output, inputTokens, outputTokens);
        return;
      }
    }
    if (type.startsWith("review_")) saveReview(job, output, type === "review_style" ? scanAiStyle(reviewSource(job)) : []);
    else if (type === "extract_memory") saveMemoryProposal(job, output);
    else if (type === "distill_arc") saveArcProposal(job, output, contextItems);
    else {
      proposalForText(job, output);
      if (type === "draft_chapter" || type === "draft_scene") enqueueDefaultReviews(job, output);
    }
    sqlite.prepare("UPDATE ai_jobs SET status='succeeded', output_text=?, input_tokens=?, output_tokens=?, finished_at=? WHERE id=?")
      .run(output, inputTokens || null, outputTokens || null, isoNow(), job.id);
    event(String(job.id), "status", { status: "succeeded" });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const status = cancelled ? "cancelled" : "failed";
    const message = error instanceof Error ? error.message : String(error);
    sqlite.prepare("UPDATE ai_jobs SET status=?, error=?, finished_at=? WHERE id=?").run(status, message, isoNow(), job.id);
    event(String(job.id), "status", { status, error: message });
  } finally {
    controllers.delete(String(job.id));
    scheduleDrain();
  }
}

async function drain() {
  drainScheduled = false;
  if (controllers.size >= 3) return;
  const jobs = sqlite.prepare("SELECT * FROM ai_jobs WHERE status='queued' ORDER BY created_at LIMIT ?").all(3 - controllers.size) as JobRow[];
  for (const job of jobs) void runJob(job);
}

export function scheduleDrain() {
  if (drainScheduled) return;
  drainScheduled = true;
  setTimeout(() => void drain(), 10);
}

export function cancelJob(jobId: string) {
  const controller = controllers.get(jobId);
  if (controller) controller.abort();
  else sqlite.prepare("UPDATE ai_jobs SET status='cancelled', finished_at=? WHERE id=? AND status IN ('queued','awaiting_input')").run(isoNow(), jobId);
}

export function resumeJobWithDecision(jobId: string, decision: string) {
  const source = sqlite.prepare("SELECT * FROM ai_jobs WHERE id=? AND status='awaiting_input'").get(jobId) as JobRow | undefined;
  if (!source) throw new Error("等待作者决策的任务不存在");
  const answer = decision.trim();
  if (!answer) throw new Error("作者决策不能为空");
  const id = newId();
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE ai_jobs SET status='cancelled',finished_at=? WHERE id=?").run(isoNow(), jobId);
    event(jobId, "author_decision", { decision: answer, resumedByJobId: id });
    sqlite.prepare(`INSERT INTO ai_jobs(id,project_id,document_id,scene_id,type,status,model_profile,instruction,selection_json,context_snapshot_json,base_version_id,output_text,retry_of_job_id,created_at)
      VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?,?,?)`)
      .run(id, source.project_id, source.document_id, source.scene_id, source.type, source.model_profile, `${source.instruction}\n\n【作者对暂停问题的决定】\n${answer}`, source.selection_json, source.context_snapshot_json, source.base_version_id, source.output_text ?? "", source.id, isoNow());
  })();
  scheduleDrain();
  return { id };
}
