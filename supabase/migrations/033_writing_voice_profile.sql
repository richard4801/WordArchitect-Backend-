-- Writing Voice: a writer pastes a sample of their own prose, and Hanami
-- is guided to write in that voice on every generation from then on —
-- "write exactly like me," per the request this closes. One row per
-- writer (user_id UNIQUE), not a growing log — pasting a new sample
-- replaces the active profile wholesale, the same "whole-document
-- replace" pattern platform_craft_notes already uses, not an append-only
-- list like Banned Terms or Collaboration Learnings (those are discrete
-- facts that accumulate; a voice is one evolving thing, not a list).
--
-- Scoped by user_id, not book_id — same reasoning already established
-- for Banned Terms (031) and Collaboration Learnings (032): a writer's
-- own prose voice is a property of them, not one story, so pasting a
-- sample once should guide every book they write, not just the one open
-- when they pasted it.
CREATE TABLE writing_voice_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  -- The writer's own pasted sample, kept verbatim as the source of truth
  -- -- re-extraction (see POST .../writing-voice/extract) always works
  -- from this, never from a derived summary of a summary.
  sample_text TEXT NOT NULL,
  -- A compact, Hanami-actionable style description derived from
  -- sample_text by a one-shot Claude analysis call (src/services/
  -- writingVoice.ts) -- concrete instructions ("short declarative
  -- sentences, dialogue-heavy, present tense"), not literary commentary.
  -- This, not the raw sample, is what actually gets injected into every
  -- /generate-prose system prompt -- bounded, predictable token cost
  -- regardless of how long the pasted sample was. Null until the first
  -- successful extraction.
  style_profile TEXT,
  -- Last extraction error, if the most recent attempt failed -- cleared
  -- on the next successful extraction. style_profile is deliberately
  -- NOT cleared when this is set: if a later re-extraction fails, the
  -- last good profile keeps being used rather than silently going blank.
  extraction_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_writing_voice_profiles_user_id ON writing_voice_profiles (user_id);
