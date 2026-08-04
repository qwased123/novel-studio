import { sqlite } from "./db.js";
import { searchKnowledge } from "./repository.js";

type Row = Record<string, unknown>;

export interface MemoryQueryResult {
  query: string;
  matches: Array<{
    kind: string;
    title: string;
    excerpt: string;
    sourceId: string | null;
    sourceVersionId: string | null;
  }>;
}

function queryTerms(query: string) {
  const parts = query.split(/[\s，。！？、；：,.!?;:（）()《》“”"']+/).map((part) => part.trim()).filter((part) => part.length >= 2);
  const compact = query.replace(/[\s，。！？、；：,.!?;:（）()《》“”"']/g, "");
  if (compact.length >= 2) {
    parts.push(compact);
    for (let size = 2; size <= Math.min(4, compact.length); size += 1) {
      for (let index = 0; index <= compact.length - size; index += 1) parts.push(compact.slice(index, index + size));
    }
  }
  return [...new Set(parts)].sort((left, right) => right.length - left.length).slice(0, 32);
}

function score(text: string, terms: string[]) {
  return terms.reduce((total, term) => total + (text.includes(term) ? Math.max(1, term.length) : 0), 0);
}

export function queryActiveMemory(projectId: string, query: string, limit = 8): MemoryQueryResult {
  const terms = queryTerms(query);
  const matches: MemoryQueryResult["matches"] = [];

  for (const result of searchKnowledge(projectId, query, limit) as Row[]) {
    const sourceId = String(result.sourceId);
    const document = sqlite.prepare("SELECT current_version_id AS versionId FROM documents WHERE id=?").get(sourceId) as { versionId: string } | undefined;
    matches.push({
      kind: String(result.kind ?? "knowledge"),
      title: String(result.title ?? "检索结果"),
      excerpt: String(result.excerpt ?? "").replaceAll("[", "").replaceAll("]", ""),
      sourceId,
      sourceVersionId: document?.versionId ?? null,
    });
  }

  const facts = sqlite.prepare(`SELECT f.id,f.predicate,f.object_text,f.evidence,f.source_version_id,e.name AS subject_name
    FROM facts f LEFT JOIN entities e ON e.id=f.subject_entity_id
    WHERE f.project_id=? AND f.status='active' ORDER BY f.updated_at DESC LIMIT 240`).all(projectId) as Row[];
  for (const fact of facts) {
    const text = `${fact.subject_name ?? "全局"} ${fact.predicate} ${fact.object_text} ${fact.evidence ?? ""}`;
    const relevance = score(text, terms);
    if (!relevance) continue;
    matches.push({
      kind: "fact",
      title: `${fact.subject_name ?? "全局"} · ${fact.predicate}`,
      excerpt: `${fact.object_text}${fact.evidence ? `；证据：${fact.evidence}` : ""}`,
      sourceId: String(fact.id),
      sourceVersionId: fact.source_version_id ? String(fact.source_version_id) : null,
    });
  }

  const summaries = sqlite.prepare(`SELECT s.chapter_id,s.source_version_id,s.summary,c.title
    FROM chapter_summaries s JOIN chapters c ON c.id=s.chapter_id
    WHERE s.project_id=? AND s.stale=0 ORDER BY s.created_at DESC LIMIT 120`).all(projectId) as Row[];
  for (const summary of summaries) {
    const text = `${summary.title} ${summary.summary}`;
    if (!score(text, terms)) continue;
    matches.push({
      kind: "chapter_summary",
      title: String(summary.title),
      excerpt: String(summary.summary),
      sourceId: String(summary.chapter_id),
      sourceVersionId: String(summary.source_version_id),
    });
  }

  const arcs = sqlite.prepare(`SELECT a.id,a.summary,a.source_versions_json,sc.title AS start_title,ec.title AS end_title
    FROM arc_summaries a JOIN chapters sc ON sc.id=a.start_chapter_id JOIN chapters ec ON ec.id=a.end_chapter_id
    WHERE a.project_id=? AND a.stale=0 ORDER BY a.created_at DESC LIMIT 40`).all(projectId) as Row[];
  for (const arc of arcs) {
    const text = `${arc.start_title} ${arc.end_title} ${arc.summary}`;
    if (!score(text, terms)) continue;
    matches.push({
      kind: "arc_summary",
      title: `${arc.start_title} - ${arc.end_title}`,
      excerpt: String(arc.summary),
      sourceId: String(arc.id),
      sourceVersionId: null,
    });
  }

  const seen = new Set<string>();
  return {
    query,
    matches: matches.filter((match) => {
      const key = `${match.kind}:${match.sourceId}:${match.excerpt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit),
  };
}
