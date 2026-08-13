-- Case-insensitive dedup safety net for banned_terms, needed now that
-- banning a highlighted word/phrase is about to become a one-click
-- editor action (highlight -> ban) rather than a deliberate form entry —
-- much easier to accidentally re-ban the same term than before. Ghost
-- Editor detection (src/services/ghostEditor.ts) already matches
-- case-insensitively, so storage should treat "Delve" and "delve" as the
-- same ban too, not two separate rows.

-- 1. Remove any existing case-insensitive duplicates first, keeping the
--    earliest row per (book_id, lower(term)) — needed so the unique
--    index below can actually be created if any duplicates already
--    exist. Ordered by (created_at, id) rather than id alone, since
--    gen_random_uuid() isn't chronologically sortable.
DELETE FROM banned_terms a
USING banned_terms b
WHERE a.book_id = b.book_id
  AND lower(a.term) = lower(b.term)
  AND (a.created_at, a.id) > (b.created_at, b.id);

-- 2. Case-insensitive uniqueness per book. addBannedTerm (src/services/
--    bannedTerms.ts) already checks for an existing case-insensitive
--    match before inserting — this index is the safety net for the race
--    condition (two concurrent "ban this" actions for the same term),
--    not the primary de-dup mechanism.
CREATE UNIQUE INDEX IF NOT EXISTS idx_banned_terms_book_id_term_ci
  ON banned_terms (book_id, lower(term));
