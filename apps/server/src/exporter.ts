import JSZip from "jszip";
import { isoNow, newId, sqlite } from "./db.js";

type Row = Record<string, unknown>;

function xmlEscape(value: unknown) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function chaptersForExport(projectId: string) {
  return sqlite.prepare(`
    SELECT v.title AS volume_title, v.position AS volume_position, c.id, c.title, c.position,
      dv.plain_text AS content
    FROM chapters c
    JOIN volumes v ON v.id = c.volume_id
    JOIN documents d ON d.id = c.content_document_id
    JOIN document_versions dv ON dv.id = d.current_version_id
    WHERE c.project_id = ?
    ORDER BY v.position, c.position
  `).all(projectId) as Row[];
}

export function exportManuscript(projectId: string, format: "txt" | "md") {
  const project = sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Row | undefined;
  if (!project) throw new Error("作品不存在");
  const chapters = chaptersForExport(projectId);
  if (format === "txt") {
    const chunks = [String(project.title), ""];
    let currentVolume = "";
    for (const chapter of chapters) {
      if (chapter.volume_title !== currentVolume) {
        currentVolume = String(chapter.volume_title);
        chunks.push(currentVolume, "");
      }
      chunks.push(String(chapter.title), "", String(chapter.content ?? ""), "");
    }
    return Buffer.from(chunks.join("\n"), "utf8");
  }
  const chunks = [`# ${project.title}`, ""];
  let currentVolume = "";
  for (const chapter of chapters) {
    if (chapter.volume_title !== currentVolume) {
      currentVolume = String(chapter.volume_title);
      chunks.push(`## ${currentVolume}`, "");
    }
    chunks.push(`### ${chapter.title}`, "", String(chapter.content ?? ""), "");
  }
  return Buffer.from(chunks.join("\n"), "utf8");
}

export async function exportEpub(projectId: string) {
  const project = sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Row | undefined;
  if (!project) throw new Error("作品不存在");
  const chapters = chaptersForExport(projectId);
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file("OEBPS/styles.css", `body{font-family:serif;line-height:1.8;margin:5%;}h1,h2{text-align:center;}p{text-indent:2em;margin:.6em 0;}`);
  const manifest: string[] = [];
  const spine: string[] = [];
  const navItems: string[] = [];
  chapters.forEach((chapter, index) => {
    const filename = `chapter-${index + 1}.xhtml`;
    const paragraphs = String(chapter.content ?? "").split(/\n{2,}/).filter(Boolean).map((paragraph) => `<p>${xmlEscape(paragraph).replaceAll("\n", "<br/>")}</p>`).join("\n");
    zip.file(`OEBPS/${filename}`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><title>${xmlEscape(chapter.title)}</title><link rel="stylesheet" href="styles.css"/></head><body><h1>${xmlEscape(chapter.title)}</h1>${paragraphs}</body></html>`);
    manifest.push(`<item id="chapter-${index + 1}" href="${filename}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="chapter-${index + 1}"/>`);
    navItems.push(`<li><a href="${filename}">${xmlEscape(chapter.title)}</a></li>`);
  });
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol>${navItems.join("")}</ol></nav></body></html>`);
  const identifier = `urn:uuid:${project.id}`;
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${identifier}</dc:identifier><dc:title>${xmlEscape(project.title)}</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">${isoNow().replace(/\.\d{3}Z$/, "Z")}</meta></metadata>
  <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="styles.css" media-type="text/css"/>${manifest.join("")}</manifest>
  <spine>${spine.join("")}</spine>
</package>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

const bundleTables = [
  "volumes", "chapters", "scenes", "documents", "document_versions", "entities", "entity_versions",
  "facts", "foreshadows", "chapter_summaries", "arc_summaries", "ai_jobs", "job_events", "proposals", "review_findings", "memory_conflicts",
] as const;

export async function exportProjectBundle(projectId: string) {
  const project = sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Row | undefined;
  if (!project) throw new Error("作品不存在");
  const data: Record<string, unknown> = { project };
  data.volumes = sqlite.prepare("SELECT * FROM volumes WHERE project_id = ?").all(projectId);
  data.chapters = sqlite.prepare("SELECT * FROM chapters WHERE project_id = ?").all(projectId);
  const chapterIds = (data.chapters as Row[]).map((row) => row.id);
  data.scenes = chapterIds.length ? sqlite.prepare(`SELECT * FROM scenes WHERE chapter_id IN (${chapterIds.map(() => "?").join(",")})`).all(...chapterIds) : [];
  data.documents = sqlite.prepare("SELECT * FROM documents WHERE project_id = ?").all(projectId);
  const documentIds = (data.documents as Row[]).map((row) => row.id);
  data.document_versions = documentIds.length ? sqlite.prepare(`SELECT * FROM document_versions WHERE document_id IN (${documentIds.map(() => "?").join(",")})`).all(...documentIds) : [];
  data.entities = sqlite.prepare("SELECT * FROM entities WHERE project_id = ?").all(projectId);
  const entityIds = (data.entities as Row[]).map((row) => row.id);
  data.entity_versions = entityIds.length ? sqlite.prepare(`SELECT * FROM entity_versions WHERE entity_id IN (${entityIds.map(() => "?").join(",")})`).all(...entityIds) : [];
  for (const table of ["facts", "foreshadows", "chapter_summaries", "arc_summaries", "ai_jobs", "proposals", "review_findings", "memory_conflicts"] as const) {
    data[table] = sqlite.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).all(projectId);
  }
  const jobIds = (data.ai_jobs as Row[]).map((row) => row.id);
  data.job_events = jobIds.length ? sqlite.prepare(`SELECT * FROM job_events WHERE job_id IN (${jobIds.map(() => "?").join(",")})`).all(...jobIds) : [];
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({ format: "novel-studio", schemaVersion: 4, exportedAt: isoNow(), title: project.title }, null, 2));
  zip.file("project.json", JSON.stringify(data));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function importProjectBundle(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const manifestFile = zip.file("manifest.json");
  const projectFile = zip.file("project.json");
  if (!manifestFile || !projectFile) throw new Error("项目包结构不完整");
  const manifest = JSON.parse(await manifestFile.async("string")) as { format: string; schemaVersion: number };
  if (manifest.format !== "novel-studio" || ![1, 2, 3, 4].includes(manifest.schemaVersion)) throw new Error("不支持的项目包格式");
  const data = JSON.parse(await projectFile.async("string")) as Record<string, Row | Row[]>;
  const sourceProject = data.project as Row;
  if (!sourceProject?.id) throw new Error("项目包缺少作品数据");

  const maps = new Map<string, string>();
  const map = (old: unknown) => {
    if (!old) return null;
    const key = String(old);
    if (!maps.has(key)) maps.set(key, newId());
    return maps.get(key)!;
  };
  const projectId = map(sourceProject.id)!;
  const now = isoNow();
  sqlite.transaction(() => {
    sqlite.prepare(`INSERT INTO projects(id,title,genre,premise,target_words,pov,audience,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(projectId, `${sourceProject.title}（导入）`, sourceProject.genre, sourceProject.premise, sourceProject.target_words, sourceProject.pov, sourceProject.audience, sourceProject.status, now, now);
    for (const row of (data.volumes as Row[] ?? [])) {
      sqlite.prepare("INSERT INTO volumes(id,project_id,title,position,outline_document_id,created_at,updated_at) VALUES (?,?,?,?,NULL,?,?)")
        .run(map(row.id), projectId, row.title, row.position, now, now);
    }
    for (const row of (data.chapters as Row[] ?? [])) {
      sqlite.prepare(`INSERT INTO chapters(id,project_id,volume_id,title,position,status,outline_document_id,content_document_id,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,NULL,?,?)`)
        .run(map(row.id), projectId, map(row.volume_id), row.title, row.position, row.status, now, now);
    }
    for (const row of (data.scenes as Row[] ?? [])) {
      sqlite.prepare(`INSERT INTO scenes(id,chapter_id,title,summary,goal,conflict,outcome,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(map(row.id), map(row.chapter_id), row.title, row.summary, row.goal, row.conflict, row.outcome, row.position, now, now);
    }
    for (const row of (data.documents as Row[] ?? [])) {
      sqlite.prepare(`INSERT INTO documents(id,project_id,kind,owner_type,owner_id,title,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)`)
        .run(map(row.id), projectId, row.kind, row.owner_type, map(row.owner_id), row.title, now, now);
    }
    for (const row of (data.document_versions as Row[] ?? [])) {
      sqlite.prepare(`INSERT INTO document_versions(id,document_id,parent_version_id,content_json,plain_text,html,word_count,origin,message,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(map(row.id), map(row.document_id), map(row.parent_version_id), row.content_json, row.plain_text, row.html, row.word_count, row.origin, row.message, row.created_at ?? now);
    }
    for (const row of (data.documents as Row[] ?? [])) {
      sqlite.prepare("UPDATE documents SET current_version_id=? WHERE id=?").run(map(row.current_version_id), map(row.id));
    }
    for (const row of (data.volumes as Row[] ?? [])) sqlite.prepare("UPDATE volumes SET outline_document_id=? WHERE id=?").run(map(row.outline_document_id), map(row.id));
    for (const row of (data.chapters as Row[] ?? [])) sqlite.prepare("UPDATE chapters SET outline_document_id=?, content_document_id=? WHERE id=?")
      .run(map(row.outline_document_id), map(row.content_document_id), map(row.id));
    for (const row of (data.entities as Row[] ?? [])) {
      sqlite.prepare(`INSERT INTO entities(id,project_id,type,name,summary,aliases_json,attributes_json,visibility,current_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(map(row.id), projectId, row.type, row.name, row.summary, row.aliases_json, row.attributes_json, row.visibility, row.current_version, now, now);
    }
    for (const row of (data.entity_versions as Row[] ?? [])) {
      sqlite.prepare(`INSERT INTO entity_versions(id,entity_id,version,snapshot_json,origin,message,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(map(row.id), map(row.entity_id), row.version, row.snapshot_json, row.origin, row.message, row.created_at ?? now);
    }
    for (const row of (data.foreshadows as Row[] ?? [])) {
      sqlite.prepare(`INSERT INTO foreshadows(id,project_id,title,detail,status,setup_chapter_id,target_chapter_id,resolved_chapter_id,evidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(map(row.id), projectId, row.title, row.detail, row.status, map(row.setup_chapter_id), map(row.target_chapter_id), map(row.resolved_chapter_id), row.evidence, now, now);
    }
    for (const row of (data.facts as Row[] ?? [])) {
      sqlite.prepare(`INSERT INTO facts(id,project_id,subject_entity_id,predicate,object_text,valid_from_chapter_id,valid_to_chapter_id,source_document_id,source_version_id,evidence,fact_kind,mutable,confidence,visibility,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(map(row.id), projectId, map(row.subject_entity_id), row.predicate, row.object_text, map(row.valid_from_chapter_id), map(row.valid_to_chapter_id), map(row.source_document_id), map(row.source_version_id), row.evidence, row.fact_kind ?? "state", row.mutable ?? 1, row.confidence ?? 1, row.visibility, row.status, row.created_at ?? now, row.updated_at ?? now);
    }
    for (const row of (data.chapter_summaries as Row[] ?? [])) {
      sqlite.prepare(`INSERT INTO chapter_summaries(id,project_id,chapter_id,source_version_id,summary,continuation_excerpt,state_delta_json,stale,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(map(row.id), projectId, map(row.chapter_id), map(row.source_version_id), row.summary, row.continuation_excerpt ?? "", row.state_delta_json, row.stale, row.created_at ?? now);
    }
    for (const row of (data.arc_summaries as Row[] ?? [])) {
      const sourceVersions = JSON.parse(String(row.source_versions_json || "[]")) as string[];
      sqlite.prepare(`INSERT INTO arc_summaries(id,project_id,start_chapter_id,end_chapter_id,source_versions_json,summary,open_threads_json,stale,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(map(row.id), projectId, map(row.start_chapter_id), map(row.end_chapter_id), JSON.stringify(sourceVersions.map(map)), row.summary, row.open_threads_json, row.stale, row.created_at ?? now);
    }
    for (const row of (data.ai_jobs as Row[] ?? [])) {
      const status = ["queued", "running"].includes(String(row.status)) ? "interrupted" : row.status;
      const contextItems = JSON.parse(String(row.context_snapshot_json || "[]")) as Array<Record<string, unknown>>;
      const remappedContext = contextItems.map((entry) => ({ ...entry, id: maps.get(String(entry.id)) ?? entry.id, sourceVersionId: entry.sourceVersionId ? maps.get(String(entry.sourceVersionId)) ?? entry.sourceVersionId : null }));
      sqlite.prepare(`INSERT INTO ai_jobs(id,project_id,document_id,scene_id,type,status,model_profile,model_snapshot_json,instruction,selection_json,context_snapshot_json,prompt_snapshot,base_version_id,output_text,error,input_tokens,output_tokens,retry_of_job_id,decision_json,created_at,started_at,finished_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)`)
        .run(map(row.id), projectId, map(row.document_id), map(row.scene_id), row.type, status, row.model_profile, row.model_snapshot_json, row.instruction, row.selection_json ?? null, JSON.stringify(remappedContext), row.prompt_snapshot, map(row.base_version_id), row.output_text, row.error, row.input_tokens, row.output_tokens, row.decision_json ?? null, row.created_at ?? now, row.started_at, row.finished_at);
    }
    for (const row of (data.ai_jobs as Row[] ?? [])) {
      if (row.retry_of_job_id) sqlite.prepare("UPDATE ai_jobs SET retry_of_job_id=? WHERE id=?").run(map(row.retry_of_job_id), map(row.id));
    }
    for (const row of (data.job_events as Row[] ?? [])) {
      sqlite.prepare("INSERT INTO job_events(job_id,type,payload_json,created_at) VALUES (?,?,?,?)")
        .run(map(row.job_id), row.type, row.payload_json, row.created_at ?? now);
    }
    for (const row of (data.proposals as Row[] ?? [])) {
      const payload = JSON.parse(String(row.payload_json || "{}")) as Record<string, unknown>;
      if (row.target_type === "arc_memory") {
        if (Array.isArray(payload.sourceChapterIds)) payload.sourceChapterIds = payload.sourceChapterIds.map(map);
        if (Array.isArray(payload.sourceVersionIds)) payload.sourceVersionIds = payload.sourceVersionIds.map(map);
      }
      sqlite.prepare(`INSERT INTO proposals(id,project_id,job_id,target_type,target_id,base_version_id,status,title,payload_json,created_at,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(map(row.id), projectId, map(row.job_id), row.target_type, map(row.target_id), map(row.base_version_id), row.status, row.title, JSON.stringify(payload), row.created_at ?? now, row.decided_at);
    }
    for (const row of (data.review_findings as Row[] ?? [])) {
      sqlite.prepare(`INSERT INTO review_findings(id,project_id,job_id,document_id,category,severity,title,evidence,suggestion,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(map(row.id), projectId, map(row.job_id), map(row.document_id), row.category, row.severity, row.title, row.evidence, row.suggestion, row.status, row.created_at ?? now);
    }
    for (const row of (data.memory_conflicts as Row[] ?? [])) {
      sqlite.prepare(`INSERT INTO memory_conflicts(id,project_id,proposal_id,subject_entity_id,predicate,existing_fact_id,candidate_json,reason,status,created_at,resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(map(row.id), projectId, map(row.proposal_id), map(row.subject_entity_id), row.predicate, map(row.existing_fact_id), row.candidate_json, row.reason, row.status, row.created_at ?? now, row.resolved_at);
    }
  })();
  sqlite.prepare("DELETE FROM knowledge_fts WHERE project_id=?").run(projectId);
  const importedDocuments = sqlite.prepare(`SELECT d.id,d.kind,d.title,v.plain_text AS content FROM documents d JOIN document_versions v ON v.id=d.current_version_id WHERE d.project_id=?`).all(projectId) as Row[];
  const indexInsert = sqlite.prepare("INSERT INTO knowledge_fts(source_id,project_id,kind,title,content) VALUES (?,?,?,?,?)");
  for (const row of importedDocuments) if (String(row.content ?? "").trim()) indexInsert.run(row.id, projectId, row.kind, row.title, row.content);
  const importedEntities = sqlite.prepare("SELECT * FROM entities WHERE project_id=?").all(projectId) as Row[];
  for (const row of importedEntities) indexInsert.run(row.id, projectId, `entity:${row.type}`, row.name, `${row.name}\n${row.summary}\n${row.attributes_json}`);
  return { id: projectId };
}
