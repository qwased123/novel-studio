import type { ProjectTree, TextSelection, TreeScene } from "@novel-studio/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookOpenText, Bot, ChevronDown, ChevronRight, Clapperboard, Clock3, Download, FileText, FolderCog, ListTree, Menu, MoreHorizontal, Plus, Search, Settings, ShieldCheck, Sparkles, UsersRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, download } from "../api";
import { AIPanel } from "./AIPanel";
import { DocumentEditor } from "./DocumentEditor";
import { IconButton } from "./Icons";
import { KnowledgeView } from "./KnowledgeView";
import { SettingsView } from "./SettingsView";
import { ScenePlanner } from "./ScenePlanner";

interface DocumentSummary { id: string; kind: string; title: string; ownerType: string; ownerId: string; currentVersionId: string; plainText: string; wordCount: number }
interface SearchResult { sourceId: string; kind: string; title: string; excerpt: string; score: number }
type View = "write" | "outline" | "scenes" | "bible" | "memory" | "activity" | "settings";

const navItems: Array<{ id: View; label: string; icon: typeof FileText }> = [
  { id: "write", label: "正文", icon: FileText }, { id: "outline", label: "纲要", icon: ListTree },
  { id: "scenes", label: "场景规划", icon: Clapperboard },
  { id: "bible", label: "故事圣经", icon: UsersRound }, { id: "memory", label: "记忆健康", icon: ShieldCheck },
  { id: "activity", label: "任务记录", icon: Clock3 }, { id: "settings", label: "模型设置", icon: Settings },
];

export function Workspace({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("write");
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [expandedVolumes, setExpandedVolumes] = useState<Set<string>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [selectedScene, setSelectedScene] = useState<TreeScene | null>(null);
  const [textSelection, setTextSelection] = useState<TextSelection | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileAiOpen, setMobileAiOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const tree = useQuery({ queryKey: ["tree", projectId], queryFn: () => api<ProjectTree>(`/api/projects/${projectId}/tree`) });
  const documents = useQuery({ queryKey: ["documents", projectId], queryFn: () => api<DocumentSummary[]>(`/api/projects/${projectId}/documents`) });
  const searchResults = useQuery({ queryKey: ["search", projectId, search], queryFn: () => api<SearchResult[]>(`/api/projects/${projectId}/search?q=${encodeURIComponent(search)}`), enabled: search.trim().length >= 2, staleTime: 2_000 });
  useEffect(() => {
    if (!tree.data) return;
    setExpandedVolumes((current) => current.size ? current : new Set(tree.data.volumes.map((volume) => volume.id)));
    if (!selectedDocumentId) setSelectedDocumentId(tree.data.volumes[0]?.chapters[0]?.documentId ?? "");
  }, [tree.data, selectedDocumentId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); searchRef.current?.focus(); setSearchOpen(true); }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    setTextSelection(null);
    setEditorDirty(false);
  }, [selectedDocumentId]);
  const selectedDocument = documents.data?.find((doc) => doc.id === selectedDocumentId);
  const createVolumeMutation = useMutation({ mutationFn: () => api(`/api/projects/${projectId}/volumes`, { method: "POST", body: JSON.stringify({ title: "" }) }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tree", projectId] }) });
  const createChapterMutation = useMutation({ mutationFn: (volumeId: string) => api(`/api/volumes/${volumeId}/chapters`, { method: "POST", body: JSON.stringify({ title: "" }) }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tree", projectId] }) });
  const outlineDocuments = useMemo(() => documents.data?.filter((doc) => ["premise", "synopsis", "style_guide", "book_outline", "volume_outline", "chapter_outline"].includes(doc.kind)) ?? [], [documents.data]);

  function switchView(next: View) {
    setView(next);
    setMobileSidebarOpen(false);
    if (next !== "write" && next !== "outline") setMobileAiOpen(false);
    if (next === "write") { setSelectedScene(null); setSelectedDocumentId((current) => documents.data?.find((doc) => doc.id === current && doc.kind === "chapter_content")?.id ?? tree.data?.volumes[0]?.chapters[0]?.documentId ?? ""); }
    if (next === "outline" && selectedDocument?.kind === "chapter_content") setSelectedDocumentId(outlineDocuments[0]?.id ?? "");
  }

  function openSearchResult(result: SearchResult) {
    const document = documents.data?.find((entry) => entry.id === result.sourceId);
    if (document) {
      setSelectedDocumentId(document.id);
      setView(document.kind === "chapter_content" ? "write" : "outline");
    } else if (result.kind.startsWith("entity:")) setView("bible");
    setSearchOpen(false);
  }

  if (tree.isLoading) return <div className="app-loading"><BookOpenText size={30} /><span>正在打开工作台…</span></div>;
  if (tree.error || !tree.data) return <div className="fatal-error"><h1>无法打开作品</h1><p>{tree.error?.message}</p><button className="button primary" onClick={onBack}>返回作品库</button></div>;

  return <main className="workspace">
    {(mobileSidebarOpen || mobileAiOpen) && <button className="mobile-backdrop" aria-label="关闭抽屉" onClick={() => { setMobileSidebarOpen(false); setMobileAiOpen(false); }} />}
    <aside className={`left-sidebar ${mobileSidebarOpen ? "mobile-open" : ""}`}>
      <header className="workspace-brand"><button className="icon-button" title="返回作品库" onClick={onBack}><ArrowLeft size={17} /></button><span className="brand-mark small"><BookOpenText size={18} /></span><strong>Novel Studio</strong></header>
      <div className="project-identity"><span>{tree.data.project.genre || "长篇小说"}</span><h1>{tree.data.project.title}</h1><div className="progress-line"><i style={{ width: `${Math.min(100, tree.data.project.wordCount / tree.data.project.targetWords * 100)}%` }} /></div><small>{tree.data.project.wordCount.toLocaleString()} / {tree.data.project.targetWords.toLocaleString()} 字</small></div>
      <nav className="main-nav">{navItems.map((item) => { const Icon = item.icon; return <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => switchView(item.id)}><Icon size={16} />{item.label}</button>; })}</nav>
      {(view === "write" || view === "outline") && <div className="navigator">
        <div className="navigator-heading"><span>{view === "write" ? "卷章" : "文档"}</span><IconButton icon={Plus} label={view === "write" ? "新建卷" : ""} onClick={() => createVolumeMutation.mutate()} /></div>
        {view === "write" ? <div className="tree-list">{tree.data.volumes.map((volume) => <div key={volume.id} className="tree-volume"><div className="tree-volume-row"><button onClick={() => setExpandedVolumes((current) => { const next = new Set(current); next.has(volume.id) ? next.delete(volume.id) : next.add(volume.id); return next; })}>{expandedVolumes.has(volume.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{volume.title}</span></button><IconButton icon={Plus} label="新建章节" onClick={() => createChapterMutation.mutate(volume.id)} /></div>{expandedVolumes.has(volume.id) && <div className="chapter-list">{volume.chapters.map((chapter) => <button key={chapter.id} className={selectedDocumentId === chapter.documentId ? "active" : ""} onClick={() => { setSelectedDocumentId(chapter.documentId); setMobileSidebarOpen(false); }}><FileText size={14} /><span>{chapter.title}</span><small>{chapter.wordCount}</small></button>)}</div>}</div>)}</div>
        : <div className="outline-list">{outlineDocuments.map((doc) => <button key={doc.id} className={selectedDocumentId === doc.id ? "active" : ""} onClick={() => { setSelectedDocumentId(doc.id); setMobileSidebarOpen(false); }}><span>{outlineKind(doc.kind)}</span><strong>{doc.title}</strong><small>{doc.wordCount} 字</small></button>)}</div>}
      </div>}
      <footer className="sidebar-footer"><button onClick={() => switchView("settings")}><FolderCog size={15} />数据保存在本机</button></footer>
    </aside>

    <section className="workspace-main">
      <header className="topbar"><button className="icon-button mobile-only" title="打开导航" onClick={() => setMobileSidebarOpen(true)}><Menu size={18} /></button><div className="topbar-search"><Search size={15} /><input ref={searchRef} value={search} onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} placeholder="搜索作品内容" /><kbd>Ctrl K</kbd>{searchOpen && search.trim().length >= 2 && <div className="search-results">{searchResults.data?.map((result) => <button key={`${result.kind}:${result.sourceId}`} onMouseDown={(event) => { event.preventDefault(); openSearchResult(result); }}><span>{outlineKind(result.kind.replace("entity:", ""))}</span><div><strong>{result.title}</strong><small>{result.excerpt.replaceAll("[", "").replaceAll("]", "")}</small></div></button>)}{searchResults.data?.length === 0 && <div>没有找到相关内容</div>}</div>}</div><div className="topbar-actions"><span className="sync-state"><span />本地已连接</span>{(view === "write" || view === "outline") && selectedDocumentId && <button className="icon-button mobile-only" title="打开 AI 协作" onClick={() => setMobileAiOpen(true)}><Sparkles size={17} /></button>}<div className="menu-wrap"><button className="button secondary compact" onClick={() => setExportOpen(!exportOpen)}><Download size={15} />导出<ChevronDown size={13} /></button>{exportOpen && <div className="export-menu"><button onClick={() => void download(`/api/projects/${projectId}/export/txt`)}>TXT 正文</button><button onClick={() => void download(`/api/projects/${projectId}/export/md`)}>Markdown</button><button onClick={() => void download(`/api/projects/${projectId}/export/epub`)}>EPUB 电子书</button><hr/><button onClick={() => void download(`/api/projects/${projectId}/backup`)}>完整项目包</button></div>}</div></div></header>
      <div className="work-area">
        <div className="primary-pane">
          {(view === "write" || view === "outline") && selectedDocumentId && <DocumentEditor documentId={selectedDocumentId} onSaved={() => void queryClient.invalidateQueries({ queryKey: ["tree", projectId] })} onSelectionChange={setTextSelection} onDirtyChange={setEditorDirty} />}
          {view === "bible" && <KnowledgeView projectId={projectId} />}
          {view === "scenes" && <ScenePlanner tree={tree.data} onWriteScene={(chapter, scene) => { setSelectedDocumentId(chapter.documentId); setSelectedScene(scene); setView("write"); }} />}
          {view === "memory" && <KnowledgeView projectId={projectId} mode="memory" />}
          {view === "activity" && <ActivityView projectId={projectId} />}
          {view === "settings" && <SettingsView />}
        </div>
        {(view === "write" || view === "outline") && selectedDocumentId && <AIPanel projectId={projectId} documentId={selectedDocumentId} documentKind={selectedDocument?.kind} scene={selectedScene} selection={textSelection} documentDirty={editorDirty} mobileOpen={mobileAiOpen} onMobileClose={() => setMobileAiOpen(false)} />}
      </div>
    </section>
  </main>;
}

interface Job { id: string; type: string; status: string; modelProfile: string; error?: string; inputTokens?: number; outputTokens?: number; createdAt: string }
function ActivityView({ projectId }: { projectId: string }) {
  const jobs = useQuery({ queryKey: ["jobs", projectId], queryFn: () => api<Job[]>(`/api/jobs?projectId=${projectId}`), refetchInterval: 3_000 });
  return <section className="content-view"><header className="content-view-header"><div><span className="eyebrow">可追溯执行</span><h1>任务记录</h1><p>每次运行保留模型、上下文版本、token 用量和错误。</p></div><Bot size={24} /></header><div className="activity-table"><div className="table-head"><span>任务</span><span>角色</span><span>状态</span><span>Token</span><span>创建时间</span></div>{jobs.data?.map((job) => <div className="table-row" key={job.id}><span><Sparkles size={15} />{jobTypeName(job.type)}{job.error && <small>{job.error}</small>}</span><span>{job.modelProfile}</span><span><i className={`job-status ${job.status}`} />{statusName(job.status)}</span><span>{job.inputTokens || job.outputTokens ? `${job.inputTokens ?? 0} / ${job.outputTokens ?? 0}` : "-"}</span><span>{new Date(job.createdAt).toLocaleString("zh-CN")}</span></div>)}</div>{jobs.data?.length === 0 && <div className="empty-state large"><Clock3 size={30} /><h2>暂无 AI 任务</h2></div>}</section>;
}

function outlineKind(kind: string) { return ({ premise: "创意", synopsis: "简介", style_guide: "文风", book_outline: "总纲", volume_outline: "卷纲", chapter_outline: "章纲" } as Record<string,string>)[kind] ?? "文档"; }
function jobTypeName(type: string) { return ({ expand_concept: "扩展创意", outline_book: "生成总纲", outline_volume: "生成卷纲", outline_chapter: "生成章纲", draft_chapter: "生成整章", draft_scene: "生成场景", rewrite_selection: "改写", review_consistency: "一致性审校", review_plot: "情节审校", review_style: "文风审校", extract_memory: "记忆抽取", distill_arc: "弧线蒸馏", embed_knowledge: "语义索引" } as Record<string,string>)[type] ?? type; }
function statusName(status: string) { return ({ queued: "等待", running: "运行中", awaiting_input: "待决策", succeeded: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" } as Record<string,string>)[status] ?? status; }
