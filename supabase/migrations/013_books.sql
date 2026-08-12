-- Project/book metadata. Every other table in this schema (codex_entries,
-- manuscript_chunks, banned_terms, scene_draft_sessions) already scopes
-- itself by book_id, but until now nothing actually created, listed, or
-- stored a book's own metadata — book_id was just a bare UUID other
-- tables referenced. This is what the frontend's "Projects" feature
-- reads/writes.
--
-- Deliberately no CHECK constraint on status/pov/tense: the frontend's
-- exact enum values for these aren't settled yet, and a mismatched
-- constraint would just reject legitimate writes. Add one once the real
-- value sets are known.
--
-- Deliberately no foreign key from codex_entries.book_id /
-- manuscript_chunks.book_id / etc. to this table: those tables already
-- have real production data referencing book_ids that predate this
-- table, and adding a FK now risks breaking that data rather than
-- protecting it. Worth adding once every existing book_id in use has a
-- corresponding row here.
CREATE TABLE IF NOT EXISTS books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  title VARCHAR(255) NOT NULL,
  tagline TEXT,
  genre VARCHAR(100),
  subgenres VARCHAR(100)[],
  pov VARCHAR(50),
  tense VARCHAR(50),
  target_words INT,
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  cover_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_books_user_id ON books (user_id);
