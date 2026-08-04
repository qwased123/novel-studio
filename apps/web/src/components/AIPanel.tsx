import type { ContextItem, JobStatus, JobType, TextSelection, TreeScene } from "@novel-studio/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, Check, ChevronDown, CircleHelp, CircleStop, Clapperboard, Eye, LoaderCircle, Play, RefreshCw, RotateCcw, Sparkles, TextCursorInput, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

interface Job { id: string; type: JobType; status: JobStatus; modelProfile: string; error?: string; inputTokens?: number; outputTokens?: number; createdAt: string; decision?: { issue: string; suggestions: string[] } | null; activity?: { type: "memory_query" | "memory_result"; query?: string; count?: number } | null }
interface Proposal { id: string; jobId: string; targetType: string; targetId: string; status: string; title: string; payload: { kind?: string; plainText?: string; summary?: string; facts?: unknown[]; originalText?: string; replacementText?: string }; createdAt: string }
interface Finding { id: string; category: string; severity: string; title: string; evidence: string; suggestion: string; status: string }

const taskLabels: Record<JobType, string> = {
  expand_concept: "扩展创意", outline_book: "生成总纲", outline_volume: "生成卷纲", outline_chapter: "生成章纲",
  draft_chapter: "生成整章", draft_scene: "生成场景", rewrite_selection: "改写选区", review_consistency: "一致性审校",
  review_plot: "情节审校", review_style: "文风审校", extract_memory: "提取章节记忆",
  distill_arc: "蒸馏阶段弧线",
  embed_knowledge: "更新语义索引",
};

const temperatureLabels: Record<ContextItem["temperature"], string> = { blue: "蓝灯", green: "绿灯", cold: "冷存档" };

function defaultTask(kind?: string): JobType {
  if (kind === "book_outline") return "outline_book";
  if (kind === "volume_outline") return "outline_volume";
  if (kind === "chapter_outline") return "outline_chapter";
  if (kind === "premise" || kind === "synopsis") return "expand_concept";
  return "draft_chapter";
}

function profileFor(type: JobType) {
  if (type.startsWith("review_")) return "reviewer";
  if (type === "extract_memory") return "extractor";
  if (type === "distill_arc") return "extractor";
  if (type === "embed_knowledge") return "embedder";
  if (type.startsWith("draft_") || type === "rewrite_selection") return "writer";
  return "planner";
}

export function AIPanel({ projectId, documentId, documentKind, scene, selection, documentDirty, mobileOpen, onMobileClose }: { projectId: string; documentId: string; documentKind?: string; scene?: TreeScene | null; selection?: TextSelection | null; documentDirty?: boolean; mobileOpen?: boolean; onMobileClose?: () => void }) {
  const queryClient = useQueryClient();
  const [taskType, setTaskType] = useState<JobType>(defaultTask(documentKind));
  const [instruction, setInstruction] = useState("");
  const [context, setContext] = useState<{ items: ContextItem[]; estimatedTokens: number; maxInputTokens: number } | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [forcedIncluded, setForcedIncluded] = useState<Set<string>>(new Set());
  const [decisionDrafts, setDecisionDrafts] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<"create" | "results">("create");
  useEffect(() => {
    setTaskType(scene ? "draft_scene" : defaultTask(documentKind));
    setInstruction(scene ? `写“${scene.title}”。\n目标：${scene.goal || "按场景摘要推进"}\n冲突：${scene.conflict || "按场景摘要推进"}\n结果：${scene.outcome || "按场景摘要收束"}` : "");
    setContext(null); setExcluded(new Set()); setForcedIncluded(new Set());
  }, [documentId, documentKind, scene?.id]);

  const jobs = useQuery({ queryKey: ["jobs", projectId], queryFn: () => api<Job[]>(`/api/jobs?projectId=${projectId}`), refetchInterval: 2_000 });
  const proposals = useQuery({ queryKey: ["proposals", projectId], queryFn: () => api<Proposal[]>(`/api/proposals?projectId=${projectId}`), refetchInterval: 2_000 });
  const findings = useQuery({ queryKey: ["findings", projectId], queryFn: () => api<Finding[]>(`/api/review-findings?projectId=${projectId}`), refetchInterval: 4_000 });
  const payload = useMemo(() => ({ type: taskType, projectId, documentId, sceneId: scene?.id ?? null, instruction, modelProfile: profileFor(taskType), selection: taskType === "rewrite_selection" ? selection ?? null : null, contextOverrides: { includeIds: [...forcedIncluded], excludeIds: [...excluded] } }), [taskType, projectId, documentId, scene?.id, instruction, selection, excluded, forcedIncluded]);
  const preview = useMutation({ mutationFn: () => api<{ items: ContextItem[]; estimatedTokens: number; maxInputTokens: number }>("/api/context/preview", { method: "POST", body: JSON.stringify(payload) }), onSuccess: setContext });
  const run = useMutation({
    mutationFn: () => api<{ id: string }>("/api/jobs", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => { setInstruction(""); setTab("results"); void queryClient.invalidateQueries({ queryKey: ["jobs", projectId] }); },
  });
  const activeJobs = jobs.data?.filter((job) => ["queued", "running"].includes(job.status)) ?? [];
  const waitingJobs = jobs.data?.filter((job) => job.status === "awaiting_input") ?? [];
  const pending = proposals.data?.filter((proposal) => proposal.status === "pending" && proposal.targetId === documentId) ?? [];
  const openFindings = findings.data?.filter((finding) => finding.status === "open") ?? [];
  const selectionReady = taskType !== "rewrite_selection" || (Boolean(selection) && !documentDirty);
  const selectedContextTokens = context?.items.filter((entry) => entry.required || forcedIncluded.has(entry.id) || (entry.included && !excluded.has(entry.id))).reduce((sum, entry) => sum + entry.estimatedTokens, 0) ?? 0;

  async function decide(proposalId: string, decision: "accept" | "reject") {
    await api(`/api/proposals/${proposalId}/${decision}`, { method: "POST" });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["proposals", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["document", documentId] }),
      queryClient.invalidateQueries({ queryKey: ["tree", projectId] }),
    ]);
  }

  function toggleContext(entry: ContextItem, checked: boolean) {
    setExcluded((current) => {
      const next = new Set(current);
      checked ? next.delete(entry.id) : next.add(entry.id);
      return next;
    });
    setForcedIncluded((current) => {
      const next = new Set(current);
      if (checked && !entry.included) next.add(entry.id); else next.delete(entry.id);
      return next;
    });
  }

  async function submitDecision(job: Job, answer?: string) {
    const decision = (answer ?? decisionDrafts[job.id] ?? "").trim();
    if (!decision) return;
    await api(`/api/jobs/${job.id}/decision`, { method: "POST", body: JSON.stringify({ decision }) });
    setDecisionDrafts((current) => ({ ...current, [job.id]: "" }));
    await jobs.refetch();
  }

  return (
    <aside className={`ai-panel ${mobileOpen ? "mobile-open" : ""}`}>
      <header className="panel-title"><div><span className="ai-symbol"><Sparkles size={16} /></span><strong>AI 协作</strong></div><div>{activeJobs.length > 0 && <span className="running-pill"><LoaderCircle size={13} className="spin" />{activeJobs.length}</span>}<button className="icon-button mobile-only" title="关闭 AI 协作" onClick={onMobileClose}><X size={17} /></button></div></header>
      <div className="segmented"><button className={tab === "create" ? "active" : ""} onClick={() => setTab("create")}>创作</button><button className={tab === "results" ? "active" : ""} onClick={() => setTab("results")}>结果{pending.length + waitingJobs.length ? ` ${pending.length + waitingJobs.length}` : ""}</button></div>

      {tab === "create" ? <div className="panel-scroll">
        {scene && <div className="scene-target"><Clapperboard size={14} /><div><span>当前场景</span><strong>{scene.title}</strong></div></div>}
        <label className="field-label"><span>任务</span><div className="select-wrap"><select value={taskType} onChange={(e) => { setTaskType(e.target.value as JobType); setContext(null); }}>
          {(Object.keys(taskLabels) as JobType[]).filter((type) => type !== "extract_memory" && type !== "distill_arc" && type !== "embed_knowledge").map((type) => <option key={type} value={type}>{taskLabels[type]}</option>)}
        </select><ChevronDown size={14} /></div></label>
        {taskType === "rewrite_selection" && <div className={`selection-target ${selectionReady ? "ready" : "blocked"}`}><TextCursorInput size={15} /><div><span>{documentDirty ? "正文有未保存修改" : selection ? `已选 ${selection.text.length} 个字符` : "未选择正文"}</span><strong>{selection?.text.slice(0, 90) ?? "-"}{(selection?.text.length ?? 0) > 90 ? "…" : ""}</strong></div></div>}
        <label className="field-label"><span>本次要求</span><textarea rows={6} value={instruction} onChange={(e) => { setInstruction(e.target.value); setContext(null); setExcluded(new Set()); setForcedIncluded(new Set()); }} placeholder="目标字数、场景重点、必须出现或避免的内容…" /></label>
        <div className="context-summary"><div><Eye size={15} /><strong>上下文</strong></div>{context ? <span>{selectedContextTokens.toLocaleString()} / {context.maxInputTokens.toLocaleString()} tokens</span> : <span>运行前检查实际材料</span>}</div>
        {context && <><div className="memory-temperature-legend"><span><i className="blue" />蓝灯 {context.items.filter((entry) => entry.temperature === "blue").length}</span><span><i className="green" />绿灯 {context.items.filter((entry) => entry.temperature === "green").length}</span><span><i className="cold" />冷存档 {context.items.filter((entry) => entry.temperature === "cold").length}</span></div><div className="context-list">{context.items.map((entry) => <label key={entry.id} className={`context-item temperature-${entry.temperature} ${entry.required ? "required" : ""}`}><input type="checkbox" checked={entry.required || forcedIncluded.has(entry.id) || (entry.included && !excluded.has(entry.id))} disabled={entry.required} onChange={(e) => toggleContext(entry, e.target.checked)} /><i className={`temperature-dot ${entry.temperature}`} title={temperatureLabels[entry.temperature]} /><span><strong>{entry.title}</strong><small>{entry.reason} · {entry.estimatedTokens} tokens</small></span></label>)}</div></>}
        {(preview.error || run.error) && <div className="error-banner compact"><AlertTriangle size={14} />{preview.error?.message ?? run.error?.message}</div>}
        <div className="panel-actions"><button className="button secondary" onClick={() => preview.mutate()} disabled={preview.isPending || !selectionReady}>{preview.isPending ? <LoaderCircle size={15} className="spin" /> : <Eye size={15} />}检查上下文</button><button className="button primary" onClick={() => run.mutate()} disabled={run.isPending || !instruction.trim() || !selectionReady}><Play size={15} />运行</button></div>
      </div> : <div className="panel-scroll results-scroll">
        {activeJobs.map((job) => <div className="job-row active-job" key={job.id}><span className="status-icon"><LoaderCircle size={15} className="spin" /></span><div><strong>{taskLabels[job.type]}</strong><small>{job.status === "queued" ? "等待执行" : job.activity?.type === "memory_query" ? `查询记忆：${job.activity.query ?? ""}` : job.activity?.type === "memory_result" ? `记忆查询完成 · ${job.activity.count ?? 0} 条` : "模型正在生成"}</small></div><button className="icon-button small" title="取消" onClick={async () => { await api(`/api/jobs/${job.id}/cancel`, { method: "POST" }); void jobs.refetch(); }}><CircleStop size={15} /></button></div>)}
        {waitingJobs.map((job) => <article className="decision-request" key={job.id}><header><CircleHelp size={16} /><strong>需要作者决策</strong></header><p>{job.decision?.issue ?? "写作遇到需要确认的重大分叉。"}</p><div>{job.decision?.suggestions.map((suggestion) => <button className="decision-option" key={suggestion} onClick={() => void submitDecision(job, suggestion)}>{suggestion}</button>)}</div><textarea rows={3} value={decisionDrafts[job.id] ?? ""} onChange={(event) => setDecisionDrafts((current) => ({ ...current, [job.id]: event.target.value }))} placeholder="输入自己的决定" /><footer><button className="button ghost compact" onClick={async () => { await api(`/api/jobs/${job.id}/cancel`, { method: "POST" }); void jobs.refetch(); }}>取消任务</button><button className="button primary compact" disabled={!decisionDrafts[job.id]?.trim()} onClick={() => void submitDecision(job)}>继续写作</button></footer></article>)}
        {pending.map((proposal) => <div className="proposal" key={proposal.id}><header><Bot size={15} /><strong>{proposal.title}</strong></header>{proposal.payload.kind === "selection_rewrite" ? <div className="proposal-comparison"><div><span>原文</span><p>{proposal.payload.originalText}</p></div><div><span>改写</span><p>{proposal.payload.replacementText}</p></div></div> : <p>{proposal.payload.plainText?.slice(0, 500) ?? proposal.payload.summary ?? "结构化记忆提案"}{(proposal.payload.plainText?.length ?? 0) > 500 ? "…" : ""}</p>}<footer><button className="button danger-text" onClick={() => void decide(proposal.id, "reject")}><X size={14} />拒绝</button><button className="button primary compact" onClick={() => void decide(proposal.id, "accept")}><Check size={14} />接受</button></footer></div>)}
        {openFindings.slice(0, 12).map((finding) => <div className={`finding severity-${finding.severity}`} key={finding.id}><header><AlertTriangle size={14} /><strong>{finding.title}</strong><span>{({ consistency: "一致性", plot: "情节", style: "文风" } as Record<string,string>)[finding.category]}</span></header>{finding.evidence && <blockquote>{finding.evidence}</blockquote>}<p>{finding.suggestion}</p><button className="button text" onClick={async () => { await api(`/api/review-findings/${finding.id}`, { method: "PATCH", body: JSON.stringify({ status: "resolved" }) }); void findings.refetch(); }}><Check size={13} />标记已处理</button></div>)}
        {jobs.data?.filter((job) => job.status === "failed").slice(0, 4).map((job) => <div className="job-row failed" key={job.id}><AlertTriangle size={15} /><div><strong>{taskLabels[job.type]}失败</strong><small>{job.error}</small></div><button className="icon-button small" title="重试" onClick={async () => { await api(`/api/jobs/${job.id}/retry`, { method: "POST" }); void jobs.refetch(); }}><RotateCcw size={15} /></button></div>)}
        {!activeJobs.length && !waitingJobs.length && !pending.length && !openFindings.length && <div className="empty-panel"><RefreshCw size={22} /><span>暂无待处理结果</span></div>}
      </div>}
    </aside>
  );
}
