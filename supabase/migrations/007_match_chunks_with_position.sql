-- Layer 3 needs to know WHERE a matched chunk sits (chapter_number,
-- scene_order) so it can expand a single match into its full surrounding
-- chapter instead of injecting one isolated ~180-word fragment. Postgres
-- requires dropping a function before changing its return signature.
DROP FUNCTION IF EXISTS match_manuscript_chunks(VECTOR(1536), FLOAT, INT, UUID);

CREATE FUNCTION match_manuscript_chunks(
  query_embedding VECTOR(1536),
  match_threshold FLOAT,
  match_count INT,
  target_book_id UUID
)
RETURNS TABLE (
  id UUID,
  raw_text TEXT,
  chapter_number INT,
  scene_order INT,
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
    manuscript_chunks.chapter_number,
    manuscript_chunks.scene_order,
    1 - (manuscript_chunks.embedding <=> query_embedding) AS similarity
  FROM manuscript_chunks
  WHERE manuscript_chunks.book_id = target_book_id
    AND manuscript_chunks.embedding IS NOT NULL
    AND 1 - (manuscript_chunks.embedding <=> query_embedding) > match_threshold
  ORDER BY manuscript_chunks.embedding <=> query_embedding ASC
  LIMIT match_count;
END;
$$;
