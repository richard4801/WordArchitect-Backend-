-- Supervised scene-drafting sessions: lets Claude (via the MCP connector)
-- iterate with Hanami on a scene beat across multiple passes — generate,
-- critique against the plot points agreed on in brainstorming, redirect
-- with a sharper instruction, regenerate — and have that progress survive
-- past a single conversation. Without this, a session that paused after a
-- few passes (or was simply interrupted by the writer closing the tab)
-- had no way to be picked back up later; the checklist, current best
-- draft, and open issues only ever existed in that one conversation's
-- context window.
--
-- Two tables, same split as manuscript_import_jobs/manuscript_import_job_chapters:
-- scene_draft_sessions holds current state (what a resuming session reads
-- first), scene_draft_iterations is the append-only audit log of every
-- pass (what actually gives the writer real transparency into what
-- changed and why, not just Claude's verbal recap).
CREATE TABLE IF NOT EXISTS scene_draft_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  book_id UUID NOT NULL,
  chapter_number INT,
  label VARCHAR(255),
  scene_beat TEXT NOT NULL,
  -- [{ description: string, satisfied: boolean }] — the plot-point
  -- checklist derived from brainstorming, so a resumed session knows
  -- exactly what's already been hit vs. still pending.
  plot_points JSONB NOT NULL DEFAULT '[]',
  current_draft TEXT NOT NULL DEFAULT '',
  open_issues TEXT[] NOT NULL DEFAULT '{}',
  iteration_count INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'done', 'abandoned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scene_draft_sessions_book_id ON scene_draft_sessions (book_id);

CREATE TABLE IF NOT EXISTS scene_draft_iterations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES scene_draft_sessions(id) ON DELETE CASCADE,
  iteration_number INT NOT NULL,
  -- What Claude actually told Hanami this pass (MUST/MUST NOT directives,
  -- bracketed beat notes, etc.) — the concrete instruction, not a summary.
  instructions_given TEXT,
  draft_text TEXT NOT NULL,
  -- Claude's assessment of this pass — what it kept, what it's redirecting
  -- and why. This is the transparency record the writer can inspect.
  critique TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scene_draft_iterations_session_id ON scene_draft_iterations (session_id);
