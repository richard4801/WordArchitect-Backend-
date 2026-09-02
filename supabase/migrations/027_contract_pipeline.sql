-- Contract Pipeline: a second, shorter planning track alongside the
-- existing Act/Part/Beats hierarchy. Both share planning_runs and the
-- same generate/critique/arbitrate/approve machinery; pipeline_type is
-- the only new column that distinguishes them (see PipelineType in
-- src/types/domain.ts and nextPosition in src/services/planningEngine.ts
-- for how the two stage sequences diverge after stage_1_summary).
--
-- Existing rows default to 'full' — every run created before this
-- migration was, and remains, a full-pipeline run.
ALTER TABLE planning_runs
  ADD COLUMN pipeline_type VARCHAR(20) NOT NULL DEFAULT 'full';

-- One row per book — a lightweight, human-gated reference doc feeding
-- {{PLATFORM_TRENDS}} into the Contract Pipeline's hook-focused generator
-- and critics. Refreshed on demand (researchPlatformCraftNotes: Claude +
-- web_search/web_fetch), but only ever written here once the writer
-- reviews and explicitly saves the draft — no automatic/scheduled writes.
-- No FK to books(id), matching this schema's established pattern for
-- every other book_id-scoped table (codex_entries, manuscript_chunks,
-- etc.) — see 013_books.sql.
CREATE TABLE platform_craft_notes (
  book_id UUID PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
