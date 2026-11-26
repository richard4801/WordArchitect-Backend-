import { getSupabaseClient } from "../lib/supabaseClient.js";

// The author's rulings for a book, as data (migration 036): what used to be
// baked into the Claude-side gatekeeper ("man" is Jace's word, no frost words
// in Southern scenes, no quoted past dialogue, …). Every reviewer brief lists
// them; the gatekeeper can BLOCK on a violation.

export interface BookRuling {
  id: string;
  book_id: string;
  ruling: string;
  category: string;
  source: string | null;
  active: boolean;
  created_at: string;
}

export const RULING_CATEGORIES = ["house_rule", "banned_pattern", "voice", "ruling"] as const;

export async function listBookRulings(bookId: string): Promise<BookRuling[]> {
  const { data, error } = await getSupabaseClient()
    .from("book_rulings")
    .select("*")
    .eq("book_id", bookId)
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to list book rulings: ${error.message}`);
  return (data ?? []) as BookRuling[];
}

export async function addBookRuling(params: { bookId: string; ruling: string; category?: string; source?: string | null }): Promise<BookRuling> {
  const ruling = params.ruling.trim();
  if (!ruling) throw new Error("ruling must not be empty");
  const category = params.category && (RULING_CATEGORIES as readonly string[]).includes(params.category) ? params.category : "ruling";
  const { data, error } = await getSupabaseClient()
    .from("book_rulings")
    .insert({ book_id: params.bookId, ruling, category, source: params.source ?? null })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to add book ruling: ${error.message}`);
  return data as BookRuling;
}

// Retired, not deleted: a ruling's history stays inspectable.
export async function retireBookRuling(id: string): Promise<void> {
  const { error } = await getSupabaseClient().from("book_rulings").update({ active: false }).eq("id", id);
  if (error) throw new Error(`Failed to retire book ruling: ${error.message}`);
}

export function formatRulings(rulings: Pick<BookRuling, "ruling" | "category" | "source">[]): string {
  return rulings.map((r) => `- [${r.category}] ${r.ruling}${r.source ? ` (${r.source})` : ""}`).join("\n");
}
