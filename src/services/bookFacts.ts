import { getSupabaseClient } from "../lib/supabaseClient.js";

export interface BookFacts {
  highestChapter: number | null;
  totalChapters: number;
  totalChunks: number;
}

// Deterministic corpus-structure facts — the things vector similarity can
// never reliably answer (e.g. "what's the last chapter written?") because
// they're aggregate facts about the corpus, not content a passage can be
// semantically similar to. Retrieval-based questioning was found to answer
// this kind of question with a different, essentially arbitrary chapter
// number on every attempt, since there's no meaningful "closest match" to
// the concept of "lastness."
//
// Computed via the get_book_facts RPC (migration 010) — a server-side SQL
// aggregate, not a fetch-then-reduce in JS. An earlier version did exactly
// that (SELECT chapter_number, reduce client-side) and was silently wrong
// on any book with more than 1000 chunks: PostgREST caps an unbounded
// `.select()` at 1000 rows by default, so it computed MAX/COUNT over an
// incomplete, arbitrarily-ordered slice. Verified against a real
// 2,303-chunk book where that bug reported chapter 313 as the highest
// instead of the real 377.
export async function getBookFacts(bookId: string): Promise<BookFacts> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("get_book_facts", { target_book_id: bookId }).single();

  if (error) {
    throw new Error(`Failed to compute book facts: ${error.message}`);
  }

  const row = data as { highest_chapter: number | null; total_chapters: number; total_chunks: number };
  return {
    highestChapter: row.highest_chapter,
    totalChapters: row.total_chapters,
    totalChunks: row.total_chunks,
  };
}

export function formatBookFactsSection(facts: BookFacts): string {
  if (facts.highestChapter === null) {
    return "## Book Facts\n\nNo manuscript chunks have been ingested for this book yet.";
  }

  return [
    "## Book Facts",
    "",
    `Highest chapter written: ${facts.highestChapter}`,
    `Total chapters ingested: ${facts.totalChapters}`,
    `Total manuscript chunks: ${facts.totalChunks}`,
  ].join("\n");
}
