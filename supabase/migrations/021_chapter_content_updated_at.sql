-- Adds a timestamp that tracks only real manuscript-text edits, distinct
-- from manuscript_chapters.updated_at (which bumps on ANY field change —
-- title, heading, complete, part_id, number — not just paragraphs). The
-- Outliner's/editor's "needs resync" indicator needs to know specifically
-- "has the actual prose changed since the last sync," not "was this row
-- touched at all" — using updated_at for that would falsely flag a
-- resync as needed after a plain chapter rename.

ALTER TABLE manuscript_chapters ADD COLUMN IF NOT EXISTS content_updated_at TIMESTAMPTZ;

-- Backfill existing rows with their current updated_at as the best
-- available proxy — WHERE-guarded so this is safe to re-run and never
-- clobbers a real value once one exists.
UPDATE manuscript_chapters SET content_updated_at = updated_at WHERE content_updated_at IS NULL;

ALTER TABLE manuscript_chapters ALTER COLUMN content_updated_at SET DEFAULT NOW();
ALTER TABLE manuscript_chapters ALTER COLUMN content_updated_at SET NOT NULL;
