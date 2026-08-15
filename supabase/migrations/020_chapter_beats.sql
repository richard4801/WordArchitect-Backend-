-- Outliner: Acts / Chapters / Beats. Acts and Chapters already exist
-- (manuscript_parts, manuscript_chapters) — this migration adds the one
-- genuinely new piece, the Beat: a per-chapter outline card the writer
-- fills in before generation, distinct from the chapter's actual prose
-- (manuscript_chapters.paragraphs). A beat's outline_text is what
-- /generate-prose pulls as its sceneBeat when generating from a beat,
-- instead of the writer re-pasting a scene beat freehand every time.

CREATE TABLE IF NOT EXISTS chapter_beats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id UUID NOT NULL REFERENCES manuscript_chapters(id) ON DELETE CASCADE,
  order_index INT NOT NULL DEFAULT 0,
  title VARCHAR(255) NOT NULL,
  -- The outline itself — what the writer plans to happen in this beat.
  -- This is the text that becomes /generate-prose's sceneBeat when
  -- generating from a beat.
  outline_text TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'planned', 'in_progress', 'completed')),
  -- Flips true once generated/accepted prose for this beat has been
  -- written into the chapter's paragraphs. Deliberately a boolean, not a
  -- tracked paragraph range — precise range-linking is a bigger feature
  -- than v1 of this needs.
  linked_to_manuscript BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chapter_beats_chapter_id ON chapter_beats (chapter_id);
