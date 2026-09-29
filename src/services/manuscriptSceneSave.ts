import { ingestManuscriptText } from "./manuscriptIngest.js";
import { upsertChapterEditorContent } from "./manuscriptChapterContent.js";

export interface SaveManuscriptSceneParams {
  userId: string;
  bookId: string;
  chapterNumber: number;
  rawText: string;
}

export interface SaveManuscriptSceneResult {
  chunksSaved: number;
  chapterAction: "created" | "appended";
}

// Saves accepted prose into permanent manuscript memory (chunked and
// embedded, via the normal ingest pipeline) AND appends it to that
// chapter's rich-editor content (manuscript_chapters), creating the
// chapter row if it doesn't exist yet — so a scene accepted from either
// the MCP server or the in-app Chat Assistant shows up in both Deep Past
// retrieval memory and the editor the writer actually sees. The editor-
// content half is upsertChapterEditorContent (manuscriptChapterContent.ts),
// shared with the bulk-import pipeline so both paths give imported/saved
// text the same treatment — one implementation, not two independently-
// drifting copies.
export async function saveManuscriptScene(params: SaveManuscriptSceneParams): Promise<SaveManuscriptSceneResult> {
  const { userId, bookId, chapterNumber, rawText } = params;

  const chunks = await ingestManuscriptText({ userId, bookId, chapterNumber, rawText });
  const chapterAction = await upsertChapterEditorContent({ userId, bookId, chapterNumber, rawText });

  return { chunksSaved: chunks.length, chapterAction };
}
