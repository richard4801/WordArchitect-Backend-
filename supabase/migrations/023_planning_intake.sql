-- Planning Engine intake: before Stage 1 even starts, the writer talks to
-- the Arbitrator in plain language (not a form) about what they want this
-- book to be — pasting a reference link, uploading a doc, just describing
-- it — and the Arbitrator asks clarifying questions until it can compile
-- a real creative brief. That brief becomes the Generator's very first
-- input, via the same final_delta_directive field the post-rejection
-- regeneration flow already uses (mechanically the same thing: "extra
-- direction to incorporate before generating"), so no new artifact field
-- is needed there — just a separate chat thread for the intake
-- conversation, distinct from a mid-pipeline rejection interview.

ALTER TABLE planning_runs ADD COLUMN IF NOT EXISTS intake_chat_history JSONB NOT NULL DEFAULT '[]'::jsonb;

-- New runs start in the intake conversation, not mid-generation.
ALTER TABLE planning_runs ALTER COLUMN status SET DEFAULT 'intake_active';
