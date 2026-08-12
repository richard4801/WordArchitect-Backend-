-- Expands codex_entries to cover the frontend's much richer Character
-- shape (see the frontend's CLAUDE.md, src/lib/character-data.ts) — the
-- single biggest editable gap the frontend flagged: most of these fields
-- currently exist only in its seed data, with no backend field to save to
-- at all.
--
-- Two of these are TYPE changes on columns that already hold real,
-- populated production data (Fenris/Sera/Mina's Codex entries), not just
-- additive columns — handled with USING clauses that preserve the
-- existing text rather than dropping/re-adding the column:
--
--   background: TEXT -> TEXT[] (frontend stores it as a bullet list).
--   The existing free-text value becomes a one-element array rather than
--   being guessed apart into multiple bullets — guessing at paragraph
--   breaks risks mangling real data based on formatting assumptions that
--   may not hold; a writer can manually split it into real bullets later.
--
--   notes: TEXT -> JSONB (frontend stores {title, body, date, pinned}[]).
--   The existing free-text value becomes a single note object
--   { title: 'Notes', body: <existing text>, date: <created_at>,
--   pinned: false } inside a one-element array, so no existing note
--   content is lost.
--
-- ============================================================================
-- 1. New profile fields
-- ============================================================================

ALTER TABLE codex_entries
  ADD COLUMN IF NOT EXISTS nickname VARCHAR(255),
  ADD COLUMN IF NOT EXISTS epithet VARCHAR(255),
  ADD COLUMN IF NOT EXISTS status VARCHAR(100),
  ADD COLUMN IF NOT EXISTS alignment VARCHAR(100),
  ADD COLUMN IF NOT EXISTS pov_character BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archetype VARCHAR(100),
  ADD COLUMN IF NOT EXISTS favorites INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS motivation TEXT,
  ADD COLUMN IF NOT EXISTS goal TEXT,
  ADD COLUMN IF NOT EXISTS fear TEXT,
  ADD COLUMN IF NOT EXISTS secret TEXT,
  ADD COLUMN IF NOT EXISTS life_events JSONB,
  ADD COLUMN IF NOT EXISTS cultural_background JSONB,
  ADD COLUMN IF NOT EXISTS strengths TEXT[],
  ADD COLUMN IF NOT EXISTS weaknesses TEXT[],
  ADD COLUMN IF NOT EXISTS internal_conflict TEXT;

-- ============================================================================
-- 2. tier: add 'extra' (frontend's Character.role has four values —
--    Main/Supporting/Minor/Extra — this schema already covers the first
--    three; only 'extra' was missing)
-- ============================================================================

ALTER TABLE codex_entries
  DROP CONSTRAINT IF EXISTS codex_entries_tier_check;

ALTER TABLE codex_entries
  ADD CONSTRAINT codex_entries_tier_check
  CHECK (tier IN ('main', 'supporting', 'minor', 'extra'));

-- ============================================================================
-- 3. background: TEXT -> TEXT[]
-- ============================================================================

ALTER TABLE codex_entries
  ALTER COLUMN background TYPE TEXT[]
  USING (
    CASE
      WHEN background IS NULL OR background = '' THEN NULL
      ELSE ARRAY[background]
    END
  );

-- ============================================================================
-- 4. notes: TEXT -> JSONB (array of { title, body, date, pinned })
-- ============================================================================

ALTER TABLE codex_entries
  ALTER COLUMN notes TYPE JSONB
  USING (
    CASE
      WHEN notes IS NULL OR notes = '' THEN NULL
      ELSE jsonb_build_array(
        jsonb_build_object(
          'title', 'Notes',
          'body', notes,
          'date', to_char(created_at, 'YYYY-MM-DD'),
          'pinned', false
        )
      )
    END
  );
