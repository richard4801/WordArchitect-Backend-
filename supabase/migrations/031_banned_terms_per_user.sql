-- Banned Terms (Ghost Editor) moves from per-book to per-writer scope: a
-- term banned once now applies across every book that writer owns, not
-- just the one open when they banned it. Motivated by the realistic case
-- this was never designed around -- a writer who knows they overuse a
-- word ("delve", a verbal tic, a cliche) wants it gone everywhere they
-- write, not re-banned book by book. book_id is kept on the table (still
-- NOT NULL, still sent by every existing POST /banned-terms caller) as
-- provenance -- which book a term was first banned from -- but it no
-- longer participates in enforcement lookups or uniqueness; user_id does.

-- 1. Case-insensitive dedup per user_id, mirroring migration 018's
--    per-book dedup -- needed before the new unique index below can be
--    created, since the same term may already exist under several
--    book_ids for one writer (e.g. banned separately in two different
--    books prior to this migration). Keeps the earliest row per
--    (user_id, lower(term)), ordered by (created_at, id) since
--    gen_random_uuid() isn't chronologically sortable.
DELETE FROM banned_terms a
USING banned_terms b
WHERE a.user_id = b.user_id
  AND lower(a.term) = lower(b.term)
  AND (a.created_at, a.id) > (b.created_at, b.id);

-- 2. Drop the old per-book uniqueness -- a term is no longer allowed to
--    exist twice for the same book, it's now disallowed twice for the
--    same writer, full stop.
DROP INDEX IF EXISTS idx_banned_terms_book_id_term_ci;

-- 3. The real enforcement/lookup index now, and the new uniqueness
--    constraint: addBannedTerm (src/services/bannedTerms.ts) still checks
--    for an existing case-insensitive match before inserting -- this
--    index is the race-condition safety net, not the primary dedup
--    mechanism, same role idx_banned_terms_book_id_term_ci played before.
CREATE INDEX IF NOT EXISTS idx_banned_terms_user_id ON banned_terms (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_banned_terms_user_id_term_ci
  ON banned_terms (user_id, lower(term));
