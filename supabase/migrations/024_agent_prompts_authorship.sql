-- Tracks who wrote a prompt version, so the Prompt Editor can warn before
-- the writer edits over a Claude-authored prompt (they asked for exactly
-- this: they'd rather have Claude write the prompts, but still want a
-- clear signal before overwriting one, not silent edits).
ALTER TABLE agent_prompts ADD COLUMN IF NOT EXISTS authored_by VARCHAR(20) NOT NULL DEFAULT 'writer';
-- 'writer' | 'claude'
