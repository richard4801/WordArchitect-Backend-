-- Adds a system-maintained, auto-synthesized understanding of a Codex
-- entry (`auto_summary`) alongside the writer's own hand-written
-- `description` — built incrementally from every place the entry is
-- actually mentioned across the manuscript, instead of relying on a
-- single raw retrieved snippet at generation time (which can't carry
-- enough context for a thread that's only ever revealed in fragments
-- across many scenes — see CLAUDE.md's Layer 3 notes for why).
ALTER TABLE codex_entries ADD COLUMN auto_summary TEXT;
ALTER TABLE codex_entries ADD COLUMN auto_generated BOOLEAN NOT NULL DEFAULT false;

-- One row per (codex entry, manuscript chunk) where the entry was
-- detected — the "everywhere this was mentioned" index. Lets the sync
-- job avoid re-processing a chunk it's already folded into an entry's
-- auto_summary, and gives a queryable record of coverage.
CREATE TABLE codex_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codex_entry_id UUID NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  manuscript_chunk_id UUID NOT NULL REFERENCES manuscript_chunks(id) ON DELETE CASCADE,
  book_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (codex_entry_id, manuscript_chunk_id)
);

CREATE INDEX idx_codex_mentions_entry_id ON codex_mentions(codex_entry_id);
CREATE INDEX idx_codex_mentions_book_id ON codex_mentions(book_id);

-- Tracks a resumable sweep through a book's manuscript_chunks (ordered by
-- chapter_number, scene_order) that both enriches existing Codex entries'
-- auto_summary and proposes new entries for named characters/objects it
-- finds that aren't in the Codex yet. Same step-based, one-chunk-per-call
-- pattern as manuscript_import_jobs, for the same reason: safe on a
-- platform with no separate worker process and no long-request tolerance.
CREATE TABLE codex_sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  book_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  -- Position within manuscript_chunks for this book, ordered by
  -- (chapter_number, scene_order) — a plain offset cursor rather than a
  -- keyset one, simple and fast enough for a single novel's chunk count.
  next_chunk_offset INT NOT NULL DEFAULT 0,
  chunks_total INT NOT NULL,
  chunks_processed INT NOT NULL DEFAULT 0,
  entries_updated INT NOT NULL DEFAULT 0,
  entries_created INT NOT NULL DEFAULT 0,
  last_chunk_summary TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_codex_sync_jobs_book_id ON codex_sync_jobs(book_id);
