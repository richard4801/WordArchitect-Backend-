-- The recorded "Go" (author's ruling, 26 Nov: Go stays a chat rule, "Claude
-- has to obey and just ask first"; the backend records it). Before the first
-- Hanami call for a beat card, Claude shows the author the prompts, and when
-- the author says Go it calls record_prompt_approval with the beats and the
-- author's words, quoted. generate_prose_direct then requires approvalId and
-- only sends a beat that is one of the approved beats, or a declared rerun of
-- one (scope decided 26 Nov: card beats + reruns). See CLAUDE.md "Recorded Go".
CREATE TABLE IF NOT EXISTS prompt_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL,
  user_id UUID NOT NULL,
  chapter_number INT NOT NULL,
  -- The beat card's skill review the approval rests on (null only when the
  -- card review gate is switched off).
  card_review_id UUID,
  -- [{ index, label, sceneBeat, compiledContext, hash }] exactly as shown to
  -- the author; hash = SHA-256 of the sceneBeat with all whitespace collapsed.
  beats JSONB NOT NULL,
  -- The author's own words, quoted by Claude ("Go", "yes send them").
  writer_approval TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prompt_approvals_book_chapter ON prompt_approvals (book_id, chapter_number, created_at DESC);

-- Every Hanami call made under an approval: which beat, whether it was the
-- approved prompt or a rerun of it, and exactly what was sent.
CREATE TABLE IF NOT EXISTS prompt_approval_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID NOT NULL REFERENCES prompt_approvals(id) ON DELETE CASCADE,
  beat_index INT NOT NULL,
  -- 'approved' (the exact approved beat) | 'rerun' (a narrow rerun of it)
  kind VARCHAR(20) NOT NULL,
  scene_beat TEXT NOT NULL,
  compiled_context TEXT NOT NULL,
  rerun_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prompt_approval_calls_approval ON prompt_approval_calls (approval_id, created_at);
