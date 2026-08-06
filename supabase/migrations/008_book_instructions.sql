-- Per-book "Writing Instructions" — mandatory house-style/continuity rules
-- a writer sets once and that get injected into every compiled context
-- payload ahead of Layer 1/2/3 (see src/services/rag.ts), so Hanami sees
-- them first and they're the last thing trimmed when the token budget is
-- tight. One row per book; PATCHing is an upsert keyed on book_id.
CREATE TABLE IF NOT EXISTS book_instructions (
  book_id UUID PRIMARY KEY,
  instructions TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
