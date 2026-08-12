-- Notes — a clean new entity for the frontend's Quick Notes / notes modal
-- (its CLAUDE.md: Note { id, title, excerpt, category, date, dateRank,
-- comments, pinned, mine }, NewNoteInput { title, excerpt, category }).
-- No architectural conflicts with anything already in this schema —
-- unlike Worldbuilding's category system, the frontend's `category` here
-- is a small fixed set sourced from real frontend type definitions (not
-- placeholder seed data), so it's CHECK-constrained rather than left
-- open-ended.
--
-- `mine` from the frontend type is deliberately NOT a stored column —
-- it's relative to whoever is viewing ("is this my note"), not an
-- inherent property of the note itself. `user_id` (the author) is stored
-- instead, the same pattern every other table in this schema already
-- uses, and "mine" is just `note.user_id === the viewer's user_id`,
-- computed by whichever layer knows who's currently viewing.
--
-- `comments` is a plain stored counter, not backed by a real comments
-- table — nothing in the frontend's documented Note shape describes
-- individual comment records, just a count. Same pattern as
-- codex_entries.favorites.

CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  book_id UUID NOT NULL,
  title VARCHAR(255) NOT NULL,
  excerpt TEXT NOT NULL,
  category VARCHAR(50) NOT NULL CHECK (
    category IN ('World Building', 'Character', 'Plot', 'Research', 'Inspiration', 'Magic System')
  ),
  pinned BOOLEAN NOT NULL DEFAULT false,
  comments INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notes_book_id ON notes (book_id);
