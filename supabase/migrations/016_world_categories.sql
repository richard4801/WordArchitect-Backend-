-- Worldbuilding categories — closes the architectural gap between this
-- schema's fixed entry_type CHECK constraint and the frontend's
-- open-ended, user-creatable category system (its CLAUDE.md:
-- WorldCategoryKey ships with 8 seed categories, but NewCategoryInput
-- lets a writer create arbitrary new ones with a slugified key, color,
-- and icon — a closed enum can't represent that).
--
-- Worldbuilding entries themselves are NOT a new table — they already
-- live in codex_entries (location/item/lore/nation/culture/magic/
-- faction/religion/history entry_type values, added by migration
-- 002_expand_codex_schema.sql), including real production data. Forking
-- a separate table would mean either migrating that real data or losing
-- Layer 1's explicit-match coverage of it, for no real benefit — Layer 1
-- (src/services/rag.ts) already scans codex_entries by name/alias
-- regardless of entry_type, so nothing there needs to change.
--
-- ============================================================================
-- 1. Open up entry_type: drop the fixed CHECK, keep NOT NULL
-- ============================================================================
--
-- 'character' remains a plain value with no special DB-level treatment
-- (nothing in the codebase branches on entry_type === 'character';
-- Layer 1 matches by name/alias for every entry_type equally). Every
-- other value is now a worldbuilding category key, validated at the
-- application layer (src/routes/codex.ts: non-empty string) rather than
-- a closed list, since the writer-facing set of categories is no longer
-- fixed.

ALTER TABLE codex_entries
  DROP CONSTRAINT IF EXISTS codex_entries_entry_type_check;

-- ============================================================================
-- 2. updated_at — codex_entries never had one; needed for the frontend's
--    "last updated" display on both Characters and World Entries
--    (WorldEntry.updatedHours)
-- ============================================================================

ALTER TABLE codex_entries
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ============================================================================
-- 3. world_categories — per-book category metadata (display name, color,
--    icon, description). entry_type values that don't have a matching row
--    here still work (see GET /api/v1/world-categories in
--    src/routes/worldCategories.ts, which synthesizes a fallback display
--    entry for any entry_type in real use with no category row yet) — this
--    table only ever adds presentation metadata, never gates whether an
--    entry_type is "valid".
-- ============================================================================

CREATE TABLE IF NOT EXISTS world_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL,
  key VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  color VARCHAR(50),
  icon VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (book_id, key)
);

CREATE INDEX IF NOT EXISTS idx_world_categories_book_id ON world_categories (book_id);
