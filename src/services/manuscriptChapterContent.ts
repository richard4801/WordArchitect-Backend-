import { getSupabaseClient } from "../lib/supabaseClient.js";
import { splitIntoChapterParagraphs } from "../lib/chapterParagraphs.js";

export interface UpsertChapterEditorContentParams {
  userId: string;
  bookId: string;
  chapterNumber: number;
  rawText: string;
  title?: string | null;
}

export type ChapterEditorAction = "created" | "appended";

// Appends rawText (split into paragraph objects) to a chapter's rich-editor
// content, creating the manuscript_chapters row if it doesn't exist yet.
// Extracted from saveManuscriptScene (manuscriptSceneSave.ts) so the same
// "text landed in AI memory should also land in the editor" behavior can
// be reused by the bulk-import pipeline (manuscriptIngest.ts,
// manuscriptImportJob.ts) without a second, independently-drifting copy —
// bulk-importing a manuscript previously only populated manuscript_chunks
// (Deep Past retrieval memory), leaving imported chapters invisible in the
// Chapters list/Outliner with nothing to open or read.
//
// Appends rather than replaces existing editor content, so this is always
// safe to call even if the chapter already has content (from the editor,
// from save-scene, or from a previous import). `title` is only used when
// creating a brand-new chapter row -- an existing chapter's title is never
// overwritten by a later append.
//
// Marks synced_to_memory_at immediately: this is always called right
// alongside the chunk/embed step that already put the same text into
// manuscript_chunks, so the editor content IS already reflected in
// retrieval memory the moment this returns -- there's nothing to sync.
export async function upsertChapterEditorContent(
  params: UpsertChapterEditorContentParams
): Promise<ChapterEditorAction> {
  const { userId, bookId, chapterNumber, rawText, title } = params;
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
    return "appended";
  }

  const { error: insertErr } = await supabase.from("manuscript_chapters").insert({
    user_id: userId,
    book_id: bookId,
    number: chapterNumber,
    title: title ?? null,
    paragraphs: newParagraphs,
    complete: false,
    synced_to_memory_at: syncedAt,
  });
  if (insertErr) throw new Error(`Failed to create chapter content: ${insertErr.message}`);
  return "created";
}
