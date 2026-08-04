import type { ContextItem, JobType, TextSelection } from "@novel-studio/contracts";
import { parseJson, sqlite } from "./db.js";
import { searchSemantic } from "./embeddings.js";
import { searchKnowledge } from "./repository.js";

type Row = Record<string, unknown>;

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 2.2));
}

function item(
  category: ContextItem["category"],
  id: string,
  title: string,
  excerpt: string,
  required: boolean,
  reason: string,
  sourceVersionId: string | null = null,
  temperature: ContextItem["temperature"] = required ? "blue" : "green",
): ContextItem {
  return { id, category, temperature, title, excerpt, required, included: false, reason, sourceVersionId, estimatedTokens: estimateTokens(excerpt) };
}

function fitRequiredItems(entries: ContextItem[], tokenLimit: number) {
  let used = 0;
  return entries.map((entry, index) => {
    const remainingItems = entries.length - index;
    const fairShare = Math.max(1, Math.floor((tokenLimit - used) / remainingItems));
    if (entry.estimatedTokens <= fairShare) {
      used += entry.estimatedTokens;
      return { ...entry, temperature: "blue" as const, included: true };
    }
    const marker = "[已截断]";
    const maxChars = Math.max(1, Math.floor(fairShare * 2.2));
    const excerpt = maxChars > marker.length + 1
      ? `${entry.excerpt.slice(0, maxChars - marker.length - 1).trimEnd()}\n${marker}`
      : entry.excerpt.slice(0, maxChars);
    const fitted = { ...entry, excerpt, estimatedTokens: estimateTokens(excerpt), temperature: "blue" as const, included: true, reason: `${entry.reason} · 已按预算截断` };
    used += fitted.estimatedTokens;
    return fitted;
  });
}

export async function buildContext(input: {
  projectId: string;
  documentId?: string | null;
  sceneId?: string | null;
  instruction: string;
  type: JobType;
  selection?: TextSelection | null;
  includeIds?: string[];
  excludeIds?: string[];
}) {
  const project = sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(input.projectId) as Row | undefined;
  if (!project) throw new Error("作品不存在");
  const items: ContextItem[] = [];

  const premise = String(project.premise ?? "").trim();
  if (premise) items.push(item("constraint", `project:${project.id}`, "作品核心创意", premise, true, "所有创作任务的根约束"));
  items.push(item(
    "constraint",
    `project-meta:${project.id}`,
    "叙事约束",
    `题材：${project.genre || "未指定"}\n叙事视角：${project.pov}\n目标读者：${project.audience}`,
    true,
    "保证视角、受众和题材一致",
  ));

  const projectDocs = sqlite.prepare(`
    SELECT d.id, d.kind, d.title, d.current_version_id AS versionId, v.plain_text AS text
    FROM documents d JOIN document_versions v ON v.id = d.current_version_id
    WHERE d.project_id = ? AND d.owner_type = 'project'
  `).all(input.projectId) as Row[];
  for (const doc of projectDocs) {
    const text = String(doc.text ?? "").trim();
    if (!text || doc.kind === "premise") continue;
    const required = doc.kind === "style_guide" || doc.kind === "book_outline";
    items.push(item(required ? "constraint" : "outline", String(doc.id), String(doc.title), text, required, required ? "全书硬约束或总体方向" : "项目背景材料", String(doc.versionId)));
  }

  let target: Row | undefined;
  if (input.documentId) {
    target = sqlite.prepare("SELECT * FROM documents WHERE id = ? AND project_id = ?").get(input.documentId, input.projectId) as Row | undefined;
  }

  if (target?.owner_type === "chapter") {
    const chapter = sqlite.prepare(`
      SELECT c.*, v.position AS volume_position, v.outline_document_id AS volume_outline_document_id
      FROM chapters c JOIN volumes v ON v.id = c.volume_id WHERE c.id = ?
    `).get(target.owner_id) as Row | undefined;
    if (chapter && input.type === "distill_arc") {
      const summaries = sqlite.prepare(`
        SELECT s.chapter_id AS chapterId, s.source_version_id AS versionId, s.summary, c.title
        FROM chapter_summaries s
        JOIN chapters c ON c.id=s.chapter_id
        JOIN volumes v ON v.id=c.volume_id
        WHERE s.project_id=? AND s.stale=0
          AND (v.position < (SELECT position FROM volumes WHERE id=?)
            OR (v.position=(SELECT position FROM volumes WHERE id=?) AND c.position<=?))
        ORDER BY v.position DESC, c.position DESC LIMIT 5
      `).all(input.projectId, chapter.volume_id, chapter.volume_id, chapter.position) as Row[];
      for (const summary of summaries.reverse()) {
        items.push(item("continuity", `arc-chapter:${summary.chapterId}`, String(summary.title), String(summary.summary), true, "弧线蒸馏的已确认章节摘要", String(summary.versionId)));
      }
    } else if (chapter) {
      const outlineIds = [chapter.volume_outline_document_id, chapter.outline_document_id].filter(Boolean);
      for (const outlineId of outlineIds) {
        const doc = sqlite.prepare(`SELECT d.id, d.title, d.current_version_id AS versionId, v.plain_text AS text
          FROM documents d JOIN document_versions v ON v.id = d.current_version_id WHERE d.id = ?`).get(outlineId) as Row | undefined;
        if (doc && String(doc.text ?? "").trim()) {
          items.push(item("outline", String(doc.id), String(doc.title), String(doc.text), true, "当前卷与章节的直接写作目标", String(doc.versionId)));
        }
      }

      const recent = sqlite.prepare(`
        SELECT c.id, c.title, d.current_version_id AS versionId,
          CASE WHEN s.summary IS NOT NULL
            THEN s.summary || CASE WHEN s.continuation_excerpt<>'' THEN char(10)||char(10)||'【章末接续】'||char(10)||s.continuation_excerpt ELSE '' END
            ELSE substr(v.plain_text, MAX(length(v.plain_text) - 1800, 1)) END AS text
        FROM chapters c
        JOIN documents d ON d.id = c.content_document_id
        JOIN document_versions v ON v.id = d.current_version_id
        LEFT JOIN chapter_summaries s ON s.chapter_id = c.id AND s.source_version_id = d.current_version_id AND s.stale = 0
        WHERE c.volume_id = ? AND c.position < ?
        ORDER BY c.position DESC LIMIT 3
      `).all(chapter.volume_id, chapter.position) as Row[];
      for (const previous of recent.reverse()) {
        const text = String(previous.text ?? "").trim();
        if (text) items.push(item("continuity", `chapter:${previous.id}`, String(previous.title), text, true, "最近章节的连续性与承接", String(previous.versionId)));
      }

      const arcs = sqlite.prepare(`SELECT a.id,a.summary,sc.title AS startTitle,ec.title AS endTitle
        FROM arc_summaries a JOIN chapters sc ON sc.id=a.start_chapter_id JOIN chapters ec ON ec.id=a.end_chapter_id
        JOIN volumes ev ON ev.id=ec.volume_id
        WHERE a.project_id=? AND a.stale=0 AND (ev.position < ? OR (ev.position=? AND ec.position < ?))
        ORDER BY ev.position DESC,ec.position DESC LIMIT 4`).all(input.projectId, chapter.volume_position, chapter.volume_position, chapter.position) as Row[];
      for (const arc of arcs.reverse()) {
        items.push(item("continuity", `arc:${arc.id}`, `${arc.startTitle} - ${arc.endTitle} · 阶段弧线`, String(arc.summary), false, "已确认的阶段情节压缩记忆"));
      }

      const archived = sqlite.prepare(`
        SELECT c.id, c.title, s.source_version_id AS versionId, s.summary AS text
        FROM chapters c
        JOIN volumes v ON v.id=c.volume_id
        JOIN chapter_summaries s ON s.chapter_id=c.id AND s.stale=0
        WHERE c.project_id=? AND (v.position < ? OR (v.position=? AND c.position < ?))
        ORDER BY v.position DESC, c.position DESC LIMIT 16 OFFSET 3
      `).all(input.projectId, chapter.volume_position, chapter.volume_position, chapter.position) as Row[];
      for (const previous of archived) {
        const text = String(previous.text ?? "").trim();
        if (text) items.push(item("continuity", `archive:${previous.id}`, `${previous.title} · 存档`, text, false, "较早章节记忆，可按需主动查询", String(previous.versionId), "cold"));
      }
    }
  }

  if (input.sceneId) {
    const scene = sqlite.prepare("SELECT * FROM scenes WHERE id=?").get(input.sceneId) as Row | undefined;
    if (scene) {
      const excerpt = [`场景摘要：${scene.summary || "未填写"}`, `目标：${scene.goal || "未填写"}`, `冲突：${scene.conflict || "未填写"}`, `结果：${scene.outcome || "未填写"}`].join("\n");
      items.push(item("outline", `scene:${scene.id}`, String(scene.title), excerpt, true, "当前指定场景的直接写作目标"));
    }
  }

  if (input.type === "rewrite_selection" && input.selection) {
    items.push(item(
      "continuity",
      `selection:${input.documentId}:${input.selection.from}:${input.selection.to}`,
      "待改写选区（原文）",
      input.selection.text,
      true,
      "只允许改写这段原文，选区之外的正文保持不变",
      target ? String(target.current_version_id) : null,
    ));
  }

  if (target && (input.type.startsWith("review_") || input.type === "extract_memory")) {
    const current = sqlite.prepare(`SELECT d.current_version_id AS versionId, d.title, v.plain_text AS text
      FROM documents d JOIN document_versions v ON v.id = d.current_version_id WHERE d.id = ?`).get(target.id) as Row | undefined;
    if (current && String(current.text ?? "").trim()) {
      items.push(item("continuity", `target:${target.id}`, `${current.title}（当前确认版本）`, String(current.text), true, "审校或记忆抽取的直接事实来源", String(current.versionId)));
    }
  }

  const queryText = [input.instruction, input.selection?.text ?? "", ...items.filter((entry) => entry.category === "outline").map((entry) => entry.excerpt.slice(0, 300))].join("\n");
  const entities = sqlite.prepare("SELECT * FROM entities WHERE project_id = ? ORDER BY updated_at DESC").all(input.projectId) as Row[];
  const matchedEntities = entities.filter((entity) => {
    const names = [String(entity.name), ...parseJson<string[]>(entity.aliases_json, [])];
    return names.some((name) => name && queryText.includes(name));
  });
  const selectedEntities = matchedEntities.length > 0 ? matchedEntities.slice(0, 16) : entities.slice(0, 6);
  for (const entity of selectedEntities) {
    const attributes = parseJson<Record<string, unknown>>(entity.attributes_json, {});
    const excerpt = [entity.summary, Object.keys(attributes).length ? JSON.stringify(attributes) : ""].filter(Boolean).join("\n");
    if (excerpt.trim()) items.push(item("entity", String(entity.id), `${entity.name} · ${entity.type}`, excerpt, false, matchedEntities.includes(entity) ? "在当前指令或纲要中被明确提及" : "近期维护的核心设定"));
  }

  const selectedEntityIds = selectedEntities.map((entity) => entity.id);
  const factParams: unknown[] = [input.projectId];
  let factFilter = "(f.subject_entity_id IS NULL";
  if (selectedEntityIds.length) {
    factFilter += ` OR f.subject_entity_id IN (${selectedEntityIds.map(() => "?").join(",")})`;
    factParams.push(...selectedEntityIds);
  }
  factFilter += ")";
  const facts = sqlite.prepare(`SELECT f.*, e.name AS subject_name FROM facts f LEFT JOIN entities e ON e.id=f.subject_entity_id
    WHERE f.project_id=? AND f.status='active' AND ${factFilter} ORDER BY f.updated_at DESC LIMIT 48`).all(...factParams) as Row[];
  if (facts.length) {
    const lines = facts.map((fact) => {
      const source = fact.evidence ? `；证据：${fact.evidence}` : "";
      return `- [${fact.visibility}] ${fact.subject_name || "全局"} / ${fact.predicate} = ${fact.object_text}${source}`;
    }).join("\n");
    items.push(item("entity", `facts:${input.projectId}`, "当前事实状态", lines, true, "已确认且仍处于生效期的结构化事实"));
  }

  const foreshadows = sqlite.prepare("SELECT * FROM foreshadows WHERE project_id = ? AND status IN ('open', 'advanced') ORDER BY updated_at DESC LIMIT 12")
    .all(input.projectId) as Row[];
  for (const foreshadow of foreshadows) {
    items.push(item("foreshadow", String(foreshadow.id), String(foreshadow.title), String(foreshadow.detail ?? ""), false, "尚未回收的伏笔"));
  }

  const searchSeed = [...matchedEntities.map((entity) => String(entity.name)), input.instruction.slice(0, 80)].filter(Boolean).join(" ");
  for (const result of searchKnowledge(input.projectId, searchSeed, 8) as Row[]) {
    if (items.some((entry) => entry.id === result.sourceId)) continue;
    items.push(item("retrieval", String(result.sourceId), String(result.title), String(result.excerpt), false, "与当前任务语义或关键词相关"));
  }
  for (const result of await searchSemantic(input.projectId, searchSeed, 8) as Row[]) {
    if (items.some((entry) => entry.id === result.sourceId || entry.excerpt === result.excerpt)) continue;
    items.push(item("retrieval", String(result.sourceId), String(result.title), String(result.excerpt), false, `语义相关度 ${Math.max(0, 1 - Number(result.distance ?? 1)).toFixed(2)}`));
  }

  const exclude = new Set(input.excludeIds ?? []);
  const forceInclude = new Set(input.includeIds ?? []);
  const maxInputTokens = 48_000;
  const reserve = 2_000;
  const tokenLimit = maxInputTokens - reserve;
  const required = fitRequiredItems(items.filter((entry) => entry.required), tokenLimit);
  let used = required.reduce((sum, entry) => sum + entry.estimatedTokens, 0);
  const requiredById = new Map(required.map((entry) => [entry.id, entry]));
  const resolved = items.map((original) => {
    const fitted = requiredById.get(original.id);
    if (fitted) return fitted;
    if (exclude.has(original.id)) return { ...original, included: false };
    if (forceInclude.has(original.id)) {
      if (used + original.estimatedTokens <= tokenLimit) {
        used += original.estimatedTokens;
        return { ...original, included: true };
      }
      return { ...original, temperature: "cold" as const, included: false, reason: `${original.reason} · 强制加入失败：预算不足` };
    }
    if (original.temperature === "cold" || used + original.estimatedTokens > tokenLimit) {
      return { ...original, temperature: "cold" as const, included: false };
    }
    used += original.estimatedTokens;
    return { ...original, temperature: "green" as const, included: true };
  });
  const includedItems = resolved.filter((entry) => entry.included);
  return { items: resolved, includedItems, estimatedTokens: used, maxInputTokens };
}

export function renderContext(items: ContextItem[]) {
  const byCategory = new Map<string, ContextItem[]>();
  for (const entry of items.filter((candidate) => candidate.included !== false)) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }
  return [...byCategory.entries()].map(([category, entries]) => {
    const body = entries.map((entry) => `<source title="${entry.title}" reason="${entry.reason}">\n${entry.excerpt}\n</source>`).join("\n");
    return `<context category="${category}">\n${body}\n</context>`;
  }).join("\n\n");
}
