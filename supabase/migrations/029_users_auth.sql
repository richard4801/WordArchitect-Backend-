-- Real accounts, closing the "no authentication" gap CLAUDE.md has
-- documented since migration 013_books.sql as a conscious, deferred
-- tradeoff. Concretely motivated by a real failure mode: userId has
-- always been whatever the frontend sends, and with no login the
-- frontend had nowhere to persist that value except one browser's local
-- storage -- so a new device or a fresh/incognito browser context had no
-- way to "be" the same person, and came up with zero books despite the
-- account's real data being perfectly intact server-side.
--
-- No FK from books.user_id (or codex_entries/manuscript_chunks/notes/etc)
-- to this table -- same reasoning already established for books.id itself
-- (013_books.sql): those columns already hold real production values that
-- predate this table, and a FK now would block legitimate existing rows
-- rather than protect anything. This migration only adds the ability to
-- authenticate as a given user_id going forward; it doesn't retroactively
-- constrain what's already there.
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
