-- Reverts 008_book_instructions.sql. The persistent, saved-once-per-book
-- instructions panel was replaced by fresh, per-generation MUST/MUST NOT
-- instructions entered directly on each /generate-prose call (see
-- buildChapterInstructionsSection in src/services/rag.ts) — the writer
-- wanted a space filled in before writing a given chapter, not a default
-- silently reapplied to every future chapter. Kept as its own migration
-- (rather than deleting 008) for a traceable history, same as
-- 006_remove_codex_enrichment.sql reverting 005.
DROP TABLE IF EXISTS book_instructions;
