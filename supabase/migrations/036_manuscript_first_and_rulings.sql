-- 1) The manuscript-first gate (author's ruling, 26 Nov: "always seek context
--    first from the Manuscript before doing anything at all"; "the manuscript
--    is always the source of truth"). Every manuscript lookup made over MCP is
--    logged here by the read tools themselves; action tools refuse until each
--    name the work mentions has a recent lookup. See CLAUDE.md
--    "Manuscript-First Gate".
CREATE TABLE IF NOT EXISTS manuscript_reads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL,
  -- 'search_manuscript' | 'get_manuscript_chapter' | 'get_codex_entry'
  tool VARCHAR(50) NOT NULL,
  query TEXT,
  chapter_number INT,
  entry_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_manuscript_reads_book_time ON manuscript_reads (book_id, created_at DESC);

-- 2) The author's rulings for a book, as data (clash analysis C9): house rules,
--    banned patterns, voice rulings. Shown to every reviewer; the gatekeeper
--    can BLOCK on a violation. Precedence: author rulings > manuscript facts >
--    craft skills > market.
CREATE TABLE IF NOT EXISTS book_rulings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL,
  ruling TEXT NOT NULL,
  -- 'house_rule' | 'banned_pattern' | 'voice' | 'ruling'
  category VARCHAR(30) NOT NULL DEFAULT 'ruling',
  -- Where it came from, e.g. 'ch573' or 'author, 26 Nov'.
  source TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_book_rulings_book ON book_rulings (book_id) WHERE active;
