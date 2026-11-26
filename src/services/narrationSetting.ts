import { getSupabaseClient } from "../lib/supabaseClient.js";
import { resolveNarrationSetting, type NarrationSetting } from "../lib/narration.js";

// Reads a book's narration switch (books.pov + books.tense, normalized) —
// null when the book has none, or only one half, set. A failed lookup THROWS
// rather than returning null: silently treating "couldn't read the setting"
// as "switch off" would skip the enforcement with no signal, the exact
// silent-failure trap the 2026-10-20 entry in LEARNINGS.md describes.
export async function getBookNarrationSetting(bookId: string): Promise<NarrationSetting | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("books").select("pov, tense").eq("id", bookId).maybeSingle();
  if (error) {
    throw new Error(`Failed to read the book's narration setting: ${error.message}`);
  }
  if (!data) return null;
  return resolveNarrationSetting(data.pov, data.tense);
}
