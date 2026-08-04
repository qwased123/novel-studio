import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, GitBranch, MapPin, Plus, ScrollText, UserRound, UsersRound, X } from "lucide-react";
import { useState } from "react";
import { api } from "../api";

type EntityType = "character" | "location" | "faction" | "item" | "rule" | "concept";
interface Entity { id: string; type: EntityType; name: string; summary: string; aliases: string[]; attributes: Record<string, unknown>; visibility: string; version: number }
interface Fact { id: string; subject_name?: string; predicate: string; object_text: string; evidence: string; status: string }
interface Foreshadow { id: string; title: string; detail: string; status: string; evidence: string }
interface MemoryConflict { id: string; subjectName?: string; predicate: string; existingObject?: string; candidate: { object?: string; evidence?: string }; reason: string; status: string }
interface EmbeddingStatus { vectorAvailable: boolean; enabled: boolean; indexedSources: number; totalSources: number; model: string }
interface ArcSummary { id: string; summary: string; openThreads: string[]; stale: number; startChapter: string; endChapter: string }

const typeMeta: Record<EntityType, { label: string; icon: typeof UserRound }> = {
  character: { label: "人物", icon: UserRound }, location: { label: "地点", icon: MapPin }, faction: { label: "势力", icon: UsersRound },
  item: { label: "物品", icon: ScrollText }, rule: { label: "规则", icon: GitBranch }, concept: { label: "概念", icon: ScrollText },
};

export function KnowledgeView({ projectId, mode = "bible" }: { projectId: string; mode?: "bible" | "memory" }) {
  const queryClient = useQueryClient();
  const [type, setType] = useState<EntityType>("character");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", summary: "", aliases: "", visibility: "author" });
  const entities = useQuery({ queryKey: ["entities", projectId], queryFn: () => api<Entity[]>(`/api/projects/${projectId}/entities`) });
  const facts = useQuery({ queryKey: ["facts", projectId], queryFn: () => api<Fact[]>(`/api/projects/${projectId}/facts`), enabled: mode === "memory" });
  const foreshadows = useQuery({ queryKey: ["foreshadows", projectId], queryFn: () => api<Foreshadow[]>(`/api/projects/${projectId}/foreshadows`), enabled: mode === "memory" });
  const conflicts = useQuery({ queryKey: ["memory-conflicts", projectId], queryFn: () => api<MemoryConflict[]>(`/api/projects/${projectId}/memory-conflicts`), enabled: mode === "memory" });
  const embedding = useQuery({ queryKey: ["embedding-status", projectId], queryFn: () => api<EmbeddingStatus>(`/api/projects/${projectId}/embedding-status`), enabled: mode === "memory", refetchInterval: 5_000 });
  const arcs = useQuery({ queryKey: ["arc-summaries", projectId], queryFn: () => api<ArcSummary[]>(`/api/projects/${projectId}/arc-summaries`), enabled: mode === "memory" });
  const reindex = useMutation({ mutationFn: () => api(`/api/projects/${projectId}/reindex`, { method: "POST" }), onSuccess: () => void embedding.refetch() });
  const create = useMutation({
    mutationFn: () => api(`/api/projects/${projectId}/entities`, { method: "POST", body: JSON.stringify({ type, name: form.name, summary: form.summary, aliases: form.aliases.split(/[，,]/).map((s) => s.trim()).filter(Boolean), attributes: {}, visibility: form.visibility }) }),
    onSuccess: () => { setCreating(false); setForm({ name: "", summary: "", aliases: "", visibility: "author" }); void queryClient.invalidateQueries({ queryKey: ["entities", projectId] }); },
  });

  if (mode === "memory") {
    const warnings = (facts.data?.filter((fact) => fact.status === "stale").length ?? 0) + (conflicts.data?.filter((conflict) => conflict.status === "open").length ?? 0) + (arcs.data?.filter((arc) => arc.stale).length ?? 0);
    return <section className="content-view memory-view"><header className="content-view-header"><div><span className="eyebrow">长期记忆</span><h1>记忆健康</h1><p>所有事实保留来源，过期或冲突内容不会进入硬约束。</p></div><div className="health-actions"><div className={`health-score ${warnings ? "warn" : "good"}`}>{warnings ? <AlertTriangle size={22} /> : <CheckCircle2 size={22} />}<div><strong>{warnings ? `${warnings} 项待处理` : "状态正常"}</strong><span>{facts.data?.length ?? 0} 条结构化事实</span></div></div><button className="button secondary" disabled={!embedding.data?.enabled || reindex.isPending} onClick={() => reindex.mutate()}>{reindex.isPending ? "排队中…" : "重建语义索引"}</button></div></header>
      <div className="embedding-strip"><div><strong>语义检索</strong><span>{embedding.data?.enabled ? `${embedding.data.indexedSources}/${embedding.data.totalSources} 个来源 · ${embedding.data.model}` : "配置并启用向量模型后可用"}</span></div><i><span style={{ width: `${embedding.data?.totalSources ? embedding.data.indexedSources / embedding.data.totalSources * 100 : 0}%` }} /></i></div>
      {(conflicts.data?.some((conflict) => conflict.status === "open")) && <section className="conflict-section"><div className="subheading"><h2>待处理冲突</h2><span>{conflicts.data.filter((conflict) => conflict.status === "open").length}</span></div><div className="data-list">{conflicts.data.filter((conflict) => conflict.status === "open").map((conflict) => <div className="conflict-row" key={conflict.id}><AlertTriangle size={16} /><div><strong>{conflict.subjectName || "未解析主体"} · {conflict.predicate}</strong><span>{conflict.reason}</span><small>现有：{conflict.existingObject || "无"}　候选：{conflict.candidate.object || "无"}</small></div><button className="button text" onClick={async () => { await api(`/api/memory-conflicts/${conflict.id}`, { method: "PATCH", body: JSON.stringify({ status: "dismissed" }) }); void conflicts.refetch(); }}>忽略候选</button></div>)}</div></section>}
      {arcs.data && arcs.data.length > 0 && <section className="arc-memory-section"><div className="subheading"><h2>阶段弧线</h2><span>{arcs.data.filter((arc) => !arc.stale).length}</span></div><div className="data-list">{arcs.data.map((arc) => <div className="data-row arc-memory-row" key={arc.id}><GitBranch size={16} /><div><strong>{arc.startChapter} - {arc.endChapter}</strong><small>{arc.summary}</small>{arc.openThreads.length > 0 && <small>未结线索：{arc.openThreads.join("、")}</small>}</div><span className={`status-dot ${arc.stale ? "stale" : ""}`} /></div>)}</div></section>}
      <div className="memory-columns"><section><div className="subheading"><h2>事实账本</h2><span>{facts.data?.length ?? 0}</span></div><div className="data-list">{facts.data?.map((fact) => <div className="data-row" key={fact.id}><span className="fact-subject">{fact.subject_name || "全局"}</span><div><strong>{fact.predicate}：{fact.object_text}</strong><small>{fact.evidence || "无证据摘录"}</small></div><span className={`status-dot ${fact.status}`} /></div>)}{facts.data?.length === 0 && <div className="empty-state">接受章节记忆提案后，事实会出现在这里。</div>}</div></section>
      <section><div className="subheading"><h2>伏笔追踪</h2><span>{foreshadows.data?.length ?? 0}</span></div><div className="data-list">{foreshadows.data?.map((entry) => <div className="data-row" key={entry.id}><span className={`foreshadow-status ${entry.status}`}>{entry.status === "resolved" ? "已回收" : entry.status === "advanced" ? "推进中" : "待回收"}</span><div><strong>{entry.title}</strong><small>{entry.detail}</small></div></div>)}{foreshadows.data?.length === 0 && <div className="empty-state">尚未登记伏笔。</div>}</div></section></div>
    </section>;
  }

  const filtered = entities.data?.filter((entry) => entry.type === type) ?? [];
  const EmptyTypeIcon = typeMeta[type].icon;
  return <section className="content-view"><header className="content-view-header"><div><span className="eyebrow">结构化设定</span><h1>故事圣经</h1><p>人物、地点和规则会按任务相关性进入上下文。</p></div><button className="button primary" onClick={() => setCreating(true)}><Plus size={16} />新增{typeMeta[type].label}</button></header>
    <div className="type-tabs">{(Object.entries(typeMeta) as [EntityType, typeof typeMeta[EntityType]][]).map(([key, meta]) => { const Icon = meta.icon; return <button key={key} className={type === key ? "active" : ""} onClick={() => setType(key)}><Icon size={15} />{meta.label}<span>{entities.data?.filter((entry) => entry.type === key).length ?? 0}</span></button>; })}</div>
    <div className="entity-grid">{filtered.map((entity) => <article className="entity-card" key={entity.id}><header><span className="entity-avatar">{entity.name.slice(0, 1)}</span><div><h2>{entity.name}</h2><span>v{entity.version} · {entity.visibility === "author" ? "作者信息" : "公开信息"}</span></div></header><p>{entity.summary || "暂无描述"}</p>{entity.aliases.length > 0 && <footer>{entity.aliases.map((alias) => <span key={alias}>{alias}</span>)}</footer>}</article>)}{filtered.length === 0 && <div className="empty-state large"><EmptyTypeIcon size={30} /><h2>还没有{typeMeta[type].label}设定</h2></div>}</div>
    {creating && <div className="modal-backdrop"><form className="modal compact-modal" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}><header><div><h2>新增{typeMeta[type].label}</h2><p>先记录稳定事实，细节可以随创作补充。</p></div><button type="button" className="icon-button" onClick={() => setCreating(false)}><X size={18} /></button></header><label><span>名称</span><input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label><label><span>别名</span><input value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} placeholder="用逗号分隔" /></label><label><span>简述</span><textarea rows={7} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></label>{create.error && <div className="error-banner">{create.error.message}</div>}<footer><button type="button" className="button secondary" onClick={() => setCreating(false)}>取消</button><button className="button primary" disabled={!form.name.trim()}>保存设定</button></footer></form></div>}
  </section>;
}
