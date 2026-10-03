import { getSupabaseClient } from "../lib/supabaseClient.js";

export interface BannedTerm {
  id: string;
  user_id: string;
  book_id: string;
  term: string;
  created_at: string;
}

// Scoped by userId, not bookId: a writer's banned terms apply across
// every book they own, not just the one they were banned from. bookId
// stays on each row as provenance only (see migration
// 031_banned_terms_per_user.sql) -- it never gates this lookup.
export async function listBannedTerms(userId: string): Promise<BannedTerm[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("banned_terms")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to list banned terms: ${error.message}`);
  return (data ?? []) as BannedTerm[];
}

export interface AddBannedTermResult {
  term: BannedTerm;
  alreadyExisted: boolean;
}

// Case-insensitive: "Delve" and "delve" are the same ban, matching how
// Ghost Editor detection already matches (case-insensitive substring).
// Re-banning an already-banned term is a no-op success, not an error or a
// duplicate row — important now that banning is a one-click editor
// action (highlight -> ban) rather than a deliberate form entry, so it's
// easy to re-trigger for a term already banned in an earlier chapter --
// now also true across books, since the same writer banning the same
// term while editing a different book than where they first banned it is
// exactly the global-ban behavior this is meant to have, not a conflict.
//
// bookId is still required and stored, but purely as provenance (which
// book was open when this term was first banned) -- dedup and lookup are
// both scoped by userId (see migration 031_banned_terms_per_user.sql).
export async function addBannedTerm(params: { userId: string; bookId: string; term: string }): Promise<AddBannedTermResult> {
  const trimmed = params.term.trim();
  if (!trimmed) throw new Error("term must not be empty");
  const trimmedLower = trimmed.toLowerCase();

  const existing = await listBannedTerms(params.userId);
  const existingMatch = existing.find((t) => t.term.toLowerCase() === trimmedLower);
  if (existingMatch) return { term: existingMatch, alreadyExisted: true };

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("banned_terms")
    .insert({ user_id: params.userId, book_id: params.bookId, term: trimmed })
    .select("*")
    .single();

  if (error) {
    // Race: another request banned the same term (case-insensitively)
    // between our check above and this insert — the unique index
    // (migration 031) rejects it. From the caller's perspective this is
    // still a successful "ban this" action, so fetch and return the
    // now-existing row instead of surfacing an error.
    if (error.code === "23505") {
      const fresh = await listBannedTerms(params.userId);
      const freshMatch = fresh.find((t) => t.term.toLowerCase() === trimmedLower);
      if (freshMatch) return { term: freshMatch, alreadyExisted: true };
    }
    throw new Error(`Failed to add banned term: ${error.message}`);
  }
  return { term: data as BannedTerm, alreadyExisted: false };
}

export async function removeBannedTerm(id: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("banned_terms").delete().eq("id", id);
  if (error) throw new Error(`Failed to remove banned term: ${error.message}`);
}
