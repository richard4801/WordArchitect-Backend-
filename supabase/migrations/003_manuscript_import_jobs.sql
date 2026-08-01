-- Tracks a bulk manuscript import as it's processed one chapter at a time.
-- Chapters are pre-split (via splitIntoChapters) and stored whole in
-- `chapters` on job creation, which is fast (no embedding calls). Each
-- subsequent "step" call chunks/embeds/stores exactly one chapter and
-- advances next_chapter_index — this is what lets a very large import
-- finish across many short requests instead of one long-running request,
-- which the free tier can't reliably hold open anyway.
CREATE TABLE manuscript_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  book_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  chapters JSONB NOT NULL,
  next_chapter_index INT NOT NULL DEFAULT 0,
  chapters_total INT NOT NULL,
  chapters_done INT NOT NULL DEFAULT 0,
  chunks_stored INT NOT NULL DEFAULT 0,
  last_chapter_title TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_manuscript_import_jobs_book_id ON manuscript_import_jobs(book_id);
