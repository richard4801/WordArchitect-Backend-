-- WordArchitect Backend — Stage 2: Initial Schema & pgvector Setup
-- Establishes the Codex (Layer 1) and Manuscript (Layer 2/3) tables that
-- back the Dual-Layer Context Engine, plus the cosine-similarity RPC used
-- by Layer 3 (Deep Past / Vector RAG).

-- ============================================================================
-- 1. Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- 2. codex_entries — characters, locations, items, lore (Layer 1)
-- ============================================================================

CREATE TABLE IF NOT EXISTS codex_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  book_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  aliases VARCHAR(255)[],
  entry_type VARCHAR(50) NOT NULL CHECK (entry_type IN ('character', 'location', 'item', 'lore')),
  description TEXT NOT NULL,
  embedding VECTOR(1536),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_codex_entries_book_id ON codex_entries (book_id);

-- ============================================================================
-- 3. manuscript_chunks — embedded manuscript history (Layer 2/3)
-- ============================================================================

CREATE TABLE IF NOT EXISTS manuscript_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  book_id UUID NOT NULL,
  chapter_number INT NOT NULL,
  scene_order INT NOT NULL,
  raw_text TEXT NOT NULL,
  embedding VECTOR(1536),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manuscript_chunks_book_id ON manuscript_chunks (book_id);

-- ============================================================================
-- 4. Vector indexes (HNSW, cosine distance) for high-speed similarity search
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_codex_entries_embedding
  ON codex_entries
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_manuscript_chunks_embedding
  ON manuscript_chunks
  USING hnsw (embedding vector_cosine_ops);

-- ============================================================================
-- 5. match_manuscript_chunks — Layer 3 (Deep Past RAG) similarity search
-- ============================================================================

CREATE OR REPLACE FUNCTION match_manuscript_chunks(
  query_embedding VECTOR(1536),
  match_threshold FLOAT,
  match_count INT,
  target_book_id UUID
)
RETURNS TABLE (
  id UUID,
  raw_text TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    manuscript_chunks.id,
    manuscript_chunks.raw_text,
    1 - (manuscript_chunks.embedding <=> query_embedding) AS similarity
  FROM manuscript_chunks
  WHERE manuscript_chunks.book_id = target_book_id
    AND manuscript_chunks.embedding IS NOT NULL
    AND 1 - (manuscript_chunks.embedding <=> query_embedding) > match_threshold
  ORDER BY manuscript_chunks.embedding <=> query_embedding ASC
  LIMIT match_count;
END;
$$;
