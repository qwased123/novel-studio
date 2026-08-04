import type { ProjectTree, TreeChapter, TreeScene } from "@novel-studio/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Clapperboard, Plus, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";

function SceneRow({ scene, onWrite, onSaved }: { scene: TreeScene; onWrite: (scene: TreeScene) => void; onSaved: () => void }) {
  const [form, setForm] = useState({ title: scene.title, summary: scene.summary, goal: scene.goal, conflict: scene.conflict, outcome: scene.outcome });
  useEffect(() => setForm({ title: scene.title, summary: scene.summary, goal: scene.goal, conflict: scene.conflict, outcome: scene.outcome }), [scene]);
  const save = useMutation({ mutationFn: () => api(`/api/scenes/${scene.id}`, { method: "PATCH", body: JSON.stringify(form) }), onSuccess: onSaved });
  return <article className="scene-row"><div className="scene-index">{String(scene.position).padStart(2, "0")}</div><div className="scene-fields"><input className="scene-title-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-label="场景名称" /><label><span>场景摘要</span><textarea rows={2} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></label><div className="scene-detail-grid"><label><span>目标</span><textarea rows={2} value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} /></label><label><span>冲突</span><textarea rows={2} value={form.conflict} onChange={(e) => setForm({ ...form, conflict: e.target.value })} /></label><label><span>结果</span><textarea rows={2} value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} /></label></div></div><div className="scene-actions"><button className="button secondary compact" onClick={() => save.mutate()} disabled={save.isPending}><Save size={14} />保存</button><button className="button primary compact" onClick={() => onWrite({ ...scene, ...form })}><ArrowRight size={14} />写场景</button></div></article>;
}

export function ScenePlanner({ tree, onWriteScene }: { tree: ProjectTree; onWriteScene: (chapter: TreeChapter, scene: TreeScene) => void }) {
  const queryClient = useQueryClient();
  const allChapters = tree.volumes.flatMap((volume) => volume.chapters.map((chapter) => ({ chapter, volumeTitle: volume.title })));
  const [chapterId, setChapterId] = useState(allChapters[0]?.chapter.id ?? "");
  const selected = allChapters.find((entry) => entry.chapter.id === chapterId) ?? allChapters[0];
  const add = useMutation({ mutationFn: () => api(`/api/chapters/${selected?.chapter.id}/scenes`, { method: "POST", body: JSON.stringify({ title: "" }) }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tree", tree.project.id] }) });
  return <section className="content-view scene-planner"><header className="content-view-header"><div><span className="eyebrow">章节节拍</span><h1>场景规划</h1><p>整章生成会严格按这里的顺序逐场写作，只携带上一场尾部。</p></div><button className="button primary" onClick={() => add.mutate()} disabled={!selected}><Plus size={16} />新增场景</button></header><div className="scene-chapter-picker"><Clapperboard size={16} /><select value={selected?.chapter.id ?? ""} onChange={(e) => setChapterId(e.target.value)}>{allChapters.map((entry) => <option key={entry.chapter.id} value={entry.chapter.id}>{entry.volumeTitle} / {entry.chapter.title}</option>)}</select><span>{selected?.chapter.scenes.length ?? 0} 个场景</span></div><div className="scene-list">{selected?.chapter.scenes.map((scene) => <SceneRow key={scene.id} scene={scene} onSaved={() => void queryClient.invalidateQueries({ queryKey: ["tree", tree.project.id] })} onWrite={(draft) => onWriteScene(selected.chapter, draft)} />)}</div></section>;
}
