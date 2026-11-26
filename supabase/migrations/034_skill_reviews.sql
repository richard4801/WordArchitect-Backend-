-- Skill reviews: one row per run of the backend's independent reviewer
-- agents ("skills", see CLAUDE.md "Skill Reviews") against one piece of
-- text: a prose fragment/scene/chapter, or a Planning Engine unit's draft.
--
-- text_hash is SHA-256 of the whitespace-normalized text that was reviewed.
-- It is what lets save_manuscript_scene / approve_planning_unit verify that
-- the exact text being accepted is the text that was reviewed, not some
-- earlier draft that happened to pass.
--
-- results holds one entry per skill: { skill, status, verdict?, criteria?,
-- mustFix?, summary?, error?, model?, usage?, costUsd?, promptSource }.
-- status is decided by the backend, not the model: passed | needs_revision
-- | failed | reviewer_error | not_applicable | skipped_cost_cap.
--
-- No FK to books/manuscript_chapters/planning_runs, same reasoning as every
-- other book-scoped table here (see 013_books.sql).
CREATE TABLE IF NOT EXISTS skill_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL,
  user_id UUID NOT NULL,
  target_type VARCHAR(30) NOT NULL,
    -- 'prose_fragment' | 'prose_scene' | 'prose_chapter' | 'planning_unit'
  chapter_number INT,
  scene_draft_session_id UUID,
  planning_run_id UUID,
  planning_unit VARCHAR(100),
  planning_stage VARCHAR(50),
  text_hash CHAR(64) NOT NULL,
  word_count INT NOT NULL,
  overall_status VARCHAR(30) NOT NULL,
    -- 'passed' | 'needs_revision' | 'incomplete'
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
  -- Set when text was accepted despite an unpassed review. The reason is
  -- required and shown back to the writer; it is the writer's call, logged.
  override_reason TEXT,
  overridden_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skill_reviews_book_id ON skill_reviews (book_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_reviews_hash ON skill_reviews (book_id, text_hash);
CREATE INDEX IF NOT EXISTS idx_skill_reviews_run ON skill_reviews (planning_run_id);
