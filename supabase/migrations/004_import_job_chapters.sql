-- Splits chapter text out of manuscript_import_jobs into its own table.
-- The old design stored every chapter's full text in one JSONB column on
-- the job row, which meant every step re-fetched (and re-returned via
-- UPDATE...RETURNING) the *entire remaining manuscript* — cost that grew
-- with manuscript size instead of staying flat per step, causing
-- increasingly slow/failing requests on a long import. Now each step only
-- touches the one chapter row it's actually processing.
ALTER TABLE manuscript_import_jobs DROP COLUMN chapters;

CREATE TABLE manuscript_import_job_chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES manuscript_import_jobs(id) ON DELETE CASCADE,
  chapter_index INT NOT NULL,
  chapter_number INT NOT NULL,
  title TEXT,
  raw_text TEXT NOT NULL
);

CREATE INDEX idx_import_job_chapters_job_id_index
  ON manuscript_import_job_chapters(job_id, chapter_index);
