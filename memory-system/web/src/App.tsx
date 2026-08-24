import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BookOpen, Check, Plus, RefreshCw, Search, Send } from "lucide-react";

type Project = { id: string; name: string; seriesKey: string };
type Submission = { id: string; title: string; kind: string; status: string; error: string | null; updatedAt: string };
type Memory = { id: string; sourceTitle: string; kind: string; scope: string; subject: string; predicate: string; object: string; spanText: string; validUntil: string | null };
type Conflict = { id: string; explanation: string; severity: string; category: string; status: string };
type ContextPack = { hardConstraints: Array<{ text: string; quote: string }>; worldState: Array<{ text: string; quote: string }>; disputes: Array<{ text: string; quote: string }>; tokenUsed: number; tokenBudget: number; insufficientEvidence: string[] };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.error ?? `HTTP ${response.status}`));
  return payload as T;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [title, setTitle] = useState("新提交");
  const [kind, setKind] = useState<"setting" | "prose" | "outline">("prose");
  const [content, setContent] = useState("");
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [instruction, setInstruction] = useState("当前场景需要哪些确定事实？");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [context, setContext] = useState<ContextPack | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const currentProject = useMemo(() => projects.find((project) => project.id === projectId), [projects, projectId]);

  const refresh = async (id = projectId) => {
    if (!id) return;
    const [nextMemories, nextConflicts, nextSubmissions] = await Promise.all([
      api<Memory[]>(`/api/projects/${id}/memories?includeRetconned=true`),
      api<Conflict[]>(`/api/projects/${id}/conflicts?status=open`),
      api<Submission[]>(`/api/projects/${id}/submissions?limit=40`),
    ]);
    setMemories(nextMemories);
    setConflicts(nextConflicts);
    setSubmissions(nextSubmissions);
  };

  useEffect(() => {
    void api<Project[]>("/api/projects").then((items) => {
      setProjects(items);
      if (items[0]) setProjectId(items[0].id);
    }).catch((error: Error) => setMessage(error.message));
  }, []);

  useEffect(() => { void refresh(); }, [projectId]);

  const createProject = async () => {
    setBusy(true); setMessage("");
    try {
      const project = await api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name: projectName }) });
      setProjects((items) => [project, ...items]); setProjectId(project.id); setProjectName("");
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  };

  const submit = async () => {
    if (!projectId || !content.trim()) return;
    setBusy(true); setMessage("");
    try {
      const submission = await api<{ id: string }>(`/api/projects/${projectId}/submissions`, { method: "POST", body: JSON.stringify({ title, kind, content }) });
      const result = await api<{ submission: { status: string }; conflicts: Conflict[] }>(`/api/projects/${projectId}/submissions/${submission.id}/review`, { method: "POST", body: "{}" });
      setMessage(`审查状态：${result.submission.status}`); setConflicts(result.conflicts); await refresh();
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  };

  const compileContext = async () => {
    if (!projectId) return;
    setBusy(true); setMessage("");
    try {
      setContext(await api<ContextPack>(`/api/projects/${projectId}/context`, { method: "POST", body: JSON.stringify({ intent: "scene_generation", instruction, tokenBudget: 800 }) }));
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  };

  const resolve = async (conflictId: string, action: string) => {
    if (!projectId) return;
    setBusy(true);
    try {
      const result = await api<{ submission?: { status: string } }>(`/api/projects/${projectId}/conflicts/${conflictId}/resolve`, { method: "POST", body: JSON.stringify({ action, note: "评测台中的显式裁决" }) });
      setMessage(result.submission ? `裁决完成：${result.submission.status}` : "裁决已记录"); await refresh();
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  };

  return <main className="shell">
    <header className="topbar">
      <div className="brand"><BookOpen size={20} /><div><strong>Novel Memory</strong><span>叙事记忆评测台</span></div></div>
      <div className="project-picker"><label htmlFor="project">项目</label><select id="project" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>
    </header>
    <section className="workspace">
      <aside className="sidebar">
        <div className="section-heading"><span>项目库</span><span className="count">{projects.length}</span></div>
        <div className="create-project"><input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="新项目名称" /><button title="创建项目" onClick={() => void createProject()} disabled={busy || !projectName.trim()}><Plus size={16} /></button></div>
        <div className="project-list">{projects.map((project) => <button className={project.id === projectId ? "project active" : "project"} key={project.id} onClick={() => setProjectId(project.id)}><span>{project.name}</span><small>{project.seriesKey}</small></button>)}</div>
      </aside>
      <div className="content">
        <div className="content-heading"><div><span className="eyebrow">{currentProject?.name ?? "未选择项目"}</span><h1>记忆工作台</h1></div><button className="icon-button" title="刷新项目数据" onClick={() => void refresh()} disabled={busy}><RefreshCw size={17} /></button></div>
        <div className="grid">
          <section className="panel intake"><div className="panel-heading"><div><h2>导入与初审</h2><p>提交原文，先生成候选，再决定是否进入 Canon。</p></div><Send size={18} /></div><div className="form-row"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="提交标题" /><select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="prose">正文</option><option value="setting">设定</option><option value="outline">大纲</option></select></div><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="粘贴一段正文或设定" /><button className="primary" onClick={() => void submit()} disabled={busy || !projectId || !content.trim()}><Send size={16} />提交并初审</button></section>
          <section className="panel context"><div className="panel-heading"><div><h2>上下文调试</h2><p>结构化记忆优先，争议内容单独呈现。</p></div><Search size={18} /></div><textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} /><button className="secondary" onClick={() => void compileContext()} disabled={busy || !projectId}><Search size={16} />编译上下文</button>{context && <div className="context-result"><div className="budget">{context.tokenUsed} / {context.tokenBudget} tokens</div><ContextGroup title="硬约束" items={context.hardConstraints} /><ContextGroup title="世界状态" items={context.worldState} /><ContextGroup title="争议" items={context.disputes} danger />{context.insufficientEvidence.map((item) => <div className="notice" key={item}>{item}</div>)}</div>}</section>
        </div>
        <section className="panel records"><div className="panel-heading"><div><h2>记忆与冲突</h2><p>{memories.length} 条记忆，{conflicts.length} 个待裁决冲突。</p></div><Check size={18} /></div>{conflicts.length > 0 && <div className="conflict-list">{conflicts.map((conflict) => <div className="conflict" key={conflict.id}><AlertTriangle size={16} /><div><strong>{conflict.category} · {conflict.severity}</strong><p>{conflict.explanation}</p></div><div className="actions"><button onClick={() => void resolve(conflict.id, "intentional_coexist")}>共存</button><button onClick={() => void resolve(conflict.id, "retcon_existing")}>改线</button><button onClick={() => void resolve(conflict.id, "reject_submission")}>拒绝</button></div></div>)}</div>}
          <div className="submission-list">{submissions.map((submission) => <div className="submission-row" key={submission.id}><span className={`status status-${submission.status}`}>{submission.status}</span><strong>{submission.title}</strong><small>{submission.kind}</small><time>{new Date(submission.updatedAt).toLocaleString("zh-CN")}</time>{submission.error && <p>{submission.error}</p>}</div>)}</div>
          <div className="memory-list">{memories.map((memory) => <article className={memory.validUntil ? "memory retired" : "memory"} key={memory.id}><div className="memory-meta"><span>{memory.kind}</span><span>{memory.scope}</span>{memory.validUntil && <span>已 retcon</span>}</div><h3>{memory.subject} <em>{memory.predicate}</em> {memory.object}</h3><blockquote>{memory.spanText}</blockquote><small>{memory.sourceTitle}</small></article>)}{memories.length === 0 && <div className="empty">选择项目后，提交第一段原文。</div>}</div></section>
        {message && <div className="status-line">{message}</div>}
      </div>
    </section>
  </main>;
}

function ContextGroup({ title, items, danger = false }: { title: string; items: Array<{ text: string; quote: string }>; danger?: boolean }) {
  if (items.length === 0) return null;
  return <div className={danger ? "context-group danger" : "context-group"}><h3>{title}</h3>{items.map((item) => <div className="context-item" key={`${item.text}-${item.quote}`}><strong>{item.text}</strong><span>{item.quote}</span></div>)}</div>;
}
