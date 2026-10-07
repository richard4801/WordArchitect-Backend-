-- Collaboration Learnings: a growing, per-writer record of what Claude
-- learns actually working this book's Hanami generation and this writer's
-- own feedback/preferences -- distinct from LEARNINGS.md (repo root),
-- which is the engineering/deploy-gotchas log for people working ON this
-- codebase. This table is knowledge accumulated FROM using the product:
-- a Hanami quirk discovered during a supervised scene-draft session, a
-- writer's stated preference ("don't open chapters with weather"), a
-- continuity miss worth remembering next time -- the real-usage
-- counterpart to the static "Hanami behavior patterns" baked into
-- generate_prose_direct's tool description at dev time.
--
-- Scoped by user_id, not book_id -- same reasoning this project already
-- applied to Banned Terms (migration 031): a lesson about how this
-- writer likes feedback, or a Hanami behavior pattern encountered on one
-- project, is a property of (this writer, this platform), not one story,
-- and should carry forward into their next book rather than being
-- re-learned per project. book_id is kept as optional provenance (which
-- book surfaced this, if any) -- nullable, since not every lesson is
-- tied to a specific book (e.g. a general Hanami quirk).
CREATE TABLE collaboration_learnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  book_id UUID,
  -- Open-ended, not a CHECK enum -- same reasoning as codex_entries.
  -- entry_type and book_links.link_type: the real set of categories this
  -- will ever need isn't settled. Conventional values so far:
  -- 'hanami_behavior', 'writer_preference', 'continuity_flag', 'craft_note'.
  category VARCHAR(50) NOT NULL,
  lesson TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_collaboration_learnings_user_id ON collaboration_learnings (user_id);
CREATE INDEX idx_collaboration_learnings_book_id ON collaboration_learnings (book_id) WHERE book_id IS NOT NULL;
