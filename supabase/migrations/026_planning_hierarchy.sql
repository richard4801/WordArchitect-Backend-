-- Replaces the flat stage_2_acts/stage_3_beats model — a single Generator
-- call outlining (or beat-mapping) the ENTIRE book at once — with a
-- strict, incremental hierarchy: 3 fixed Acts, each with 3 fixed Parts,
-- each Part planned in two passes (outline, then beats) before the next
-- Part unlocks. Confirmed live that whole-book single-shot planning
-- produces real internal contradictions (a heist book's own stated
-- numbers disagreeing with each other by arc 4-5, caught by the
-- Continuity Critic) — nothing plans more of the book than the writer has
-- actually approved so far, and later units are checked against a
-- continuity ledger reconciled against the real manuscript wherever
-- chapters have actually been drafted.
--
-- No existing planning_runs row needs backfilling for the new columns —
-- 'stage_2_acts'/'stage_3_beats' simply become unused current_stage
-- values going forward (current_stage has no CHECK constraint), and any
-- run already at stage_1_summary picks up the new hierarchy the moment it
-- advances past Stage 1, same as a brand-new run.
ALTER TABLE planning_runs
  ADD COLUMN IF NOT EXISTS current_act SMALLINT,
  ADD COLUMN IF NOT EXISTS current_part SMALLINT,
  ADD COLUMN IF NOT EXISTS current_beat_chunk SMALLINT,
  -- Keyed "act-part" (e.g. "1-2"), recorded once that Part's outline is
  -- approved: { startChapter, endChapter }.
  ADD COLUMN IF NOT EXISTS part_chapter_ranges JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Array of { fact, sourcedFrom: 'plan'|'manuscript', unit } — one entry
  -- per hard fact extracted after each Part's beats are approved. Never
  -- pruned within a run.
  ADD COLUMN IF NOT EXISTS continuity_ledger JSONB NOT NULL DEFAULT '[]'::jsonb;
