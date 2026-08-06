import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  FilePlus2,
  FileText,
  FolderOpen,
  GitBranch,
  History,
  Layers3,
  Lock,
  MessageSquareText,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { formatSendFailure } from "../sendError";
import "./modern.css";

interface Project { id: string; name: string; createdAt: string; updatedAt: string }
interface Session { id: string; projectId: string; title: string; createdAt: string; updatedAt: string }
interface Message { id: string; sessionId: string; role: string; content: string; createdAt: string }
interface SourceFile { id: string; projectId: string; kind: "prose" | "setting" | "outline"; area: "draft" | "formal"; title: string; content: string; sourceFileId: string | null; sourceVersion: string | null; status: string; updatedAt: string }
interface Skill { summary: string; purpose: string; keywords: string[]; related: string[]; sourceVersion: string | null }
interface Memory { id: string; title: string; kind: "derived" | "native"; status: "draft" | "formal" | "archived"; content: string; sourceFileId: string | null; sourceVersion: string | null; basePriority: number; updatedAt: string; skill?: Skill | null }
interface Task { id: string; targetAgent: string; type: string; status: string; payload: Record<string, unknown>; result: Record<string, unknown> | null; createdAt: string }
interface Review { id: string; kind: string; status: string; content: string; targetFileId: string | null; createdAt: string }
interface PromptBlock { id?: string; name: string; enabled: boolean; pinned: boolean; role: "system" | "user" | "assistant"; position: number; depth: number; triggerScope: "always" | "chat" | "task"; content: string }
interface AgentProfile { id: string; role: string; enabled: boolean; prompt: string; promptBlocks: PromptBlock[]; modelProfile: string; updatedAt: string }
interface ModelConfig { id: string; name: string; provider: string; model: string; baseUrl: string; temperature: number; reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max"; topP: number; contextLength: number; maxOutputTokens: number; enabled: boolean; hasApiKey: boolean; updatedAt: string }
interface ContextItem { id: string; title: string; kind: string; source: string; summary: string; layer: string; fullText: boolean; relevance: number; basePriority: number }
interface ReasoningEffortErrorDetail { reasoningEffort?: string; model?: string; provider?: string; configName?: string; providerMessage?: string }
interface ChatNotice { code: string; message: string }
interface ChatResponse { userMessage: Message; session: Session; assistant: Message | null; notice: ChatNotice | null; context: ContextItem[] }
type SendMutationContext = {
  optimisticId: string;
  previous?: Message[];
  draft: string;
  projectId: string;
  sessionId: string;
  messagesKey: readonly ["modern-messages", string, string];
};

type View = "chat" | "files" | "memory" | "reviews" | "tasks" | "agents" | "models";
const agentLabels: Record<string, string> = { main: "主 Agent", writer: "正文 Agent", context: "上下文 Agent", priority: "优先级 Agent", memory_manager: "记忆文件管理 Agent", prose_review: "正文审查 Agent", logic_review: "逻辑审查 Agent" };
const kindLabels: Record<string, string> = { prose: "正文", setting: "设定", outline: "规划" };

export function ModernApp() {
  const [projectId, setProjectId] = useState(() => localStorage.getItem("novel-studio:modern-project") ?? "");
  useEffect(() => {
    if (projectId) localStorage.setItem("novel-studio:modern-project", projectId);
    else localStorage.removeItem("novel-studio:modern-project");
  }, [projectId]);
  const handleProjectDeleted = (id: string) => {
    setProjectId((current) => current === id ? "" : current);
  };
  return projectId ? <ModernWorkspace key={projectId} projectId={projectId} onBack={() => setProjectId("")} /> : <ModernLibrary onOpen={setProjectId} onProjectDeleted={handleProjectDeleted} />;
}

function ModernLibrary({ onOpen, onProjectDeleted }: { onOpen: (id: string) => void; onProjectDeleted: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const projects = useQuery({ queryKey: ["modern-projects"], queryFn: () => api<Project[]>("/api/modern/projects") });
  const create = useMutation({
    mutationFn: () => api<Project>("/api/modern/projects", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: (project) => { void queryClient.invalidateQueries({ queryKey: ["modern-projects"] }); onOpen(project.id); setName(""); setCreating(false); },
  });
  const deleteProject = useMutation({
    mutationFn: (project: Project) => api(`/api/modern/projects/${project.id}`, { method: "DELETE", body: JSON.stringify({ confirm: true }) }),
    onSuccess: (_, project) => {
      onProjectDeleted(project.id);
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: ["modern-projects"] });
    },
  });
  return <main className="modern-library">
    <header className="modern-library-header">
      <div className="modern-brand"><span className="modern-brand-mark"><BookOpen size={21} /></span><div><strong>Novel Studio</strong><small>长篇写作工作台</small></div></div>
      <div className="modern-library-actions"><button className="modern-button ghost"><Archive size={15} />导入项目</button><button className="modern-button solid" onClick={() => setCreating(true)}><Plus size={15} />新建作品</button></div>
    </header>
    <section className="modern-library-content">
      <div className="modern-section-head"><div><span className="modern-eyebrow">PROJECTS</span><h1>作品库</h1><p>{projects.data?.length ?? 0} 部作品</p></div><Layers3 size={20} /></div>
      {projects.isLoading && <div className="modern-empty"><span className="modern-spinner" />读取作品库</div>}
      {projects.error && <div className="modern-alert error"><CircleAlert size={15} />{projects.error.message}</div>}
      {!projects.isLoading && projects.data?.length === 0 && <div className="modern-empty large"><FolderOpen size={38} /><strong>还没有作品</strong><span>新建作品后，主 Agent 会成为你的唯一入口。</span><button className="modern-button solid" onClick={() => setCreating(true)}><FilePlus2 size={15} />创建第一部作品</button></div>}
      <div className="modern-project-grid">{projects.data?.map((project) => (
        <div className="modern-project-card" key={project.id}>
          <button type="button" className="modern-project-card-open" onClick={() => onOpen(project.id)}>
            <span className="modern-project-icon"><BookOpen size={22} /></span>
            <span><strong>{project.name}</strong><small>本地项目 · {new Date(project.updatedAt).toLocaleDateString("zh-CN")}</small></span>
            <ChevronRight size={17} />
          </button>
          <button type="button" className="modern-icon-button danger modern-project-delete" title="删除作品" aria-label={`删除作品 ${project.name}`} disabled={deleteProject.isPending && deleting?.id === project.id} onClick={() => setDeleting(project)}><Trash2 size={15} /></button>
        </div>
      ))}</div>
    </section>
    {creating && <div className="modern-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreating(false); }}><form className="modern-modal" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><header><div><span className="modern-eyebrow">NEW PROJECT</span><h2>新建作品</h2><p>先建立隔离边界，其他内容可以在对话中逐步形成。</p></div><button type="button" className="modern-icon-button" onClick={() => setCreating(false)}><X size={17} /></button></header><label className="modern-field"><span>作品名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：雾城档案" required /></label>{create.error && <div className="modern-alert error">{create.error.message}</div>}<footer><button type="button" className="modern-button ghost" onClick={() => setCreating(false)}>取消</button><button className="modern-button solid" disabled={create.isPending || !name.trim()}>{create.isPending ? "创建中" : "创建作品"}</button></footer></form></div>}
    {deleting && <div className="modern-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleteProject.isPending) setDeleting(null); }}>
      <div className="modern-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title">
        <header><div><span className="modern-eyebrow">DELETE PROJECT</span><h2 id="delete-project-title">删除作品</h2><p>将删除该作品的资料、记忆、会话、任务和审查记录，且无法撤销。</p></div><button type="button" className="modern-icon-button" title="取消删除" disabled={deleteProject.isPending} onClick={() => setDeleting(null)}><X size={17} /></button></header>
        <div className="modern-delete-target"><strong>{deleting.name}</strong><span>本地项目 · {new Date(deleting.updatedAt).toLocaleDateString("zh-CN")}</span></div>
        {deleteProject.error && <div className="modern-alert error"><CircleAlert size={15} />{deleteProject.error.message}</div>}
        <footer><button type="button" className="modern-button ghost" disabled={deleteProject.isPending} onClick={() => setDeleting(null)}>取消</button><button type="button" className="modern-button solid modern-delete-confirm" disabled={deleteProject.isPending} onClick={() => deleteProject.mutate(deleting)}>{deleteProject.isPending ? "删除中" : "确认删除"}</button></footer>
      </div>
    </div>}
  </main>;
}

function ModernWorkspace({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("chat");
  const [sessionId, setSessionId] = useState("");
  const [reasoningEffortError, setReasoningEffortError] = useState<ApiError | null>(null);
  const [deletingSession, setDeletingSession] = useState<Session | null>(null);
  const project = useQuery({ queryKey: ["modern-project", projectId], queryFn: () => api<Project>(`/api/modern/projects/${projectId}`) });
  const sessions = useQuery({ queryKey: ["modern-sessions", projectId], queryFn: () => api<Session[]>(`/api/modern/projects/${projectId}/sessions`) });
  const createSession = useMutation({
    mutationFn: () => api<Session>(`/api/modern/projects/${projectId}/sessions`, { method: "POST", body: JSON.stringify({ title: "新会话" }) }),
    onSuccess: (session) => {
      queryClient.setQueryData<Session[]>(["modern-sessions", projectId], (old) => [session, ...(old ?? []).filter((entry) => entry.id !== session.id)]);
      setSessionId(session.id);
      void queryClient.invalidateQueries({ queryKey: ["modern-sessions", projectId] });
      setView("chat");
    },
  });
  const deleteSession = useMutation({
    mutationFn: (session: Session) => api(`/api/modern/projects/${projectId}/sessions/${session.id}`, { method: "DELETE", body: JSON.stringify({ confirm: true }) }),
    onSuccess: (_, session) => {
      const remaining = (sessions.data ?? []).filter((entry) => entry.id !== session.id);
      setSessionId((current) => current === session.id ? (remaining[0]?.id ?? "") : current);
      setDeletingSession(null);
      void queryClient.invalidateQueries({ queryKey: ["modern-sessions", projectId] });
    },
  });
  useEffect(() => { if (!sessionId && sessions.data?.[0]) setSessionId(sessions.data[0].id); }, [sessionId, sessions.data]);
  useEffect(() => {
    if (sessionId && sessions.data && !sessions.data.some((session) => session.id === sessionId)) {
      setSessionId(sessions.data[0]?.id ?? "");
    }
  }, [sessionId, sessions.data]);
  const nav: Array<{ id: View; label: string; icon: typeof MessageSquareText }> = [
    { id: "chat", label: "主 Agent", icon: MessageSquareText }, { id: "files", label: "项目资料", icon: FileText }, { id: "memory", label: "AI 记忆", icon: Brain }, { id: "reviews", label: "审查记录", icon: ShieldCheck }, { id: "tasks", label: "任务运行", icon: History }, { id: "agents", label: "Agent 设置", icon: Bot }, { id: "models", label: "模型配置", icon: SlidersHorizontal },
  ];
  if (project.isLoading || sessions.isLoading) return <div className="modern-loading"><BookOpen size={26} /><span>打开工作区</span></div>;
  if (project.error || !project.data) return <div className="modern-loading"><CircleAlert size={26} /><span>无法打开作品</span><button className="modern-button ghost" onClick={onBack}>返回作品库</button></div>;
  return <main className="modern-workspace">
    <aside className="modern-sidebar"><header className="modern-sidebar-brand"><button className="modern-icon-button" title="返回作品库" onClick={onBack}><ArrowLeft size={17} /></button><span className="modern-brand-mark small"><BookOpen size={17} /></span><strong>Novel Studio</strong></header><div className="modern-project-identity"><span className="modern-eyebrow">PROJECT</span><h1>{project.data.name}</h1><span className="modern-local-status"><i />本地已连接</span></div><nav className="modern-nav">{nav.map((item) => { const Icon = item.icon; return <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><Icon size={16} />{item.label}</button>; })}</nav>{view === "chat" && <section className="modern-session-list"><div className="modern-subhead"><span>会话</span><button className="modern-icon-button" title="新建会话" onClick={() => createSession.mutate()}><Plus size={15} /></button></div>{sessions.data?.map((session) => <div className="modern-session-row" key={session.id}><button type="button" className={session.id === sessionId ? "modern-session-open active" : "modern-session-open"} onClick={() => setSessionId(session.id)}><MessageSquareText size={14} /><span>{session.title || "未命名会话"}</span></button><button type="button" className="modern-icon-button danger modern-session-delete" title="删除会话" aria-label={`删除会话 ${session.title || "未命名会话"}`} disabled={deleteSession.isPending && deletingSession?.id === session.id} onClick={() => setDeletingSession(session)}><Trash2 size={13} /></button></div>)}</section>}<footer className="modern-sidebar-footer"><span><TerminalSquare size={14} />本地数据隔离</span><small>每个作品拥有独立上下文</small></footer></aside>
    <section className="modern-main"><header className="modern-topbar"><div><span className="modern-eyebrow">{nav.find((item) => item.id === view)?.label}</span><h2>{view === "chat" ? "和主 Agent 讨论" : nav.find((item) => item.id === view)?.label}</h2></div><div className="modern-top-actions"><button className="modern-icon-button" title="搜索" onClick={() => setView("files")}><Search size={17} /></button><span className="modern-command"><Sparkles size={14} />现代纵切</span></div></header>{view === "chat" && sessionId && <ChatPane projectId={projectId} sessionId={sessionId} onReasoningEffortError={setReasoningEffortError} onOpenSettings={(target) => setView(target)} />}{view === "chat" && !sessionId && <div className="modern-pane"><div className="modern-empty large"><MessageSquareText size={34} /><strong>还没有会话</strong><span>新建一个会话开始讨论。</span><button className="modern-button solid" onClick={() => createSession.mutate()}><Plus size={15} />新建会话</button></div></div>}{view === "files" && <FilesPane projectId={projectId} />}{view === "memory" && <MemoryPane projectId={projectId} />}{view === "reviews" && <ReviewsPane projectId={projectId} />}{view === "tasks" && <TasksPane projectId={projectId} />}{view === "agents" && <AgentsPane projectId={projectId} />}{view === "models" && <ModelsPane />}</section>
    {reasoningEffortError && <div className="modern-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setReasoningEffortError(null); }}>
      <div className="modern-modal" role="alertdialog" aria-modal="true" aria-labelledby="reasoning-error-title">
        <header><div><span className="modern-eyebrow">MODEL COMPATIBILITY</span><h2 id="reasoning-error-title">推理强度不受支持</h2><p>当前模型配置无法使用所选推理强度，请调整模型配置后再继续。</p></div><button type="button" className="modern-icon-button" title="关闭" onClick={() => setReasoningEffortError(null)}><X size={17} /></button></header>
        <div className="modern-reasoning-detail">
          <span>推理强度：{((reasoningEffortError.detail as ReasoningEffortErrorDetail | undefined)?.reasoningEffort) ?? "未知"}</span>
          <span>模型配置：{((reasoningEffortError.detail as ReasoningEffortErrorDetail | undefined)?.configName ?? (reasoningEffortError.detail as ReasoningEffortErrorDetail | undefined)?.model) ?? "未知"}</span>
          {(reasoningEffortError.detail as ReasoningEffortErrorDetail | undefined)?.providerMessage && <small>供应商信息：{(reasoningEffortError.detail as ReasoningEffortErrorDetail).providerMessage}</small>}
        </div>
        <footer><button type="button" className="modern-button ghost" onClick={() => setReasoningEffortError(null)}>知道了</button><button type="button" className="modern-button solid" onClick={() => { setReasoningEffortError(null); setView("models"); }}>调整模型配置</button></footer>
      </div>
    </div>}
    {deletingSession && <div className="modern-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleteSession.isPending) setDeletingSession(null); }}>
      <div className="modern-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-session-title">
        <header><div><span className="modern-eyebrow">DELETE SESSION</span><h2 id="delete-session-title">删除会话</h2><p>将删除该会话中的消息记录，且无法撤销。</p></div><button type="button" className="modern-icon-button" title="取消删除" disabled={deleteSession.isPending} onClick={() => setDeletingSession(null)}><X size={17} /></button></header>
        <div className="modern-delete-target"><strong>{deletingSession.title || "未命名会话"}</strong><span>会话内的消息将被删除</span></div>
        {deleteSession.error && <div className="modern-alert error"><CircleAlert size={15} />{deleteSession.error.message}</div>}
        <footer><button type="button" className="modern-button ghost" disabled={deleteSession.isPending} onClick={() => setDeletingSession(null)}>取消</button><button type="button" className="modern-button solid modern-delete-confirm" disabled={deleteSession.isPending} onClick={() => deleteSession.mutate(deletingSession)}>{deleteSession.isPending ? "删除中" : "确认删除"}</button></footer>
      </div>
    </div>}
  </main>;
}

function ChatPane({ projectId, sessionId, onReasoningEffortError, onOpenSettings }: { projectId: string; sessionId: string; onReasoningEffortError: (error: ApiError) => void; onOpenSettings: (target: "agents" | "models") => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [context, setContext] = useState<ContextItem[]>([]);
  const [configNotice, setConfigNotice] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingSessionIds, setPendingSessionIds] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = useQuery({
    queryKey: ["modern-messages", projectId, sessionId],
    queryFn: () => api<Message[]>(`/api/modern/projects/${projectId}/sessions/${sessionId}/messages`),
    staleTime: pendingSessionIds.has(sessionId) ? Infinity : undefined,
    refetchOnWindowFocus: pendingSessionIds.has(sessionId) ? false : undefined,
  });
  const tasks = useQuery({ queryKey: ["modern-tasks", projectId], queryFn: () => api<Task[]>(`/api/modern/projects/${projectId}/tasks`) });
  const models = useQuery({ queryKey: ["modern-models"], queryFn: () => api<ModelConfig[]>("/api/modern/models") });
  const messagesKey = ["modern-messages", projectId, sessionId] as const;
  useEffect(() => {
    setText("");
    setContext([]);
    setConfigNotice(null);
    setSendError(null);
  }, [sessionId]);
  const send = useMutation({
    mutationFn: (content: string) => api<ChatResponse>(`/api/modern/projects/${projectId}/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
    onMutate: async (content) => {
      setPendingSessionIds((current) => new Set(current).add(sessionId));
      setText("");
      setConfigNotice(null);
      setSendError(null);
      await queryClient.cancelQueries({ queryKey: messagesKey });
      const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const optimistic: Message = {
        id: optimisticId,
        sessionId,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      };
      const previous = queryClient.getQueryData<Message[]>(messagesKey);
      queryClient.setQueryData<Message[]>(messagesKey, (old) => [...(old ?? []), optimistic]);
      return { optimisticId, previous, draft: content, projectId, sessionId, messagesKey };
    },
    onSuccess: (result, _content, context) => {
      const key = context?.messagesKey ?? messagesKey;
      const persistedIds = new Set<string>([result.userMessage.id, result.assistant?.id].filter((id): id is string => Boolean(id)));
      queryClient.setQueryData<Message[]>(key, (old) => {
        const remaining = (old ?? []).filter((message) => message.id !== context?.optimisticId && !persistedIds.has(message.id));
        return [...remaining, result.userMessage, ...(result.assistant ? [result.assistant] : [])];
      });
      if (context?.projectId && result.session) {
        queryClient.setQueryData<Session[]>(["modern-sessions", context.projectId], (old) => (old ?? []).map((session) => session.id === result.session.id ? result.session : session));
      }
      if (context?.sessionId === sessionId) {
        setContext(result.context);
        setConfigNotice(result.notice?.code === "model_not_configured" ? result.notice.message : null);
        setSendError(null);
      }
      if (context?.sessionId) setPendingSessionIds((current) => { const next = new Set(current); next.delete(context.sessionId!); return next; });
    },
    onError: async (error, _content, context) => {
      const key = context?.messagesKey ?? messagesKey;
      queryClient.setQueryData<Message[]>(key, (old) => (old ?? []).filter((message) => message.id !== context?.optimisticId));
      if (context?.sessionId) setPendingSessionIds((current) => { const next = new Set(current); next.delete(context.sessionId!); return next; });
      if (error instanceof ApiError && error.code === "reasoning_effort_unsupported") {
        if (context?.sessionId === sessionId) {
          setText((current) => current.trim() ? current : (context?.draft ?? ""));
        }
        onReasoningEffortError(error);
        return;
      }
      await queryClient.refetchQueries({ queryKey: key });
      if (context?.sessionId === sessionId) {
        const persisted = queryClient.getQueryData<Message[]>(key)?.some((message) => message.role === "user" && message.content === context?.draft) ?? false;
        setText((current) => current.trim() ? current : (persisted ? "" : (context?.draft ?? "")));
        setSendError(formatSendFailure(error, persisted));
      }
      void queryClient.invalidateQueries({ queryKey: ["modern-sessions", context?.projectId ?? projectId] });
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context?.sessionId) setPendingSessionIds((current) => { const next = new Set(current); next.delete(context.sessionId!); return next; });
      void queryClient.invalidateQueries({ queryKey: ["modern-tasks", context?.projectId ?? projectId] });
    },
  });
  const sending = send.isPending && pendingSessionIds.has(sessionId);
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.data?.length, sessionId, sending]);
  const activeTasks = tasks.data?.filter((task) => task.status === "running" || task.status === "queued").slice(0, 4) ?? [];
  const hasModelConfigs = Boolean(models.data?.length);
  const noticeText = models.isSuccess
    ? hasModelConfigs
      ? "主 Agent 尚未绑定模型，请到 Agent 设置完成绑定。"
      : "还没有模型配置，请先创建模型配置。"
    : "请先为「主 Agent」配置模型，再继续对话。";
  const noticeTarget = models.isSuccess && hasModelConfigs ? "agents" : "models";
  const noticeAction = models.isSuccess && hasModelConfigs ? "去绑定" : "去配置";
  return <div className="modern-chat-layout"><section className="modern-chat"><div className="modern-chat-scroll" ref={scrollRef}>{messages.data?.length === 0 && <div className="modern-chat-empty"><span className="modern-chat-orb"><Sparkles size={22} /></span><h3>从一句话开始</h3><p>主 Agent 会先理解你的意图，再决定是否调用正文、审查或记忆相关 Agent。</p></div>}{messages.data?.map((message) => <article key={message.id} className={`modern-message ${message.role === "user" ? "user" : "agent"}`}><div className="modern-message-meta"><span>{message.role === "user" ? "你" : "主 Agent"}</span><time>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div><div className="modern-message-body">{message.content}</div></article>)}</div>{configNotice && <div className="modern-notice" role="status"><CircleAlert size={14} /><span>{noticeText}</span><button type="button" className="modern-button ghost" onClick={() => onOpenSettings(noticeTarget)}>{noticeAction}</button><button type="button" className="modern-icon-button" title="关闭提示" aria-label="关闭配置提示" onClick={() => setConfigNotice(null)}><X size={15} /></button></div>}{sending && <div className="modern-processing" role="status" aria-live="polite"><span className="modern-spinner" />正在整理上下文并生成回复，请勿重复发送</div>}{sendError && <div className="modern-alert error modern-send-error" role="alert"><CircleAlert size={15} /><span>发送失败：{sendError}</span>{text.trim() && <button type="button" className="modern-button ghost" onClick={() => send.mutate(text.trim())}>重试</button>}<button type="button" className="modern-icon-button" title="关闭错误" aria-label="关闭发送错误" onClick={() => setSendError(null)}><X size={15} /></button></div>}<form className="modern-composer" onSubmit={(event) => { event.preventDefault(); if (text.trim() && !sending) send.mutate(text.trim()); }}><textarea disabled={sending} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (sending) { event.preventDefault(); return; } if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="告诉主 Agent 你想讨论、规划或修改什么…" rows={3} /><footer><span>Enter 发送 · Shift Enter 换行</span><button className="modern-send" disabled={!text.trim() || sending} title="发送"><Send size={16} /></button></footer></form></section><aside className="modern-inspector"><div className="modern-inspector-head"><div><span className="modern-eyebrow">CONTEXT GATE</span><h3>本轮记忆</h3></div><Brain size={17} /></div>{sending && <div className="modern-inspector-loading"><span className="modern-spinner" />上下文 Agent 正在筛选</div>}{context.length > 0 ? <div className="modern-context-list">{context.map((item) => <div className="modern-context-item" key={item.id}><span className={`modern-layer-dot ${item.layer}`} /><div><strong>{item.title}</strong><small>{item.layer} · {item.fullText ? "已读正文" : "简介卡"}</small></div></div>)}</div> : <div className="modern-inspector-empty">发送消息后，这里会显示本轮被选中的记忆和资料。</div>}{activeTasks.length > 0 && <div className="modern-task-strip"><span className="modern-eyebrow">RUNNING</span>{activeTasks.map((task) => <div key={task.id}><span className="modern-status-dot" /><span>{agentLabels[task.targetAgent] ?? task.targetAgent}</span></div>)}</div>}</aside></div>;
}

function FilesPane({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [area, setArea] = useState<"draft" | "formal">("draft");
  const [kind, setKind] = useState<"all" | "prose" | "setting" | "outline">("all");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<SourceFile | null>(null);
  const [form, setForm] = useState({ kind: "setting" as SourceFile["kind"], title: "", content: "" });
  const sources = useQuery({ queryKey: ["modern-sources", projectId, area, kind], queryFn: () => api<SourceFile[]>(`/api/modern/projects/${projectId}/sources?area=${area}${kind === "all" ? "" : `&kind=${kind}`}`) });
  const create = useMutation({ mutationFn: () => api<SourceFile>(`/api/modern/projects/${projectId}/sources`, { method: "POST", body: JSON.stringify({ ...form, area }) }), onSuccess: (file) => { setCreating(false); setForm({ kind: "setting", title: "", content: "" }); setSelected(file); void queryClient.invalidateQueries({ queryKey: ["modern-sources", projectId] }); } });
  const promote = useMutation({ mutationFn: (fileId: string) => api(`/api/modern/projects/${projectId}/sources/${fileId}/promote`, { method: "POST", body: JSON.stringify({}) }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["modern-sources", projectId] }); void queryClient.invalidateQueries({ queryKey: ["modern-memory", projectId] }); } });
  return <div className="modern-pane"><header className="modern-pane-head"><div><span className="modern-eyebrow">SOURCE MATERIAL</span><h3>项目资料</h3><p>人类可读的正文、设定和规划，和 AI 记忆分开保存。</p></div><button className="modern-button solid" onClick={() => setCreating(true)}><Plus size={15} />新建文件</button></header><div className="modern-toolbar"><div className="modern-segmented"><button className={area === "draft" ? "active" : ""} onClick={() => setArea("draft")}>草稿</button><button className={area === "formal" ? "active" : ""} onClick={() => setArea("formal")}>正式</button></div><select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="all">全部类型</option><option value="prose">正文</option><option value="setting">设定</option><option value="outline">规划</option></select></div><div className="modern-file-layout"><div className="modern-file-list">{sources.data?.length === 0 && <div className="modern-list-empty">这里还没有{area === "draft" ? "草稿" : "正式资料"}。</div>}{sources.data?.map((file) => <button key={file.id} className={selected?.id === file.id ? "active" : ""} onClick={() => setSelected(file)}><span className="modern-file-kind">{kindLabels[file.kind]}</span><span><strong>{file.title}</strong><small>{file.content.length.toLocaleString()} 字 · {new Date(file.updatedAt).toLocaleDateString("zh-CN")}</small></span><ChevronRight size={15} /></button>)}</div><div className="modern-file-preview">{selected ? <><div className="modern-preview-head"><div><span className="modern-file-kind">{kindLabels[selected.kind]} · {selected.area === "draft" ? "草稿" : "正式"}</span><h4>{selected.title}</h4></div>{selected.area === "draft" && <button className="modern-button ghost" disabled={promote.isPending} onClick={() => { if (window.confirm("先完成初审并生成 AI 记忆，再转入正式区？")) promote.mutate(selected.id); }}><GitBranch size={14} />转为正式</button>}</div><pre className="modern-file-content">{selected.content || "（空文件）"}</pre>{promote.error && <div className="modern-alert error">{promote.error.message}</div>}</> : <div className="modern-preview-empty"><FileText size={26} /><span>选择一个文件查看内容</span></div>}</div></div>{creating && <div className="modern-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreating(false); }}><form className="modern-modal wide" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><header><div><span className="modern-eyebrow">SOURCE FILE</span><h2>新建资料</h2></div><button type="button" className="modern-icon-button" onClick={() => setCreating(false)}><X size={17} /></button></header><div className="modern-form-grid"><label className="modern-field"><span>类型</span><select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as SourceFile["kind"] })}><option value="setting">设定</option><option value="outline">规划</option><option value="prose">正文</option></select></label><label className="modern-field"><span>标题</span><input autoFocus value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required /></label></div><label className="modern-field"><span>内容</span><textarea rows={12} value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} /></label><footer><button type="button" className="modern-button ghost" onClick={() => setCreating(false)}>取消</button><button className="modern-button solid" disabled={create.isPending}>{create.isPending ? "保存中" : "保存草稿"}</button></footer></form></div>}</div>;
}

function MemoryPane({ projectId }: { projectId: string }) {
  const [selectedId, setSelectedId] = useState("");
  const memory = useQuery({ queryKey: ["modern-memory", projectId], queryFn: () => api<Array<Memory>>(`/api/modern/projects/${projectId}/memory`) });
  const selected = memory.data?.find((entry) => entry.id === selectedId) ?? memory.data?.[0];
  return <div className="modern-pane"><header className="modern-pane-head"><div><span className="modern-eyebrow">AI MEMORY</span><h3>AI 记忆后台</h3><p>这里展示面向模型的精简记忆、skill 和来源关系，不直接编辑正文。</p></div><div className="modern-readonly"><ShieldCheck size={14} />只读查看</div></header><div className="modern-memory-layout"><div className="modern-memory-list">{memory.data?.length === 0 && <div className="modern-list-empty">还没有正式记忆。</div>}{memory.data?.map((entry) => <button key={entry.id} className={selected?.id === entry.id ? "active" : ""} onClick={() => setSelectedId(entry.id)}><span className={`modern-memory-status ${entry.status}`} /><span><strong>{entry.title}</strong><small>{entry.kind === "derived" ? "派生记忆" : "原生记忆"} · P{Math.round((1 - entry.basePriority) * 3 + 1)}</small></span></button>)}</div><div className="modern-memory-detail">{selected ? <><div className="modern-detail-head"><div><span className="modern-eyebrow">MEMORY ENTRY</span><h4>{selected.title}</h4></div><span className="modern-priority">基础优先级 {selected.basePriority.toFixed(2)}</span></div><div className="modern-memory-block"><span>记忆正文</span><p>{selected.content}</p></div><div className="modern-memory-block"><span>记忆 skill</span><p>{selected.skill?.summary || "暂无简介卡"}</p><small>{selected.skill?.purpose || ""}</small><div className="modern-tags">{selected.skill?.keywords.map((keyword) => <i key={keyword}>{keyword}</i>)}</div></div><div className="modern-source-link"><GitBranch size={14} />来源版本：{selected.sourceVersion || "原生记忆"}</div></> : <div className="modern-preview-empty"><Brain size={26} /><span>选择一条记忆</span></div>}</div></div></div>;
}

function ReviewsPane({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const reviews = useQuery({ queryKey: ["modern-reviews", projectId], queryFn: () => api<Review[]>(`/api/modern/projects/${projectId}/reviews`) });
  const request = useMutation({ mutationFn: () => api(`/api/modern/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify({ targetAgent: "logic_review", type: "manual_logic_review", payload: { scope: "project" } }) }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["modern-tasks", projectId] }) });
  const resolve = useMutation({ mutationFn: (reportId: string) => api(`/api/modern/projects/${projectId}/reviews/${reportId}`, { method: "PATCH", body: JSON.stringify({ status: "resolved" }) }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["modern-reviews", projectId] }) });
  return <div className="modern-pane"><header className="modern-pane-head"><div><span className="modern-eyebrow">REVIEW LOG</span><h3>审查记录</h3><p>逻辑审查按需运行；正文审查作为正文任务的后置步骤。</p></div><button className="modern-button solid" onClick={() => request.mutate()}><ShieldCheck size={15} />发起逻辑审查</button></header><div className="modern-review-list">{reviews.data?.length === 0 && <div className="modern-list-empty">暂时没有未解决的审查报告。</div>}{reviews.data?.map((review) => <article className="modern-review-card" key={review.id}><header><span className={`modern-review-status ${review.status}`}>{review.status}</span><span>{review.kind === "logic" ? "逻辑审查" : review.kind === "fidelity" ? "记忆忠实度" : "正文审查"}</span><time>{new Date(review.createdAt).toLocaleString("zh-CN")}</time><button className="modern-icon-button" title="标记为已解决" onClick={() => resolve.mutate(review.id)} disabled={resolve.isPending}><Check size={15} /></button></header><p>{review.content || "报告尚未写入详细内容。"}</p></article>)}</div></div>;
}

function TasksPane({ projectId }: { projectId: string }) {
  const tasks = useQuery({ queryKey: ["modern-tasks", projectId], queryFn: () => api<Task[]>(`/api/modern/projects/${projectId}/tasks`) });
  return <div className="modern-pane"><header className="modern-pane-head"><div><span className="modern-eyebrow">RUN LOG</span><h3>任务运行</h3><p>主 Agent拆出的任务、上下文选择和优先级结果都会留在这里。</p></div><History size={18} /></header><div className="modern-task-table"><div className="modern-task-row head"><span>Agent</span><span>任务</span><span>状态</span><span>时间</span></div>{tasks.data?.map((task) => <div className="modern-task-row" key={task.id}><span><Bot size={14} />{agentLabels[task.targetAgent] ?? task.targetAgent}</span><span>{task.type}</span><span><i className={`modern-status-dot ${task.status}`} />{task.status}</span><time>{new Date(task.createdAt).toLocaleTimeString("zh-CN")}</time></div>)}</div></div>;
}

function AgentsPane({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const models = useQuery({ queryKey: ["modern-models"], queryFn: () => api<ModelConfig[]>("/api/modern/models") });
  const agents = useQuery({ queryKey: ["modern-agents", projectId], queryFn: () => api<AgentProfile[]>(`/api/modern/projects/${projectId}/agents`) });
  const prompts = useQuery({ queryKey: ["modern-agent-prompts", projectId], queryFn: () => api<Record<string, PromptBlock[]>>(`/api/modern/projects/${projectId}/agents/prompts`) });
  const [drafts, setDrafts] = useState<Record<string, { enabled: boolean; modelProfile: string; promptBlocks: PromptBlock[] }>>({});
  const initialized = useRef(false);
  useEffect(() => {
    initialized.current = false;
    setDrafts({});
  }, [projectId]);
  useEffect(() => {
    if (initialized.current || !prompts.data || !agents.data) return;
    initialized.current = true;
    const next: Record<string, { enabled: boolean; modelProfile: string; promptBlocks: PromptBlock[] }> = {};
    for (const role of Object.keys(agentLabels)) {
      const profile = agents.data?.find((agent) => agent.role === role);
      next[role] = {
        enabled: profile?.enabled ?? true,
        modelProfile: profile?.modelProfile ?? "",
        promptBlocks: (prompts.data[role] ?? []).map((block) => ({ ...block })),
      };
    }
    setDrafts(next);
  }, [agents.data, prompts.data]);
  const save = useMutation({
    mutationFn: (role: string) => {
      const draft = drafts[role] ?? { enabled: true, modelProfile: "", promptBlocks: [] as PromptBlock[] };
      return api<AgentProfile>(`/api/modern/projects/${projectId}/agents/${role}`, {
        method: "PUT",
        body: JSON.stringify({
          enabled: draft.enabled,
          modelProfile: draft.modelProfile,
          promptBlocks: draft.promptBlocks.map((block) => ({
            id: block.id || undefined,
            name: block.name,
            enabled: block.enabled,
            pinned: block.pinned,
            role: block.role,
            position: block.position,
            depth: block.depth,
            triggerScope: block.triggerScope,
            content: block.content,
          })),
        }),
      });
    },
    onSuccess: (profile, role) => {
      setDrafts((current) => {
        const draft = current[role] ?? { enabled: true, modelProfile: "", promptBlocks: [] as PromptBlock[] };
        return {
          ...current,
          [role]: {
            enabled: profile.enabled,
            modelProfile: profile.modelProfile,
            promptBlocks: profile.promptBlocks.map((block) => ({ ...block })),
          },
        };
      });
      void queryClient.invalidateQueries({ queryKey: ["modern-agents", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["modern-agent-prompts", projectId] });
    },
  });
  const normalizePositions = (blocks: PromptBlock[]) => {
    const counts = new Map<number, number>();
    return blocks.map((block) => {
      const position = counts.get(block.depth) ?? 0;
      counts.set(block.depth, position + 1);
      return { ...block, position };
    });
  };
  const patchAgent = (role: string, patch: Partial<{ enabled: boolean; modelProfile: string; promptBlocks: PromptBlock[] }>) => {
    setDrafts((current) => {
      const draft = current[role] ?? { enabled: true, modelProfile: "", promptBlocks: [] as PromptBlock[] };
      return { ...current, [role]: { ...draft, ...patch } as { enabled: boolean; modelProfile: string; promptBlocks: PromptBlock[] } };
    });
  };
  const patchBlock = (role: string, index: number, patch: Partial<PromptBlock>) => {
    setDrafts((current) => {
      const draft = current[role];
      if (!draft) return current;
      const blocks = draft.promptBlocks.map((block, blockIndex) => blockIndex === index ? { ...block, ...patch } : block);
      return { ...current, [role]: { ...draft, promptBlocks: blocks } };
    });
  };
  const moveBlock = (role: string, index: number, delta: number) => {
    setDrafts((current) => {
      const draft = current[role];
      if (!draft) return current;
      const blocks = [...draft.promptBlocks];
      const target = index + delta;
      if (target < 0 || target >= blocks.length) return current;
      const currentBlock = blocks[index]!;
      const targetBlock = blocks[target]!;
      blocks[index] = targetBlock;
      blocks[target] = currentBlock;
      return { ...current, [role]: { ...draft, promptBlocks: normalizePositions(blocks) } };
    });
  };
  const removeBlock = (role: string, index: number) => {
    setDrafts((current) => {
      const draft = current[role];
      if (!draft) return current;
      const blocks = draft.promptBlocks.filter((block, blockIndex) => blockIndex !== index);
      return { ...current, [role]: { ...draft, promptBlocks: normalizePositions(blocks) } };
    });
  };
  const addBlock = (role: string) => {
    setDrafts((current) => {
      const draft = current[role];
      if (!draft) return current;
      const blocks = [...draft.promptBlocks, {
        name: `提示块 ${draft.promptBlocks.length + 1}`,
        enabled: true,
        pinned: false,
        role: "system" as const,
        position: draft.promptBlocks.length,
        depth: 0,
        triggerScope: "always" as const,
        content: "",
      }];
      return { ...current, [role]: { ...draft, promptBlocks: normalizePositions(blocks) } };
    });
  };
  return (
    <div className="modern-pane">
      <header className="modern-pane-head">
        <div>
          <span className="modern-eyebrow">AGENT PROMPT BLOCKS</span>
          <h3>Agent 设置</h3>
          <p>每个 Agent 的提示词按顺序由可编辑块组成；默认块不可删除，但可以编辑或停用。运行时按 深度 → 位置 → 创建时间 的确定性顺序组装。</p>
        </div>
        <Bot size={19} />
      </header>
      <div className="modern-agent-list">
        {Object.keys(agentLabels).map((role) => {
          const draft = drafts[role] ?? { enabled: true, modelProfile: "", promptBlocks: [] as PromptBlock[] };
          return (
            <article className="modern-agent-card" key={role}>
              <header>
                <div>
                  <strong>{agentLabels[role]}</strong>
                  <small>{role === "main" ? "唯一用户入口" : role === "context" || role === "priority" ? "后台记忆链路" : "执行角色"} · {draft.promptBlocks.filter((block) => block.enabled).length}/{draft.promptBlocks.length} 块启用</small>
                </div>
                <label className="modern-toggle" title="启用该 Agent">
                  <input type="checkbox" checked={draft.enabled} onChange={(event) => patchAgent(role, { enabled: event.target.checked })} />
                  <span />
                </label>
              </header>
              <label className="modern-field">
                <span>使用的模型配置</span>
                <select value={draft.modelProfile} onChange={(event) => patchAgent(role, { modelProfile: event.target.value })}>
                  <option value="">未绑定</option>
                  {models.data?.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
              </label>
              <div className="modern-prompt-blocks">
                <div className="modern-prompt-block-head"><span>提示词块</span><small>名称 / 角色 / 触发 / 深度 · 内容按列表顺序编排</small></div>
                {draft.promptBlocks.map((block, index) => (
                  <div className={`modern-prompt-block${block.pinned ? " pinned" : ""}${block.enabled ? "" : " disabled"}`} key={block.id ?? `${role}-new-${index}`}>
                    <div className="modern-prompt-block-row">
                      <label className="modern-toggle" title={block.pinned ? "固定块不可删除，但可以停用" : "启用该块"}>
                        <input type="checkbox" checked={block.enabled} onChange={(event) => patchBlock(role, index, { enabled: event.target.checked })} />
                        <span />
                      </label>
                      <span className="modern-pin-slot">{block.pinned && <Lock size={13} className="modern-pin-icon" aria-label="默认提示块" />}</span>
                      <input className="modern-prompt-name" value={block.name} onChange={(event) => patchBlock(role, index, { name: event.target.value })} aria-label="提示块名称" />
                      <select value={block.role} onChange={(event) => patchBlock(role, index, { role: event.target.value as PromptBlock["role"] })} aria-label="消息角色">
                        <option value="system">system</option>
                        <option value="user">user</option>
                        <option value="assistant">assistant</option>
                      </select>
                      <select value={block.triggerScope} onChange={(event) => patchBlock(role, index, { triggerScope: event.target.value as PromptBlock["triggerScope"] })} aria-label="触发范围">
                        <option value="always">始终</option>
                        <option value="chat">会话</option>
                        <option value="task">任务</option>
                      </select>
                      <label className="modern-depth-field"><span>深度</span><input type="number" min="0" max="10000" value={block.depth} onChange={(event) => patchBlock(role, index, { depth: Number(event.target.value) })} /></label>
                      <div className="modern-block-actions">
                        <button type="button" className="modern-icon-button" title="上移" disabled={index === 0} onClick={() => moveBlock(role, index, -1)}><ArrowUp size={13} /></button>
                        <button type="button" className="modern-icon-button" title="下移" disabled={index === draft.promptBlocks.length - 1} onClick={() => moveBlock(role, index, 1)}><ArrowDown size={13} /></button>
                        <button type="button" className="modern-icon-button danger" title={block.pinned ? "固定块不能删除" : "删除"} disabled={block.pinned} onClick={() => removeBlock(role, index)}><Trash2 size={13} /></button>
                      </div>
                    </div>
                    <textarea rows={3} value={block.content} onChange={(event) => patchBlock(role, index, { content: event.target.value })} placeholder="提示词内容…" />
                  </div>
                ))}
                <button type="button" className="modern-button ghost modern-add-block" onClick={() => addBlock(role)}><Plus size={13} />添加提示块</button>
              </div>
              {save.error && <div className="modern-alert error"><CircleAlert size={15} />{save.error.message}</div>}
              <footer>
                <button type="button" className="modern-button ghost" onClick={() => save.mutate(role)} disabled={save.isPending}>{save.isPending ? "保存中" : "保存"}<Check size={14} /></button>
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ModelsPane() {
  const queryClient = useQueryClient();
  const models = useQuery({ queryKey: ["modern-models"], queryFn: () => api<ModelConfig[]>("/api/modern/models") });
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [dropdownModel, setDropdownModel] = useState("");
  const emptyForm = { name: "", provider: "openai", model: "", baseUrl: "", temperature: 0.7, reasoningEffort: "none" as ModelConfig["reasoningEffort"], topP: 1, contextLength: 128000, maxOutputTokens: 8192, enabled: true, apiKey: "" };
  const [form, setForm] = useState(emptyForm);

  const closeModal = () => {
    discover.reset();
    save.reset();
    setCreating(false);
    setEditingId(null);
    setDiscoveredModels([]);
    setDropdownModel("");
    setForm(emptyForm);
  };
  const openCreate = () => {
    discover.reset();
    save.reset();
    setEditingId(null);
    setDiscoveredModels([]);
    setDropdownModel("");
    setForm(emptyForm);
    setCreating(true);
  };
  const openEdit = (model: ModelConfig) => {
    discover.reset();
    save.reset();
    setEditingId(model.id);
    setDiscoveredModels(model.model ? [model.model] : []);
    setDropdownModel(model.model);
    setForm({
      name: model.name,
      provider: model.provider,
      model: model.model,
      baseUrl: model.baseUrl,
      temperature: model.temperature,
      reasoningEffort: model.reasoningEffort,
      topP: model.topP,
      contextLength: model.contextLength,
      maxOutputTokens: model.maxOutputTokens,
      enabled: model.enabled,
      apiKey: "",
    });
    setCreating(true);
  };
  const discover = useMutation({
    mutationFn: () => api<{ models: string[] }>("/api/modern/models/discover", {
      method: "POST",
      body: JSON.stringify({ provider: form.provider, baseUrl: form.baseUrl || undefined, apiKey: form.apiKey }),
    }),
    onSuccess: ({ models: availableModels }) => {
      setDiscoveredModels(availableModels);
      const nextModel = availableModels.includes(form.model) ? form.model : (availableModels[0] ?? form.model);
      setDropdownModel(nextModel);
      setForm((current) => ({ ...current, model: nextModel }));
    },
  });
  const save = useMutation({
    mutationFn: () => {
      const { apiKey, ...config } = form;
      const body = apiKey ? { ...config, apiKey } : config;
      return api<ModelConfig>(editingId ? `/api/modern/models/${editingId}` : "/api/modern/models", { method: editingId ? "PUT" : "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => { closeModal(); void queryClient.invalidateQueries({ queryKey: ["modern-models"] }); },
  });
  const outputExceedsContext = form.maxOutputTokens > form.contextLength;

  return <div className="modern-pane">
    <header className="modern-pane-head"><div><span className="modern-eyebrow">MODEL CONFIGS</span><h3>模型配置</h3><p>连接模型供应商，拉取可用模型，再为 Agent 配置生成参数。</p></div><button className="modern-button solid" onClick={openCreate}><Plus size={15} />新建配置</button></header>
    {models.error && <div className="modern-alert error"><CircleAlert size={15} />{models.error.message}</div>}
    <div className="modern-model-list">
      {!models.isLoading && models.data?.length === 0 && <div className="modern-list-empty">还没有模型配置。</div>}
      {models.data?.map((model) => <article className="modern-model-card" key={model.id}>
        <div className="modern-model-identity"><strong>{model.name}</strong><span>{model.provider} · {model.model || "未填写模型"}</span></div>
        <div className="modern-model-meta"><span>temperature {model.temperature}</span><span>topP {model.topP}</span><span>reasoning {model.reasoningEffort}</span><span>{model.contextLength.toLocaleString()} / {model.maxOutputTokens.toLocaleString()} tokens</span><span>{model.hasApiKey ? "已配置密钥" : "未配置密钥"}</span></div>
        <div className="modern-model-actions"><i className={`modern-status-dot ${model.enabled ? "succeeded" : "cancelled"}`} /><button type="button" className="modern-icon-button" title="编辑模型配置" onClick={() => openEdit(model)}><Settings2 size={15} /></button></div>
      </article>)}
    </div>
    {creating && <div className="modern-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
      <form className="modern-modal wide modern-model-modal" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <header><div><span className="modern-eyebrow">MODEL PROFILE</span><h2>{editingId ? "编辑模型配置" : "新建模型配置"}</h2><p>密钥只用于拉取模型和调用供应商，不会显示在配置列表中。</p></div><button type="button" className="modern-icon-button" title="关闭" onClick={closeModal}><X size={17} /></button></header>

        <section className="modern-model-section">
          <div className="modern-model-section-title"><span>连接</span><small>先填写供应商连接信息</small></div>
          <div className="modern-form-grid">
            <label className="modern-field"><span>配置名称</span><input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：正文生成" required /></label>
            <label className="modern-field"><span>供应商</span><select value={form.provider} onChange={(event) => { setDiscoveredModels([]); setDropdownModel(""); setForm({ ...form, provider: event.target.value, model: "" }); }}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openai-compatible">OpenAI-compatible</option></select></label>
          </div>
          <label className="modern-field"><span>Base URL</span><input type="url" value={form.baseUrl} onChange={(event) => { setDiscoveredModels([]); setDropdownModel(""); setForm({ ...form, baseUrl: event.target.value }); }} placeholder={form.provider === "openai-compatible" ? "https://example.com/v1" : "留空使用供应商默认地址"} required={form.provider === "openai-compatible"} /></label>
          <div className="modern-model-key-row">
            <label className="modern-field"><span>API Key</span><input type="password" autoComplete="off" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder={editingId ? "留空则保留已有密钥" : "输入供应商密钥"} /></label>
            <button type="button" className="modern-button ghost modern-discover-button" onClick={() => discover.mutate()} disabled={discover.isPending || !form.apiKey.trim() || (form.provider === "openai-compatible" && !form.baseUrl.trim())}><RefreshCw size={14} className={discover.isPending ? "modern-spin" : ""} />{discover.isPending ? "正在拉取" : "拉取模型"}</button>
          </div>
          {discover.error && <div className="modern-alert error"><CircleAlert size={15} />{discover.error.message}</div>}
          {discoveredModels.length > 0 && <div className="modern-discovery-status"><Check size={14} />已拉取 {discoveredModels.length} 个可用模型。</div>}
          <label className="modern-field"><span>模型 ID</span><input value={form.model} onChange={(event) => { setDropdownModel(""); setForm({ ...form, model: event.target.value }); }} placeholder="手动输入模型 ID" required /></label>
          <label className="modern-field"><span>可用模型</span><select value={dropdownModel} disabled={discoveredModels.length === 0} onChange={(event) => { const next = event.target.value; setDropdownModel(next); if (next) setForm({ ...form, model: next }); }}><option value="">{discoveredModels.length === 0 ? "请先拉取可用模型" : "请选择模型"}</option>{discoveredModels.map((model) => <option value={model} key={model}>{model}</option>)}</select></label>
        </section>

        <section className="modern-model-section">
          <div className="modern-model-section-title"><span>生成参数</span><small>按模型能力设置上下文和回复上限</small></div>
          <div className="modern-form-grid modern-parameter-grid">
            <label className="modern-field"><span>Temperature</span><input type="number" min="0" max="2" step="0.05" value={form.temperature} onChange={(event) => setForm({ ...form, temperature: Number(event.target.value) })} /></label>
            <label className="modern-field"><span>Top P</span><input type="number" min="0" max="1" step="0.05" value={form.topP} onChange={(event) => setForm({ ...form, topP: Number(event.target.value) })} /></label>
            <label className="modern-field"><span>推理强度</span><select value={form.reasoningEffort} onChange={(event) => setForm({ ...form, reasoningEffort: event.target.value as ModelConfig["reasoningEffort"] })}><option value="none">none</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></label>
            <label className="modern-field"><span>上下文长度</span><input type="number" min="1024" max="2000000" step="1" value={form.contextLength} onChange={(event) => setForm({ ...form, contextLength: Number(event.target.value) })} /><small>tokens</small></label>
            <label className="modern-field"><span>最大回复长度</span><input type="number" min="256" max="100000" step="1" value={form.maxOutputTokens} onChange={(event) => setForm({ ...form, maxOutputTokens: Number(event.target.value) })} /><small>tokens</small></label>
          </div>
          {outputExceedsContext && <div className="modern-alert error"><CircleAlert size={15} />最大回复长度不能超过上下文长度。</div>}
        </section>

        {save.error && <div className="modern-alert error"><CircleAlert size={15} />{save.error.message}</div>}
        <footer><div className="modern-model-enabled"><span>启用此配置</span><label className="modern-toggle" title="启用此模型配置"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span /></label></div><div className="modern-modal-actions"><button type="button" className="modern-button ghost" onClick={closeModal}>取消</button><button className="modern-button solid" disabled={save.isPending || outputExceedsContext || !form.name.trim() || !form.model.trim()}>{save.isPending ? "保存中" : "保存配置"}</button></div></footer>
      </form>
    </div>}
  </div>;
}
