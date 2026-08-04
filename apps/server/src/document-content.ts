import { getSchema } from "@tiptap/core";
import type { TextSelection } from "@novel-studio/contracts";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import StarterKit from "@tiptap/starter-kit";

type JsonNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: JsonNode[];
  text?: string;
};

const schema = getSchema([StarterKit]);

function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: unknown) {
  return escapeHtml(String(value ?? "")).replaceAll('"', "&quot;");
}

function renderMarks(text: string, marks: JsonNode["marks"] = []) {
  return marks.reduce((value, mark) => {
    if (mark.type === "bold") return `<strong>${value}</strong>`;
    if (mark.type === "italic") return `<em>${value}</em>`;
    if (mark.type === "strike") return `<s>${value}</s>`;
    if (mark.type === "underline") return `<u>${value}</u>`;
    if (mark.type === "code") return `<code>${value}</code>`;
    if (mark.type === "link") return `<a href="${escapeAttribute(mark.attrs?.href)}">${value}</a>`;
    return value;
  }, escapeHtml(text));
}

function nodeText(node: JsonNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(nodeText).join("");
}

function renderNode(node: JsonNode): string {
  if (node.type === "text") return renderMarks(node.text ?? "", node.marks);
  if (node.type === "hardBreak") return "<br>";
  if (node.type === "horizontalRule") return "<hr>";
  if (node.type === "codeBlock") return `<pre><code>${escapeHtml(nodeText(node))}</code></pre>`;
  const body = (node.content ?? []).map(renderNode).join("");
  if (node.type === "doc") return body;
  if (node.type === "paragraph") return `<p>${body}</p>`;
  if (node.type === "heading") return `<h${Number(node.attrs?.level ?? 2)}>${body}</h${Number(node.attrs?.level ?? 2)}>`;
  if (node.type === "blockquote") return `<blockquote>${body}</blockquote>`;
  if (node.type === "bulletList") return `<ul>${body}</ul>`;
  if (node.type === "orderedList") {
    const start = Number(node.attrs?.start ?? 1);
    return `<ol${start === 1 ? "" : ` start="${start}"`}>${body}</ol>`;
  }
  if (node.type === "listItem") return `<li>${body}</li>`;
  return body;
}

function textToBlocks(text: string) {
  return text.trim().split(/\n{2,}/).map((paragraph) => {
    const inline = paragraph.split("\n").flatMap((line, index) => {
      const nodes: ProseMirrorNode[] = [];
      if (index > 0) nodes.push(schema.nodes.hardBreak!.create());
      if (line) nodes.push(schema.text(line));
      return nodes;
    });
    return schema.nodes.paragraph!.create(null, inline);
  });
}

export function plainTextToDocument(text: string): Record<string, unknown> {
  const blocks = textToBlocks(text);
  return schema.nodes.doc!.create(null, blocks.length ? blocks : [schema.nodes.paragraph!.create()]).toJSON();
}

export function documentToHtml(contentJson: Record<string, unknown>) {
  return renderNode(contentJson as JsonNode);
}

export function selectedText(contentJson: Record<string, unknown>, selection: TextSelection) {
  const document = schema.nodeFromJSON(contentJson);
  if (selection.to > document.content.size) throw new Error("选区位置已超出当前文档");
  return document.textBetween(selection.from, selection.to, "\n\n", "\n");
}

export function validateSelection(contentJson: Record<string, unknown>, selection: TextSelection) {
  if (selectedText(contentJson, selection) !== selection.text) throw new Error("选区与当前文档内容不一致，请重新选择");
}

export function replaceSelection(contentJson: Record<string, unknown>, selection: TextSelection, replacementText: string) {
  const normalized = replacementText.replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new Error("AI 改写结果为空");
  const document = schema.nodeFromJSON(contentJson);
  validateSelection(contentJson, selection);
  const replacement = Fragment.fromArray(textToBlocks(normalized));
  const transformed = new Transform(document).replace(selection.from, selection.to, new Slice(replacement, 1, 1)).doc;
  const nextJson = transformed.toJSON() as Record<string, unknown>;
  return {
    contentJson: nextJson,
    plainText: transformed.textBetween(0, transformed.content.size, "\n\n", "\n"),
    html: documentToHtml(nextJson),
  };
}
