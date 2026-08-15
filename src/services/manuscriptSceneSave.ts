import { getSupabaseClient } from "../lib/supabaseClient.js";
import { ingestManuscriptText } from "./manuscriptIngest.js";
import { splitIntoChapterParagraphs } from "../lib/chapterParagraphs.js";

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
// retrieval memory and the editor the writer actually sees. Appends
// rather than replaces existing editor content, so this never overwrites
// anything the writer was editing themselves. Shared by
// POST /api/v1/manuscript/save-scene and the MCP save_manuscript_scene
// tool — one implementation, not two independently-drifting copies.
export async function saveManuscriptScene(params: SaveManuscriptSceneParams): Promise<SaveManuscriptSceneResult> {
  const { userId, bookId, chapterNumber, rawText } = params;

  const chunks = await ingestManuscriptText({ userId, bookId, chapterNumber, rawText });

  const supabase = getSupabaseClient();
  const newParagraphs = splitIntoChapterParagraphs(rawText);
  const syncedAt = new Date().toISOString();

  const { data: existingChapter, error: fetchErr } = await supabase
    .from("manuscript_chapters")
    .select("id, paragraphs")
    .eq("book_id", bookId)
    .eq("number", chapterNumber)
    .maybeSingle();
  if (fetchErr) throw new Error(`Failed to check existing chapter content: ${fetchErr.message}`);

  if (existingChapter) {
    const mergedParagraphs = [...((existingChapter.paragraphs as unknown[]) ?? []), ...newParagraphs];
    const { error: updateErr } = await supabase
      .from("manuscript_chapters")
      .update({ paragraphs: mergedParagraphs, synced_to_memory_at: syncedAt, updated_at: syncedAt })
      .eq("id", existingChapter.id);
    if (updateErr) throw new Error(`Failed to update chapter content: ${updateErr.message}`);
  } else {
    const { error: insertErr } = await supabase.from("manuscript_chapters").insert({
      user_id: userId,
      book_id: bookId,
      number: chapterNumber,
      paragraphs: newParagraphs,
      complete: false,
      synced_to_memory_at: syncedAt,
    });
    if (insertErr) throw new Error(`Failed to create chapter content: ${insertErr.message}`);
  }

  return { chunksSaved: chunks.length, chapterAction: existingChapter ? "appended" : "created" };
}
