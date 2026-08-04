import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectSummary } from "@novel-studio/contracts";
import { BookOpenText, Download, FilePlus2, FolderOpen, Import, Library, Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../api";

export function ProjectLibrary({ onOpen }: { onOpen: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: "", genre: "玄幻", premise: "", targetWords: 1_000_000, pov: "第三人称限知", audience: "中文网文读者" });
  const fileRef = useRef<HTMLInputElement>(null);
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api<ProjectSummary[]>("/api/projects") });
  const create = useMutation({
    mutationFn: () => api<{ id: string }>("/api/projects", { method: "POST", body: JSON.stringify(form) }),
    onSuccess: ({ id }) => { void queryClient.invalidateQueries({ queryKey: ["projects"] }); onOpen(id); },
  });
  const importProject = useMutation({
    mutationFn: async (file: File) => api<{ id: string }>("/api/projects/import", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: await file.arrayBuffer() }),
    onSuccess: ({ id }) => { void queryClient.invalidateQueries({ queryKey: ["projects"] }); onOpen(id); },
  });

  return (
    <main className="library-page">
      <header className="library-header">
        <div className="brand-lockup"><span className="brand-mark"><BookOpenText size={22} /></span><div><strong>Novel Studio</strong><span>AI 小说工作台</span></div></div>
        <div className="header-actions">
          <input ref={fileRef} type="file" accept=".novelstudio" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) importProject.mutate(file); }} />
          <button className="button secondary" onClick={() => fileRef.current?.click()}><Import size={16} />导入项目</button>
          <button className="button primary" onClick={() => setCreating(true)}><Plus size={16} />新建作品</button>
        </div>
      </header>
      <section className="library-content">
        <div className="section-heading"><div><h1>作品库</h1><p>{projects.data?.length ?? 0} 部作品</p></div><Library size={20} /></div>
        {projects.isLoading && <div className="empty-state">正在读取作品库…</div>}
        {projects.error && <div className="error-banner">{projects.error.message}</div>}
        {projects.data?.length === 0 && (
          <div className="empty-state large"><FolderOpen size={34} /><h2>还没有作品</h2><button className="button primary" onClick={() => setCreating(true)}><FilePlus2 size={16} />创建第一部小说</button></div>
        )}
        <div className="project-list">
          {projects.data?.map((project) => (
            <button key={project.id} className="project-row" onClick={() => onOpen(project.id)}>
              <span className="project-cover"><BookOpenText size={25} /></span>
              <span className="project-main"><strong>{project.title}</strong><span>{project.genre || "未分类"} · {project.status === "planning" ? "规划中" : "创作中"}</span></span>
              <span className="project-stat"><strong>{project.wordCount.toLocaleString()}</strong><span>当前字数</span></span>
              <span className="project-stat"><strong>{Math.round((project.wordCount / project.targetWords) * 100)}%</strong><span>目标进度</span></span>
              <span className="project-date">{new Date(project.updatedAt).toLocaleDateString("zh-CN")}</span>
            </button>
          ))}
        </div>
      </section>

      {creating && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreating(false); }}>
          <form className="modal" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
            <header><div><h2>新建作品</h2><p>这些信息会成为 AI 的首要约束。</p></div><button type="button" className="icon-button" onClick={() => setCreating(false)}><X size={18} /></button></header>
            <div className="form-grid two">
              <label><span>作品名</span><input autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label>
              <label><span>题材</span><input value={form.genre} onChange={(e) => setForm({ ...form, genre: e.target.value })} /></label>
              <label><span>目标字数</span><input type="number" min={1000} max={20000000} value={form.targetWords} onChange={(e) => setForm({ ...form, targetWords: Number(e.target.value) })} /></label>
              <label><span>叙事视角</span><select value={form.pov} onChange={(e) => setForm({ ...form, pov: e.target.value })}><option>第三人称限知</option><option>第三人称全知</option><option>第一人称</option><option>多视角</option></select></label>
            </div>
            <label><span>核心创意</span><textarea rows={5} value={form.premise} onChange={(e) => setForm({ ...form, premise: e.target.value })} placeholder="主角是谁、想要什么、最大的阻力是什么？" /></label>
            {create.error && <div className="error-banner">{create.error.message}</div>}
            <footer><button type="button" className="button secondary" onClick={() => setCreating(false)}>取消</button><button className="button primary" disabled={create.isPending || !form.title.trim()}>{create.isPending ? "创建中…" : "创建作品"}</button></footer>
          </form>
        </div>
      )}
    </main>
  );
}

