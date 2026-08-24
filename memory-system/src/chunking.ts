import { sha256 } from "./ids.js";

export interface TextChunk {
  seq: number;
  spanStart: number;
  spanEnd: number;
  content: string;
  contentHash: string;
  chapterLabel: string | null;
}

const chapterPattern = /^(?:第[零一二三四五六七八九十百千0-9]+[章节卷部篇]|chapter\s+\d+)\b/i;

export function chunkText(content: string, maxChars = 2200): TextChunk[] {
  if (!content) return [];
  const chunks: TextChunk[] = [];
  let cursor = 0;
  let chapterLabel: string | null = null;
  let start = 0;

  const flush = (end: number) => {
    if (end <= start) return;
    const text = content.slice(start, end);
    if (!text.trim()) { start = end; return; }
    chunks.push({ seq: chunks.length + 1, spanStart: start, spanEnd: end, content: text, contentHash: sha256(text), chapterLabel });
    start = end;
  };

  for (const line of content.split(/(?<=\n)/)) {
    const lineStart = cursor;
    cursor += line.length;
    if (chapterPattern.test(line.trim())) {
      flush(lineStart);
      chapterLabel = line.trim().slice(0, 160);
    }
    if (cursor - start >= maxChars) {
      const paragraphEnd = content.lastIndexOf("\n\n", cursor);
      if (paragraphEnd >= start + Math.floor(maxChars * 0.55)) flush(paragraphEnd + 2);
      while (cursor - start > maxChars) flush(start + maxChars);
    }
  }
  flush(content.length);
  return chunks;
}
