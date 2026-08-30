-- Webnovel Planning Engine: a pre-writing pipeline (Stage 1 Core Summary ->
-- Stage 2 Act Outlines -> Stage 3 Chapter Beats) with a 3-agent Scrutiny
-- Panel (Logic Critic, Suspense Critic, Arbitrator) and a mandatory human
-- review gate at every stage. Entirely separate from manuscript drafting —
-- nothing here ever writes prose; that stays Hanami's job via the existing
-- /generate-prose and MCP tools. This pipeline only ever produces planning
-- artifacts, which on approval populate the existing Outliner
-- (chapter_beats) and Codex/World Categories tables.

-- Prompts are data, not code — every agent's system_prompt/user_prompt_template
-- is authored and owned by the writer, versioned here, never hardcoded in
-- application code. `stage = 'all'` is a valid value for a role whose prompt
-- doesn't need to vary per stage (e.g. the entity extractor) — getActivePrompt
-- tries the exact (role, stage) first, then falls back to (role, 'all').
CREATE TABLE IF NOT EXISTS agent_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL,
  agent_role VARCHAR(50) NOT NULL,
    -- 'generator' | 'logic_critic' | 'suspense_critic' | 'arbitrator_panel'
    -- | 'arbitrator_chat' | 'arbitrator_directive' | 'entity_extractor'
  stage VARCHAR(50) NOT NULL,
    -- 'stage_1_summary' | 'stage_2_acts' | 'stage_3_beats' | 'all'
  version INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  system_prompt TEXT NOT NULL,
  user_prompt_template TEXT NOT NULL,
  -- Model/effort live here, not in code, so cost/quality per role is a
  -- runtime setting the writer can change without a redeploy.
  model VARCHAR(50) NOT NULL DEFAULT 'claude-sonnet-5',
  effort VARCHAR(20) NOT NULL DEFAULT 'high',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_prompts_lookup ON agent_prompts (book_id, agent_role, stage, is_active);

CREATE TABLE IF NOT EXISTS planning_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL,
  user_id UUID NOT NULL,
  current_stage VARCHAR(50) NOT NULL DEFAULT 'stage_1_summary',
  status VARCHAR(30) NOT NULL DEFAULT 'generating',
    -- generating | critiquing | awaiting_arbitration | awaiting_user_review
    -- | user_chat_active | awaiting_entity_review | done | failed
  -- Keyed by stage ('stage_1_summary'/'stage_2_acts'/'stage_3_beats'), not
  -- a single overwritten column — Stage 2's Generator needs to read Stage
  -- 1's approved artifact for continuity, so earlier stages' output has to
  -- survive the transition to the next stage, not just the current one.
  stage_artifacts JSONB NOT NULL DEFAULT '{}'::jsonb,
  panel_reviews JSONB,
  arbitrator_synthesis JSONB,
  chat_history JSONB NOT NULL DEFAULT '[]',
  final_delta_directive TEXT,
  -- Candidate Codex/World Category entries proposed after Stage 3 (Beats)
  -- is approved — an array of { type, name, entryType?, description }.
  -- Never written to codex_entries/world_categories directly; only
  -- POST .../entities/confirm does that, after the writer reviews the list.
  extracted_entities JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planning_runs_book_id ON planning_runs (book_id);
