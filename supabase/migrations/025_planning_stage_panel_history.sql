-- A stage's panel_reviews/arbitrator_synthesis were being cleared to null
-- when the writer approved and the run advanced to the next stage —
-- fine as long as nothing ever needed to go back, but unapprove (undoing
-- an accidental approve) needs exactly that data to reopen the rejection
-- interview with real content instead of an empty critique. This snapshots
-- each stage's panel data, keyed by stage, before it's cleared, so it can
-- be restored on unapprove.
ALTER TABLE planning_runs
  ADD COLUMN IF NOT EXISTS stage_panel_history JSONB NOT NULL DEFAULT '{}'::jsonb;
