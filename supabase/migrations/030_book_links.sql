-- Generic book-to-book relationship link, first motivated by two related
-- asks that turned out to be the same underlying gap: "how do I connect a
-- sequel to its original" and "how do I connect a translation to its
-- original." Every table that feeds retrieval (codex_entries,
-- manuscript_chunks, manuscript_chapters, planning_runs) is scoped
-- strictly by one book_id, and there was previously no primitive at all
-- for saying one book relates to another -- a sequel or translation
-- started from absolute zero, with no way to point back at what it
-- continues or translates. One generic link table serves both cases (and
-- whatever relationship type comes up next) instead of a narrow
-- translation-only or sequel-only column on books.
--
-- No FK to books(id) or to itself -- same reasoning already established
-- for every other book-scoped table in this schema (codex_entries,
-- manuscript_chunks, manuscript_parts/chapters -- see 013_books.sql): a
-- real book_id already in use may not yet have a books row, and requiring
-- one here would block a legitimate link.
CREATE TABLE book_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_book_id UUID NOT NULL,
  to_book_id UUID NOT NULL,
  link_type VARCHAR(50) NOT NULL,
  language VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_book_id <> to_book_id),
  UNIQUE (from_book_id, link_type)
);

-- Direction convention: from_book_id is the derived book (the sequel, or
-- the translation); to_book_id is what it relates to (the original).
-- link_type is open-ended -- "any non-empty string," not a fixed CHECK
-- enum -- same reasoning as codex_entries.entry_type: the real set of
-- relationship types this project will ever need isn't settled, and a
-- constraint would just reject legitimate future values. Two known
-- values today: "sequel_of" and "translation_of". `language` is only
-- meaningful for translation_of (e.g. "es") -- null otherwise.
--
-- UNIQUE(from_book_id, link_type) is a deliberate simplifying assumption:
-- a book can have at most one link of a given type (one sequel-of
-- relationship, one translation-of relationship), not several. Revisit
-- if a real case needs more than one (e.g. a genuine crossover), but
-- that's an edge case not worth designing around up front.
CREATE INDEX idx_book_links_from_book_id ON book_links(from_book_id);
CREATE INDEX idx_book_links_to_book_id ON book_links(to_book_id);
