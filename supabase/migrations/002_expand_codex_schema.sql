-- WordArchitect Backend — Stage 6: Expanded Codex Schema
-- Broadens codex_entries into a richer character/worldbuilding profile
-- (physical description, personality, motivations, character arc,
-- relationships) to support a Novelcrafter-style Codex UI, while Layer 1
-- (src/services/rag.ts) continues to inject only a condensed summary into
-- Hanami's prompt so the ~800-token budget from CLAUDE.md is unaffected by
-- how much detail a human writer stores here.

-- ============================================================================
-- 1. Broaden entry_type to cover worldbuilding categories
-- ============================================================================

ALTER TABLE codex_entries
  DROP CONSTRAINT IF EXISTS codex_entries_entry_type_check;

ALTER TABLE codex_entries
  ADD CONSTRAINT codex_entries_entry_type_check
  CHECK (entry_type IN (
    'character', 'location', 'item', 'lore',
    'nation', 'culture', 'magic', 'faction', 'religion', 'history'
  ));

-- ============================================================================
-- 2. Structured profile fields (all optional — only characters/entries
--    that use them need to populate them)
-- ============================================================================

ALTER TABLE codex_entries
  ADD COLUMN IF NOT EXISTS tier VARCHAR(20) CHECK (tier IN ('main', 'supporting', 'minor')),
  ADD COLUMN IF NOT EXISTS quote TEXT,
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS age VARCHAR(20),
  ADD COLUMN IF NOT EXISTS gender VARCHAR(50),
  ADD COLUMN IF NOT EXISTS role_in_story VARCHAR(100),
  ADD COLUMN IF NOT EXISTS occupation VARCHAR(255),
  ADD COLUMN IF NOT EXISTS location_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS physical_description TEXT[],
  ADD COLUMN IF NOT EXISTS personality_traits VARCHAR(100)[],
  ADD COLUMN IF NOT EXISTS motivations TEXT[],
  ADD COLUMN IF NOT EXISTS background TEXT,
  ADD COLUMN IF NOT EXISTS character_arc JSONB,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS event_year VARCHAR(50);

-- ============================================================================
-- 3. codex_relationships — character bonds (Relationships tab)
-- ============================================================================

CREATE TABLE IF NOT EXISTS codex_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL,
  from_entry_id UUID NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  to_entry_id UUID NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  bond_type VARCHAR(100) NOT NULL,
  description TEXT,
  strength VARCHAR(20) CHECK (strength IN ('strong', 'moderate', 'tense', 'weak')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT codex_relationships_no_self_reference CHECK (from_entry_id <> to_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_codex_relationships_book_id ON codex_relationships (book_id);
CREATE INDEX IF NOT EXISTS idx_codex_relationships_from_entry ON codex_relationships (from_entry_id);
CREATE INDEX IF NOT EXISTS idx_codex_relationships_to_entry ON codex_relationships (to_entry_id);
