-- Writer-banned words/phrases (the "Ghost Editor" feature). Confirmed via
-- real testing against the Infermatic API that logit_bias is not honored
-- (identical output across biased/unbiased requests at temperature 0), and
-- that word-level token suppression wouldn't be safe even if it were —
-- most words are multiple subword tokens sharing pieces with unrelated
-- vocabulary (e.g. "shiver" decomposes to "sh" + "iver", both common
-- fragments of many other words). So there is no cheap, generation-time
-- mechanism here: every ban, word or phrase, is enforced the same way —
-- detect it in already-generated text and regenerate the offending
-- paragraph — which is why this is one table for both cases, not two.
CREATE TABLE IF NOT EXISTS banned_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  book_id UUID NOT NULL,
  term TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_banned_terms_book_id ON banned_terms (book_id);
