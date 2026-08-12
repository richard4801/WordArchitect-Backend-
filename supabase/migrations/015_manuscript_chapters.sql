-- Manuscript/Chapters rich-editor persistence — the frontend's own biggest
-- documented gap (its CLAUDE.md flags this as "read this closely"): the
-- contentEditable chapter editor has real formatting (paragraphs with
-- emphasis/breaks/comments) but nothing on this backend to save it to.
--
-- Deliberately a NEW, separate table from manuscript_chunks. manuscript_
-- chunks is a derived RAG index — ~180-word chunks, one row per chunk,
-- built specifically for Layer 2/3 retrieval. This table is the actual
-- editable source of truth for a chapter's rich content — one row per
-- chapter, the full paragraph structure the editor renders, independent
-- of how that content later gets chunked for retrieval. Conflating the
-- two would mean either warping the editor's data model to fit ~180-word
-- chunk boundaries, or warping retrieval chunking to fit editor
-- pagination — neither of which either side actually needs.
--
-- The relationship between them is one-directional and explicit, not
-- automatic: POST /api/v1/manuscript/chapters/:id/sync-to-memory (see
-- src/routes/manuscriptChapters.ts) reads this table's current
-- paragraphs, deletes any existing manuscript_chunks rows for that
-- book_id/chapter_number, and re-runs the normal chunk/embed/store
-- pipeline (ingestManuscriptText) against the fresh text — REPLACING the
-- old chunks rather than appending duplicates. This is a deliberate
-- writer-triggered action (e.g. an "Accept into manuscript memory"
-- button), not something that fires on every editor autosave — autosaves
-- just update the paragraphs column here (cheap, no embedding calls);
-- only an explicit sync spends an OpenAI embedding call per chunk.
--
-- No foreign key to books(id): same reasoning as codex_entries/
-- manuscript_chunks (see migration 013) — real book_ids already in use
-- may not yet have a corresponding books row, and a FK here would block
-- legitimate writes for them. part_id/chapter_id below ARE real foreign
-- keys since manuscript_parts/manuscript_scenes are wholly new tables
-- with no pre-existing data to conflict with.

CREATE TABLE IF NOT EXISTS manuscript_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL,
  title VARCHAR(255) NOT NULL,
  order_index INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manuscript_parts_book_id ON manuscript_parts (book_id);

-- One row per chapter. `number` is the same chapter-numbering space
-- manuscript_chunks.chapter_number already uses for this book_id, so a
-- sync-to-memory action knows exactly which chunk rows it's replacing.
CREATE TABLE IF NOT EXISTS manuscript_chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  book_id UUID NOT NULL,
  part_id UUID REFERENCES manuscript_parts(id) ON DELETE SET NULL,
  number INT NOT NULL,
  title TEXT,
  -- Editor-facing display heading (e.g. "Chapter One"), kept separate
  -- from `title` (e.g. "The Harbor Gate") since the frontend's
  -- ChapterBody type distinguishes the two.
  heading TEXT,
  complete BOOLEAN NOT NULL DEFAULT false,
  -- Array of { id, text, emphasis?, break?, comments?, ... }, matching
  -- the frontend's ChapterParagraph shape. Kept as JSONB and validated
  -- only loosely server-side (array of objects, each with string id/text
  -- — src/routes/manuscriptChapters.ts) rather than a normalized
  -- paragraphs/comments table, since per-paragraph inline comment
  -- threads are naturally nested data the editor reads/writes as one
  -- unit, and the frontend's exact paragraph/comment shape isn't fully
  -- settled yet.
  paragraphs JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Null until the first sync-to-memory call; lets the UI show "synced"
  -- vs. "has unsynced edits" by comparing against updated_at.
  synced_to_memory_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (book_id, number)
);

CREATE INDEX IF NOT EXISTS idx_manuscript_chapters_book_id ON manuscript_chapters (book_id);
CREATE INDEX IF NOT EXISTS idx_manuscript_chapters_part_id ON manuscript_chapters (part_id);

-- Lightweight scene markers within a chapter, for outline/navigation in
-- the editor UI. Deliberately NOT the same concept as manuscript_chunks'
-- scene_order, which is a RAG chunk position assigned automatically
-- during ingestion — these are writer-authored navigation points.
CREATE TABLE IF NOT EXISTS manuscript_scenes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id UUID NOT NULL REFERENCES manuscript_chapters(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  order_index INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manuscript_scenes_chapter_id ON manuscript_scenes (chapter_id);
