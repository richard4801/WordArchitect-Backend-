-- Reviews run as subagents in the author's chat, not on the backend's API key
-- (author's decision, 26 Nov; see docs/process/SYSTEM_DESIGN.md section 4b).
-- The backend builds one brief per applicable skill, each subagent fetches its
-- own brief by id and submits its own verdict, and the backend validates and
-- stores it here. One row per (review, skill) so parallel subagents never
-- overwrite each other's results.
--
-- Run AFTER 034_skill_reviews.sql.

ALTER TABLE skill_reviews ADD COLUMN IF NOT EXISTS reviewed_text TEXT;
ALTER TABLE skill_reviews ADD COLUMN IF NOT EXISTS context_pack JSONB;

CREATE TABLE IF NOT EXISTS skill_review_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES skill_reviews(id) ON DELETE CASCADE,
  skill VARCHAR(50) NOT NULL,
  -- 'pending' | 'passed' | 'flagged' | 'blocked' | 'reviewer_error' | 'not_applicable'
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  -- The skill-specific half of the brief (rubric, criteria, contract). The
  -- shared half (context pack + text) lives once on skill_reviews.
  brief JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The validated verdict: criteria, findings on the BLOCK/FLAG/NOTE ladder,
  -- summary. Null until a valid submission arrives.
  verdict JSONB,
  reason TEXT,
  reviewer_model VARCHAR(100),
  submit_attempts INT NOT NULL DEFAULT 0,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (review_id, skill)
);

CREATE INDEX IF NOT EXISTS idx_skill_review_items_review ON skill_review_items (review_id);
