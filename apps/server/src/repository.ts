import type { CreateEntityInput, CreateProjectInput, SaveDocumentInput } from "@novel-studio/contracts";
import { countHanWords, isoNow, newId, parseJson, sqlite } from "./db.js";

type Row = Record<string, unknown>;

function createDocument(projectId: string, kind: string, ownerType: string, ownerId: string, title: string, text = "") {
  const id = newId();
  const versionId = newId();
  const now = isoNow();
  const contentJson = JSON.stringify(text ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } : { type: "doc", content: [{ type: "paragraph" }] });
  sqlite.prepare(`
    INSERT INTO documents(id, project_id, kind, owner_type, owner_id, title, current_version_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, kind, ownerType, ownerId, title, versionId, now, now);
  sqlite.prepare(`
    INSERT INTO document_versions(id, document_id, content_json, plain_text, html, word_count, origin, message, created_at)
    VALUES (?, ?, ?, ?, '', ?, 'system', '初始化', ?)
  `).run(versionId, id, contentJson, text, countHanWords(text), now);
  indexDocument(id, projectId, kind, title, text);
  return id;
}

function indexDocument(sourceId: string, projectId: string, kind: string, title: string, content: string) {
  sqlite.prepare("DELETE FROM knowledge_fts WHERE source_id = ?").run(sourceId);
  if (content.trim()) {
    sqlite.prepare("INSERT INTO knowledge_fts(source_id, project_id, kind, title, content) VALUES (?, ?, ?, ?, ?)")
      .run(sourceId, projectId, kind, title, content);
  }
}

export function listProjects() {
  return sqlite.prepare(`
    SELECT p.id, p.title, p.genre, p.status, p.target_words AS targetWords, p.updated_at AS updatedAt,
      COALESCE(SUM(v.word_count), 0) AS wordCount
    FROM projects p
    LEFT JOIN documents d ON d.project_id = p.id AND d.kind = 'chapter_content'
    LEFT JOIN document_versions v ON v.id = d.current_version_id
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `).all();
}

export function createProject(input: CreateProjectInput) {
  return sqlite.transaction(() => {
    const id = newId();
    const now = isoNow();
    sqlite.prepare(`
      INSERT INTO projects(id, title, genre, premise, target_words, pov, audience, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?)
    `).run(id, input.title, input.genre, input.premise, input.targetWords, input.pov, input.audience, now, now);

    createDocument(id, "premise", "project", id, "核心创意", input.premise);
    createDocument(id, "synopsis", "project", id, "作品简介");
    createDocument(id, "style_guide", "project", id, "文风与约束", `叙事视角：${input.pov}\n目标读者：${input.audience}`);
    createDocument(id, "book_outline", "project", id, "全书总纲");

    const volumeId = newId();
    sqlite.prepare(`INSERT INTO volumes(id, project_id, title, position, created_at, updated_at) VALUES (?, ?, '第一卷', 1, ?, ?)`)
      .run(volumeId, id, now, now);
    const volumeOutlineId = createDocument(id, "volume_outline", "volume", volumeId, "第一卷卷纲");
    sqlite.prepare("UPDATE volumes SET outline_document_id = ? WHERE id = ?").run(volumeOutlineId, volumeId);

    const chapterId = newId();
    sqlite.prepare(`INSERT INTO chapters(id, project_id, volume_id, title, position, created_at, updated_at) VALUES (?, ?, ?, '第一章', 1, ?, ?)`)
      .run(chapterId, id, volumeId, now, now);
    const chapterOutlineId = createDocument(id, "chapter_outline", "chapter", chapterId, "第一章章纲");
    const chapterContentId = createDocument(id, "chapter_content", "chapter", chapterId, "第一章正文");
    sqlite.prepare("UPDATE chapters SET outline_document_id = ?, content_document_id = ? WHERE id = ?")
      .run(chapterOutlineId, chapterContentId, chapterId);

    sqlite.prepare(`INSERT INTO scenes(id, chapter_id, title, summary, position, created_at, updated_at) VALUES (?, ?, '场景一', '', 1, ?, ?)`)
      .run(newId(), chapterId, now, now);
    return { id };
  })();
}

export function getProjectTree(projectId: string) {
  const project = sqlite.prepare(`
    SELECT p.id, p.title, p.genre, p.status, p.target_words AS targetWords, p.premise, p.pov, p.audience,
      p.updated_at AS updatedAt, COALESCE(SUM(v.word_count), 0) AS wordCount
    FROM projects p
    LEFT JOIN documents d ON d.project_id = p.id AND d.kind = 'chapter_content'
    LEFT JOIN document_versions v ON v.id = d.current_version_id
    WHERE p.id = ? GROUP BY p.id
  `).get(projectId) as Row | undefined;
  if (!project) return null;
  const volumes = sqlite.prepare("SELECT id, title, position, outline_document_id AS outlineDocumentId FROM volumes WHERE project_id = ? ORDER BY position").all(projectId) as Row[];
  const chapterQuery = sqlite.prepare(`
    SELECT c.id, c.title, c.position, c.status, c.outline_document_id AS outlineDocumentId,
      c.content_document_id AS documentId, COALESCE(v.word_count, 0) AS wordCount
    FROM chapters c
    LEFT JOIN documents d ON d.id = c.content_document_id
    LEFT JOIN document_versions v ON v.id = d.current_version_id
    WHERE c.volume_id = ? ORDER BY c.position
  `);
  const sceneQuery = sqlite.prepare("SELECT id, title, position, summary, goal, conflict, outcome FROM scenes WHERE chapter_id = ? ORDER BY position");
  return {
    project,
    volumes: volumes.map((volume) => ({
      ...volume,
      chapters: (chapterQuery.all(volume.id) as Row[]).map((chapter) => ({
        ...chapter,
        scenes: sceneQuery.all(chapter.id),
      })),
    })),
  };
}

export function createVolume(projectId: string, title: string) {
  return sqlite.transaction(() => {
    const id = newId();
    const now = isoNow();
    const position = (sqlite.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS value FROM volumes WHERE project_id = ?").get(projectId) as { value: number }).value;
    sqlite.prepare("INSERT INTO volumes(id, project_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, projectId, title || `第${position}卷`, position, now, now);
    const outlineDocumentId = createDocument(projectId, "volume_outline", "volume", id, `${title || `第${position}卷`}卷纲`);
    sqlite.prepare("UPDATE volumes SET outline_document_id = ? WHERE id = ?").run(outlineDocumentId, id);
    return { id };
  })();
}

export function createChapter(volumeId: string, title: string) {
  return sqlite.transaction(() => {
    const volume = sqlite.prepare("SELECT project_id AS projectId FROM volumes WHERE id = ?").get(volumeId) as { projectId: string } | undefined;
    if (!volume) throw new Error("卷不存在");
    const id = newId();
    const now = isoNow();
    const position = (sqlite.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS value FROM chapters WHERE volume_id = ?").get(volumeId) as { value: number }).value;
    const chapterTitle = title || `第${position}章`;
    sqlite.prepare("INSERT INTO chapters(id, project_id, volume_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, volume.projectId, volumeId, chapterTitle, position, now, now);
    const outlineDocumentId = createDocument(volume.projectId, "chapter_outline", "chapter", id, `${chapterTitle}章纲`);
    const contentDocumentId = createDocument(volume.projectId, "chapter_content", "chapter", id, `${chapterTitle}正文`);
    sqlite.prepare("UPDATE chapters SET outline_document_id = ?, content_document_id = ? WHERE id = ?")
      .run(outlineDocumentId, contentDocumentId, id);
    sqlite.prepare("INSERT INTO scenes(id, chapter_id, title, position, created_at, updated_at) VALUES (?, ?, '场景一', 1, ?, ?)")
      .run(newId(), id, now, now);
    return { id };
  })();
}

export function createScene(chapterId: string, title: string) {
  const id = newId();
  const now = isoNow();
  const position = (sqlite.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS value FROM scenes WHERE chapter_id = ?").get(chapterId) as { value: number }).value;
  sqlite.prepare("INSERT INTO scenes(id, chapter_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, chapterId, title || `场景${position}`, position, now, now);
  return { id };
}

export function getDocument(documentId: string) {
  const row = sqlite.prepare(`
    SELECT d.*, v.content_json, v.plain_text, v.html, v.word_count, v.created_at AS version_created_at
    FROM documents d LEFT JOIN document_versions v ON v.id = d.current_version_id WHERE d.id = ?
  `).get(documentId) as Row | undefined;
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    currentVersionId: row.current_version_id,
    contentJson: parseJson(row.content_json, { type: "doc", content: [{ type: "paragraph" }] }),
    plainText: row.plain_text ?? "",
    html: row.html ?? "",
    wordCount: row.word_count ?? 0,
    updatedAt: row.updated_at,
  };
}

export function saveDocument(documentId: string, input: SaveDocumentInput, origin = "manual") {
  return sqlite.transaction(() => {
    const document = sqlite.prepare("SELECT * FROM documents WHERE id = ?").get(documentId) as Row | undefined;
    if (!document) throw new Error("文档不存在");
    if (input.expectedVersionId !== undefined && input.expectedVersionId !== document.current_version_id) {
      const error = new Error("文档已被其他修改更新");
      (error as Error & { code: string }).code = "VERSION_CONFLICT";
      throw error;
    }
    const versionId = newId();
    const now = isoNow();
    sqlite.prepare(`
      INSERT INTO document_versions(id, document_id, parent_version_id, content_json, plain_text, html, word_count, origin, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(versionId, documentId, document.current_version_id, JSON.stringify(input.contentJson), input.plainText, input.html, countHanWords(input.plainText), origin, input.message, now);
    sqlite.prepare("UPDATE documents SET current_version_id = ?, draft_json = NULL, draft_plain_text = NULL, draft_html = NULL, updated_at = ? WHERE id = ?")
      .run(versionId, now, documentId);
    sqlite.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, document.project_id);
    indexDocument(documentId, String(document.project_id), String(document.kind), String(document.title), input.plainText);
    if (document.kind === "chapter_content") {
      if (document.current_version_id) {
        sqlite.prepare("UPDATE arc_summaries SET stale=1 WHERE project_id=? AND source_versions_json LIKE ?")
          .run(document.project_id, `%${String(document.current_version_id)}%`);
      }
      const chapter = sqlite.prepare(`SELECT c.position, v.position AS volume_position FROM chapters c JOIN volumes v ON v.id=c.volume_id WHERE c.id=?`)
        .get(document.owner_id) as { position: number; volume_position: number } | undefined;
      if (chapter) {
        sqlite.prepare(`UPDATE chapter_summaries SET stale=1 WHERE chapter_id IN (
          SELECT c.id FROM chapters c JOIN volumes v ON v.id=c.volume_id
          WHERE c.project_id=? AND (v.position>? OR (v.position=? AND c.position>=?))
        )`).run(document.project_id, chapter.volume_position, chapter.volume_position, chapter.position);
      }
      sqlite.prepare("UPDATE facts SET status='stale',updated_at=? WHERE source_document_id=? AND source_version_id<>?")
        .run(now, documentId, versionId);
    }
    return { versionId, wordCount: countHanWords(input.plainText) };
  })();
}

export function listVersions(documentId: string) {
  return sqlite.prepare(`
    SELECT id, parent_version_id AS parentVersionId, word_count AS wordCount, origin, message, created_at AS createdAt
    FROM document_versions WHERE document_id = ? ORDER BY created_at DESC
  `).all(documentId);
}

export function restoreVersion(documentId: string, versionId: string) {
  const version = sqlite.prepare("SELECT content_json AS contentJson, plain_text AS plainText, html FROM document_versions WHERE id = ? AND document_id = ?")
    .get(versionId, documentId) as { contentJson: string; plainText: string; html: string } | undefined;
  if (!version) throw new Error("历史版本不存在");
  return saveDocument(documentId, {
    contentJson: parseJson(version.contentJson, {}),
    plainText: version.plainText,
    html: version.html,
    message: "恢复历史版本",
  }, "restore");
}

export function listEntities(projectId: string) {
  return (sqlite.prepare("SELECT * FROM entities WHERE project_id = ? ORDER BY type, updated_at DESC").all(projectId) as Row[]).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    name: row.name,
    summary: row.summary,
    aliases: parseJson(row.aliases_json, []),
    attributes: parseJson(row.attributes_json, {}),
    visibility: row.visibility,
    version: row.current_version,
    updatedAt: row.updated_at,
  }));
}

export function createEntity(projectId: string, input: CreateEntityInput) {
  const id = newId();
  const now = isoNow();
  const snapshot = { ...input, id };
  sqlite.transaction(() => {
    sqlite.prepare(`
      INSERT INTO entities(id, project_id, type, name, summary, aliases_json, attributes_json, visibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, input.type, input.name, input.summary, JSON.stringify(input.aliases), JSON.stringify(input.attributes), input.visibility, now, now);
    sqlite.prepare("INSERT INTO entity_versions(id, entity_id, version, snapshot_json, origin, message, created_at) VALUES (?, ?, 1, ?, 'manual', '创建设定', ?)")
      .run(newId(), id, JSON.stringify(snapshot), now);
    indexDocument(id, projectId, `entity:${input.type}`, input.name, `${input.name}\n${input.summary}\n${JSON.stringify(input.attributes)}`);
  })();
  return { id };
}

export function updateEntity(entityId: string, input: CreateEntityInput) {
  const current = sqlite.prepare("SELECT * FROM entities WHERE id = ?").get(entityId) as Row | undefined;
  if (!current) throw new Error("设定不存在");
  const version = Number(current.current_version) + 1;
  const now = isoNow();
  sqlite.transaction(() => {
    sqlite.prepare(`UPDATE entities SET type=?, name=?, summary=?, aliases_json=?, attributes_json=?, visibility=?, current_version=?, updated_at=? WHERE id=?`)
      .run(input.type, input.name, input.summary, JSON.stringify(input.aliases), JSON.stringify(input.attributes), input.visibility, version, now, entityId);
    sqlite.prepare("INSERT INTO entity_versions(id, entity_id, version, snapshot_json, origin, message, created_at) VALUES (?, ?, ?, ?, 'manual', '编辑设定', ?)")
      .run(newId(), entityId, version, JSON.stringify({ ...input, id: entityId }), now);
    indexDocument(entityId, String(current.project_id), `entity:${input.type}`, input.name, `${input.name}\n${input.summary}\n${JSON.stringify(input.attributes)}`);
  })();
  return { version };
}

export function listForeshadows(projectId: string) {
  return sqlite.prepare(`SELECT id, title, detail, status, setup_chapter_id AS setupChapterId, target_chapter_id AS targetChapterId,
    resolved_chapter_id AS resolvedChapterId, evidence, updated_at AS updatedAt FROM foreshadows WHERE project_id = ? ORDER BY status, updated_at DESC`).all(projectId);
}

export function createForeshadow(projectId: string, input: { title: string; detail?: string; targetChapterId?: string | null }) {
  const id = newId();
  const now = isoNow();
  sqlite.prepare(`INSERT INTO foreshadows(id, project_id, title, detail, status, target_chapter_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`)
    .run(id, projectId, input.title, input.detail ?? "", input.targetChapterId ?? null, now, now);
  return { id };
}

export function searchKnowledge(projectId: string, query: string, limit = 8) {
  if (!query.trim()) return [];
  const normalized = query.replace(/["'()*:^]/g, " ").trim();
  if (normalized.length < 3) return [];
  try {
    return sqlite.prepare(`
      SELECT source_id AS sourceId, kind, title, snippet(knowledge_fts, 4, '[', ']', '…', 24) AS excerpt,
        bm25(knowledge_fts) AS score
      FROM knowledge_fts WHERE knowledge_fts MATCH ? AND project_id = ? ORDER BY score LIMIT ?
    `).all(normalized, projectId, limit);
  } catch {
    return [];
  }
}

export function getProjectDocuments(projectId: string) {
  return sqlite.prepare(`
    SELECT d.id, d.kind, d.title, d.owner_type AS ownerType, d.owner_id AS ownerId,
      d.current_version_id AS currentVersionId, v.plain_text AS plainText, v.word_count AS wordCount
    FROM documents d LEFT JOIN document_versions v ON v.id = d.current_version_id
    WHERE d.project_id = ? ORDER BY d.created_at
  `).all(projectId);
}

export function listFacts(projectId: string) {
  return sqlite.prepare(`SELECT f.*, e.name AS subject_name FROM facts f LEFT JOIN entities e ON e.id = f.subject_entity_id
    WHERE f.project_id = ? ORDER BY f.created_at DESC`).all(projectId);
}

export function listMemoryConflicts(projectId: string) {
  return (sqlite.prepare(`SELECT mc.*, e.name AS subject_name, f.object_text AS existing_object
    FROM memory_conflicts mc
    LEFT JOIN entities e ON e.id=mc.subject_entity_id
    LEFT JOIN facts f ON f.id=mc.existing_fact_id
    WHERE mc.project_id=? ORDER BY CASE mc.status WHEN 'open' THEN 0 ELSE 1 END, mc.created_at DESC`).all(projectId) as Row[]).map((row) => ({
      id: row.id,
      subjectName: row.subject_name,
      predicate: row.predicate,
      existingObject: row.existing_object,
      candidate: parseJson(row.candidate_json, {}),
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
    }));
}
