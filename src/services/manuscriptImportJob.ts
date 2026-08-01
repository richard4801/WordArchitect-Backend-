import { getSupabaseClient } from "../lib/supabaseClient.js";
import { splitIntoChapters, ingestManuscriptText } from "./manuscriptIngest.js";

export type ImportJobStatus = "pending" | "processing" | "done" | "failed";

export interface ImportJobRow {
  id: string;
  user_id: string;
  book_id: string;
  status: ImportJobStatus;
  next_chapter_index: number;
  chapters_total: number;
  chapters_done: number;
  chunks_stored: number;
  last_chapter_title: string | null;
  error: string | null;
}

export class ImportJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`No import job found with id ${jobId}`);
    this.name = "ImportJobNotFoundError";
  }
}

export interface CreateImportJobParams {
  userId: string;
  bookId: string;
  rawText: string;
}

// Splits rawText into chapters and persists each as its own row in
// manuscript_import_job_chapters (not embedded here — cheap text-only
// inserts, so this stays fast regardless of manuscript size). The slow
// part (chunk + embed + store) happens incrementally in stepImportJob,
// one chapter row at a time, so no single request ever has to touch more
// than one chapter's worth of text.
export async function createImportJob(params: CreateImportJobParams): Promise<ImportJobRow> {
  const { userId, bookId, rawText } = params;
  const chapters = splitIntoChapters(rawText);

  if (chapters.length === 0) {
    throw new Error("createImportJob: rawText contained no importable content");
  }

  const supabase = getSupabaseClient();
  const { data: job, error: jobError } = await supabase
    .from("manuscript_import_jobs")
    .insert({
      user_id: userId,
      book_id: bookId,
      status: "pending",
      next_chapter_index: 0,
      chapters_total: chapters.length,
      chapters_done: 0,
      chunks_stored: 0,
    })
    .select("*")
    .single();

  if (jobError) {
    throw new Error(`Failed to create import job: ${jobError.message}`);
  }

  const chapterRows = chapters.map((chapter, index) => ({
    job_id: job.id,
    chapter_index: index,
    chapter_number: chapter.chapterNumber,
    title: chapter.title,
    raw_text: chapter.text,
  }));

  const { error: chaptersError } = await supabase.from("manuscript_import_job_chapters").insert(chapterRows);

  if (chaptersError) {
    throw new Error(`Failed to store import job chapters: ${chaptersError.message}`);
  }

  return job as ImportJobRow;
}

export async function getImportJob(jobId: string): Promise<ImportJobRow | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_import_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch import job: ${error.message}`);
  }
  return (data as ImportJobRow | null) ?? null;
}

// Processes exactly one chapter's worth of chunk/embed/store work, then
// persists updated progress and returns. Meant to be called repeatedly by
// the client (once per HTTP request) until status is "done" or "failed" —
// each call stays short and its cost is proportional to one chapter, not
// the whole manuscript, regardless of how far into a long import this is.
//
// Not safe against two callers stepping the same job concurrently (no
// row-level claim/lock) — fine for a single sequential poller, which is
// the only real caller today; add locking if that ever changes.
export async function stepImportJob(jobId: string): Promise<ImportJobRow> {
  const supabase = getSupabaseClient();
  const job = await getImportJob(jobId);

  if (!job) {
    throw new ImportJobNotFoundError(jobId);
  }
  // "done" is terminal. "failed" is not — next_chapter_index was never
  // advanced past the chapter that failed, so stepping a failed job just
  // retries that same chapter. A transient embedding/network error
  // shouldn't permanently brick an otherwise-working import.
  if (job.status === "done") {
    return job;
  }

  const { data: chapter, error: chapterError } = await supabase
    .from("manuscript_import_job_chapters")
    .select("chapter_number, title, raw_text")
    .eq("job_id", jobId)
    .eq("chapter_index", job.next_chapter_index)
    .maybeSingle();

  if (chapterError) {
    throw new Error(`Failed to fetch next chapter for import job: ${chapterError.message}`);
  }

  if (!chapter) {
    const { data, error } = await supabase
      .from("manuscript_import_jobs")
      .update({ status: "done", updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to finalize import job: ${error.message}`);
    return data as ImportJobRow;
  }

  await supabase
    .from("manuscript_import_jobs")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", jobId);

  try {
    const chunks = await ingestManuscriptText({
      userId: job.user_id,
      bookId: job.book_id,
      chapterNumber: chapter.chapter_number,
      rawText: chapter.raw_text,
    });

    const nextIndex = job.next_chapter_index + 1;
    const isDone = nextIndex >= job.chapters_total;

    const { data, error } = await supabase
      .from("manuscript_import_jobs")
      .update({
        status: isDone ? "done" : "processing",
        next_chapter_index: nextIndex,
        chapters_done: job.chapters_done + 1,
        chunks_stored: job.chunks_stored + chunks.length,
        last_chapter_title: chapter.title ?? `Chapter ${chapter.chapter_number}`,
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .select("*")
      .single();

    if (error) throw new Error(`Failed to update import job progress: ${error.message}`);
    return data as ImportJobRow;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { data, error } = await supabase
      .from("manuscript_import_jobs")
      .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to record import job failure: ${error.message}`);
    return data as ImportJobRow;
  }
}
