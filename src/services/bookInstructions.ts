import { getSupabaseClient } from "../lib/supabaseClient.js";

// Fetches the saved Writing Instructions for a book. Returns "" when
// nothing has been saved yet (no row) rather than treating a missing row
// as an error — an unset instructions block is the normal starting state.
export async function getBookInstructions(bookId: string): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("book_instructions")
    .select("instructions")
    .eq("book_id", bookId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch writing instructions: ${error.message}`);
  }
  return (data?.instructions as string | undefined) ?? "";
}

// Upserts the one instructions row for this book — there is exactly one
// per book, so saving always replaces the prior value in full rather than
// appending.
export async function saveBookInstructions(bookId: string, instructions: string): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("book_instructions")
    .upsert({ book_id: bookId, instructions, updated_at: new Date().toISOString() }, { onConflict: "book_id" })
    .select("instructions")
    .single();

  if (error) {
    throw new Error(`Failed to save writing instructions: ${error.message}`);
  }
  return data.instructions as string;
}
