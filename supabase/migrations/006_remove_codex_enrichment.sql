-- Removes the automated Codex Enrichment system (see 005). Unsupervised
-- background writes to the Codex are being replaced by a human-reviewed
-- workflow (manual editing, or a future Claude-assisted flow where
-- proposed changes go through normal PATCH /api/v1/codex/:id calls after
-- the writer approves them) — so the separate "AI-written" auto_summary
-- field, and the machinery that populated it, are no longer needed.

-- Removes every entry the sync job proposed (auto_generated = true),
-- along with their codex_mentions and codex_relationships rows via
-- ON DELETE CASCADE.
DELETE FROM codex_entries WHERE auto_generated = true;

ALTER TABLE codex_entries DROP COLUMN auto_summary;
ALTER TABLE codex_entries DROP COLUMN auto_generated;

DROP TABLE codex_mentions;
DROP TABLE codex_sync_jobs;
