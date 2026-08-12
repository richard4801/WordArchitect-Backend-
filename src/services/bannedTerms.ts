import { getSupabaseClient } from "../lib/supabaseClient.js";

export interface BannedTerm {
  id: string;
  user_id: string;
  book_id: string;
  term: string;
  created_at: string;
}

export async function listBannedTerms(bookId: string): Promise<BannedTerm[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("banned_terms")
    .select("*")
    .eq("book_id", bookId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to list banned terms: ${error.message}`);
  return (data ?? []) as BannedTerm[];
}

export async function addBannedTerm(params: { userId: string; bookId: string; term: string }): Promise<BannedTerm> {
  const trimmed = params.term.trim();
  if (!trimmed) throw new Error("term must not be empty");

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("banned_terms")
    .insert({ user_id: params.userId, book_id: params.bookId, term: trimmed })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to add banned term: ${error.message}`);
  return data as BannedTerm;
}

export async function removeBannedTerm(id: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("banned_terms").delete().eq("id", id);
  if (error) throw new Error(`Failed to remove banned term: ${error.message}`);
}
