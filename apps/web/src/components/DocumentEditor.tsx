import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { TextSelection } from "@novel-studio/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bold, Clock3, Heading2, Italic, Redo2, Save, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { IconButton } from "./Icons";

interface DocumentData {
  id: string;
  projectId: string;
  kind: string;
  title: string;
  currentVersionId: string;
  contentJson: Record<string, unknown>;
  plainText: string;
  wordCount: number;
  updatedAt: string;
}

interface Version { id: string; wordCount: number; origin: string; message: string; createdAt: string }

export function DocumentEditor({ documentId, onSaved, onSelectionChange, onDirtyChange }: {
  documentId: string;
  onSaved?: () => void;
  onSelectionChange?: (selection: TextSelection | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [dirty, setDirty] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const document = useQuery({ queryKey: ["document", documentId], queryFn: () => api<DocumentData>(`/api/documents/${documentId}`), enabled: Boolean(documentId) });
  const versions = useQuery({ queryKey: ["versions", documentId], queryFn: () => api<Version[]>(`/api/documents/${documentId}/versions`), enabled: versionsOpen });
  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder: "开始写作…" })],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    editorProps: { attributes: { class: "prose-editor" } },
    onUpdate: ({ editor: updatedEditor }) => {
      setDirty(true);
      onDirtyChange?.(true);
      onSelectionChange?.(readSelection(updatedEditor));
      setWordCount(countWords(updatedEditor.getText()));
    },
    onSelectionUpdate: ({ editor: updatedEditor }) => onSelectionChange?.(readSelection(updatedEditor)),
  });
  useEffect(() => {
    if (editor && document.data) {
      editor.commands.setContent(document.data.contentJson, { emitUpdate: false });
      setWordCount(countWords(document.data.plainText));
      setDirty(false);
      onDirtyChange?.(false);
      onSelectionChange?.(null);
    }
  }, [editor, document.data?.id, document.data?.currentVersionId]);

  const save = useMutation({
    mutationFn: () => api<{ versionId: string }>(`/api/documents/${documentId}`, {
      method: "PUT",
      body: JSON.stringify({ contentJson: editor?.getJSON(), plainText: editor?.getText({ blockSeparator: "\n\n" }) ?? "", html: editor?.getHTML() ?? "", expectedVersionId: document.data?.currentVersionId, message: "人工保存" }),
    }),
    onSuccess: () => {
      setDirty(false);
      onDirtyChange?.(false);
      void queryClient.invalidateQueries({ queryKey: ["document", documentId] });
      void queryClient.invalidateQueries({ queryKey: ["versions", documentId] });
      onSaved?.();
    },
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (dirty && !save.isPending) save.mutate(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dirty, save.isPending, document.data?.currentVersionId]);

  if (document.isLoading) return <div className="center-loading">正在打开文档…</div>;
  if (document.error) return <div className="error-banner">{document.error.message}</div>;

  return (
    <section className="document-shell">
      <header className="editor-header">
        <div><span className="eyebrow">{kindLabel(document.data?.kind)}</span><h1>{document.data?.title}</h1></div>
        <div className="editor-meta"><span>{wordCount.toLocaleString()} 字</span><span className={dirty ? "dirty" : "saved"}>{dirty ? "未保存" : "已保存"}</span></div>
      </header>
      <div className="editor-toolbar">
        <IconButton icon={Heading2} label="二级标题" active={editor?.isActive("heading", { level: 2 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} />
        <IconButton icon={Bold} label="粗体" active={editor?.isActive("bold")} onClick={() => editor?.chain().focus().toggleBold().run()} />
        <IconButton icon={Italic} label="斜体" active={editor?.isActive("italic")} onClick={() => editor?.chain().focus().toggleItalic().run()} />
        <span className="toolbar-separator" />
        <IconButton icon={Undo2} label="撤销" onClick={() => editor?.chain().focus().undo().run()} disabled={!editor?.can().undo()} />
        <IconButton icon={Redo2} label="重做" onClick={() => editor?.chain().focus().redo().run()} disabled={!editor?.can().redo()} />
        <span className="toolbar-spacer" />
        <button className="button ghost" onClick={() => setVersionsOpen(!versionsOpen)}><Clock3 size={16} />版本</button>
        <button className="button primary compact" onClick={() => save.mutate()} disabled={!dirty || save.isPending}><Save size={16} />{save.isPending ? "保存中" : "保存"}</button>
      </div>
      {save.error && <div className="error-banner inset">{save.error.message}</div>}
      <div className="editor-scroll"><EditorContent editor={editor} /></div>
      {versionsOpen && (
        <aside className="version-drawer">
          <header><strong>版本历史</strong><button className="icon-button" onClick={() => setVersionsOpen(false)} aria-label="关闭">×</button></header>
          <div className="version-list">{versions.data?.map((version, index) => <div className="version-row" key={version.id}><div><strong>{version.message || "保存"}</strong><span>{new Date(version.createdAt).toLocaleString("zh-CN")} · {version.wordCount} 字</span></div>{index > 0 && <button className="button text" onClick={async () => { await api(`/api/documents/${documentId}/versions/${version.id}/restore`, { method: "POST" }); await queryClient.invalidateQueries({ queryKey: ["document", documentId] }); await queryClient.invalidateQueries({ queryKey: ["versions", documentId] }); }}>恢复</button>}</div>)}</div>
        </aside>
      )}
    </section>
  );
}

function readSelection(editor: NonNullable<ReturnType<typeof useEditor>>): TextSelection | null {
  const { from, to } = editor.state.selection;
  if (from === to) return null;
  const text = editor.state.doc.textBetween(from, to, "\n\n", "\n");
  return text.trim() ? { from, to, text } : null;
}

function kindLabel(kind?: string) {
  return ({ chapter_content: "正文", chapter_outline: "章纲", volume_outline: "卷纲", book_outline: "总纲", premise: "核心创意", synopsis: "简介", style_guide: "文风约束" } as Record<string, string>)[kind ?? ""] ?? "文档";
}

function countWords(text: string) {
  return (text.match(/[\u3400-\u9fff]/g)?.length ?? 0) + (text.match(/[A-Za-z0-9]+/g)?.length ?? 0);
}
