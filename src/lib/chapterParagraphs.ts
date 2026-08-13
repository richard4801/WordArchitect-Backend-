import { randomUUID } from "node:crypto";

// Splits plain manuscript text on blank-line boundaries into
// manuscript_chapters-shaped paragraph objects ({ id, text }) — the same
// convention chunkManuscriptText (manuscriptIngest.ts) joins paragraphs
// with when building a chunk's raw_text, so this is the inverse of that
// join. Shared between save_manuscript_scene (mcp/tools.ts) and the
// one-time backfill script (scripts/backfill-project-and-chapters.ts) so
// both paths reconstruct paragraphs identically.
export function splitIntoChapterParagraphs(rawText: string): { id: string; text: string }[] {
  return rawText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((text) => ({ id: randomUUID(), text }));
}
