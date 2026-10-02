import { getSupabaseClient } from "../lib/supabaseClient.js";
import { generateEmbedding } from "./embedding.js";
import type { ManuscriptChunkMatch } from "../types/domain.js";

const SEARCH_MATCH_COUNT = 8;

// Shared read-only book-context queries — used by both the MCP server
// (src/mcp/tools.ts) and the in-app Chat Assistant's tool loop
// (src/services/chatAssistant.ts), so the two surfaces that let an LLM
// look up real Codex/manuscript data can't silently drift apart the way
// the Codex field lists were kept in sync deliberately (see mcp/tools.ts).

export async function listCodexEntries(bookId: string, entryType?: string) {
  const supabase = getSupabaseClient();
  let query = supabase.from("codex_entries").select("*").eq("book_id", bookId);
  if (entryType) query = query.eq("entry_type", entryType);

  const { data, error } = await query.order("name", { ascending: true });
  if (error) throw new Error(`Failed to list codex entries: ${error.message}`);
  return data;
}

export async function getCodexEntry(entryId: string) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("codex_entries").select("*").eq("id", entryId).maybeSingle();
  if (error) throw new Error(`Failed to fetch codex entry: ${error.message}`);
  if (!data) throw new Error(`No codex entry found with id ${entryId}`);
  return data;
}

export async function searchManuscript(bookId: string, query: string): Promise<ManuscriptChunkMatch[]> {
  const embedding = await generateEmbedding(query);
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("match_manuscript_chunks", {
    query_embedding: embedding,
    match_threshold: 0,
    match_count: SEARCH_MATCH_COUNT,
    target_book_id: bookId,
  });
  if (error) throw new Error(`Manuscript search failed: ${error.message}`);
  return (data ?? []) as ManuscriptChunkMatch[];
}

export interface ManuscriptChapterTextResult {
  // The editor's title for this chapter (manuscript_chapters.title), not
  // derived from the chunk text itself -- null if this chapter has no
  // manuscript_chapters row yet (e.g. ingested via /manuscript/chunks
  // directly, without ever going through save-scene/bulk-import).
  title: string | null;
  text: string;
}

export async function getManuscriptChapterText(
  bookId: string,
  chapterNumber: number
): Promise<ManuscriptChapterTextResult> {
  const supabase = getSupabaseClient();
  const [chunksRes, chapterRes] = await Promise.all([
    supabase
      .from("manuscript_chunks")
      .select("scene_order, raw_text")
      .eq("book_id", bookId)
      .eq("chapter_number", chapterNumber)
      .order("scene_order", { ascending: true }),
    supabase.from("manuscript_chapters").select("title").eq("book_id", bookId).eq("number", chapterNumber).maybeSingle(),
  ]);

  if (chunksRes.error) throw new Error(`Failed to fetch chapter: ${chunksRes.error.message}`);
  if (!chunksRes.data || chunksRes.data.length === 0) {
    throw new Error(`No manuscript chunks found for chapter ${chapterNumber}`);
  }
  if (chapterRes.error) throw new Error(`Failed to fetch chapter title: ${chapterRes.error.message}`);

  return {
    title: (chapterRes.data?.title as string | null) ?? null,
    text: chunksRes.data.map((row) => row.raw_text).join("\n\n"),
  };
}
