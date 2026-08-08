-- Deterministic corpus-structure facts for /ask's Book Facts section (see
-- src/services/bookFacts.ts) — e.g. "what's the last chapter written?" is
-- an aggregate fact about the corpus, not something vector similarity can
-- answer, so it's computed with a direct SQL aggregate instead.
--
-- Must be a server-side aggregate, not a client-side fetch-and-reduce:
-- PostgREST caps an unbounded `.select()` at 1000 rows by default, so a
-- book with more chunks than that would silently compute MAX/COUNT over
-- an incomplete, arbitrarily-ordered slice — this is exactly what
-- happened during testing (a 2,303-chunk book reported chapter 313 as
-- the highest instead of the real 377, taken from whichever 1000 rows
-- happened to come back first).
CREATE FUNCTION get_book_facts(target_book_id UUID)
RETURNS TABLE (
  highest_chapter INT,
  total_chapters INT,
  total_chunks INT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    MAX(chapter_number) AS highest_chapter,
    COUNT(DISTINCT chapter_number)::INT AS total_chapters,
    COUNT(*)::INT AS total_chunks
  FROM manuscript_chunks
  WHERE book_id = target_book_id;
$$;
