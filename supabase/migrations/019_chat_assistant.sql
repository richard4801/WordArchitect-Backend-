-- In-app AI Assistant (Claude-backed chat, distinct from Hanami prose
-- generation) — the "Chat Assistant" surface: persona-based conversations
-- (Story Assistant, Character Coach, Worldbuilding Guide, Writing Editor,
-- Brainstormer) that can read the book's real Codex/manuscript/notes data
-- via tool calls, for brainstorming and structural/creative advice rather
-- than manuscript prose generation (that stays Hanami's job via
-- /generate-prose and the scene-draft-session tools).
--
-- Same session/message split as any chat product: one row per
-- conversation, one row per turn — not collapsed into a single JSONB
-- blob on the session row, so a long conversation doesn't mean rewriting
-- and re-sending the entire history on every append.

CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  book_id UUID NOT NULL,
  persona VARCHAR(50) NOT NULL DEFAULT 'general',
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_book_id ON chat_sessions (book_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  -- Which read tools (list_codex_entries, search_manuscript, etc.) the
  -- assistant called while producing this message, and with what input —
  -- transparency into what it actually looked up, the same principle as
  -- the Ghost Editor correction report and record_scene_draft_iteration's
  -- diffFromPrevious. Null for user messages.
  tool_calls JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages (session_id);
