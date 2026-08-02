import { getSupabaseClient } from "../lib/supabaseClient.js";
import { textMentionsAnyOf } from "../lib/textMatch.js";
import { truncateToTokenBudget } from "../lib/tokenBudget.js";
import { enrichFromChunk } from "./codexEnrichment.js";

// The enrichment prompt asks the model to keep each merged auto_summary to
// ~100 words, but that's a request, not a guarantee — repeated
// summarization tends to drift longer over many updates as a model stays
// reluctant to actually drop earlier detail, especially for a heavily-
// mentioned character. This is the server-side backstop: auto_summary can
// never exceed this regardless of what any single model call returns, so
// one entry's summary can't crowd out others sharing Layer 1's token
// budget (see rag.ts's LAYER1_TOKEN_BUDGET).
const AUTO_SUMMARY_MAX_TOKENS = 150;

export type CodexSyncJobStatus = "pending" | "processing" | "done" | "failed";

export interface CodexSyncJobRow {
  id: string;
  user_id: string;
  book_id: string;
  status: CodexSyncJobStatus;
  next_chunk_offset: number;
  chunks_total: number;
  chunks_processed: number;
  entries_updated: number;
  entries_created: number;
  last_chunk_summary: string | null;
  error: string | null;
}

export class CodexSyncJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`No codex sync job found with id ${jobId}`);
    this.name = "CodexSyncJobNotFoundError";
  }
}

interface ExistingCodexRow {
  id: string;
  name: string;
  aliases: string[] | null;
  auto_summary: string | null;
  description: string;
}

export interface CreateCodexSyncJobParams {
  userId: string;
  bookId: string;
}

// Counts the book's manuscript_chunks (fast — no embedding or LLM calls)
// and creates a job that will sweep through them one at a time via
// stepCodexSyncJob. Kept separate from stepping for the same reason as
// the bulk-import job: never make manuscript size a factor in how long a
// single request takes.
export async function createCodexSyncJob(params: CreateCodexSyncJobParams): Promise<CodexSyncJobRow> {
  const { userId, bookId } = params;
  const supabase = getSupabaseClient();

  const { count, error: countError } = await supabase
    .from("manuscript_chunks")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId);

  if (countError) {
    throw new Error(`Failed to count manuscript chunks: ${countError.message}`);
  }
  if (!count || count === 0) {
    throw new Error("createCodexSyncJob: this book has no ingested manuscript chunks yet");
  }

  const { data, error } = await supabase
    .from("codex_sync_jobs")
    .insert({
      user_id: userId,
      book_id: bookId,
      status: "pending",
      next_chunk_offset: 0,
      chunks_total: count,
      chunks_processed: 0,
      entries_updated: 0,
      entries_created: 0,
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(`Failed to create codex sync job: ${error.message}`);
  }

  return data as CodexSyncJobRow;
}

export async function getCodexSyncJob(jobId: string): Promise<CodexSyncJobRow | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("codex_sync_jobs").select("*").eq("id", jobId).maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch codex sync job: ${error.message}`);
  }
  return (data as CodexSyncJobRow | null) ?? null;
}

// Processes exactly one manuscript chunk: finds which existing Codex
// entries it mentions, asks the enrichment model to update those entries'
// auto_summary and/or propose brand-new entries for anything prominent
// that isn't tracked yet, applies the results, records mentions, and
// advances the cursor. Same one-step-per-call shape as the bulk import
// job, for the same reason — safe on a platform with no long-request
// tolerance and no separate worker process.
export async function stepCodexSyncJob(jobId: string): Promise<CodexSyncJobRow> {
  const supabase = getSupabaseClient();
  const job = await getCodexSyncJob(jobId);

  if (!job) {
    throw new CodexSyncJobNotFoundError(jobId);
  }
  if (job.status === "done") {
    return job;
  }

  const { data: chunkPage, error: chunkError } = await supabase
    .from("manuscript_chunks")
    .select("id, raw_text")
    .eq("book_id", job.book_id)
    .order("chapter_number", { ascending: true })
    .order("scene_order", { ascending: true })
    .range(job.next_chunk_offset, job.next_chunk_offset);

  if (chunkError) {
    throw new Error(`Failed to fetch next chunk for codex sync job: ${chunkError.message}`);
  }

  const chunk = chunkPage?.[0];
  if (!chunk) {
    const { data, error } = await supabase
      .from("codex_sync_jobs")
      .update({ status: "done", updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to finalize codex sync job: ${error.message}`);
    return data as CodexSyncJobRow;
  }

  await supabase
    .from("codex_sync_jobs")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", jobId);

  try {
    const { data: existingEntries, error: entriesError } = await supabase
      .from("codex_entries")
      .select("id, name, aliases, auto_summary, description")
      .eq("book_id", job.book_id);

    if (entriesError) {
      throw new Error(`Failed to fetch existing codex entries: ${entriesError.message}`);
    }

    const allEntries = (existingEntries ?? []) as ExistingCodexRow[];
    const matched = allEntries.filter((entry) => textMentionsAnyOf(chunk.raw_text, [entry.name, ...(entry.aliases ?? [])]));

    const result = await enrichFromChunk(
      chunk.raw_text,
      matched.map((e) => ({ name: e.name, currentUnderstanding: e.auto_summary || e.description })),
      allEntries.map((e) => e.name)
    );

    let entriesUpdated = 0;
    let entriesCreated = 0;

    for (const update of result.updates) {
      const entry = matched.find((e) => e.name.toLowerCase() === update.name.toLowerCase());
      if (!entry) continue;

      const { error: updateError } = await supabase
        .from("codex_entries")
        .update({ auto_summary: truncateToTokenBudget(update.summary, AUTO_SUMMARY_MAX_TOKENS) })
        .eq("id", entry.id);
      if (updateError) {
        console.error(`Failed to update auto_summary for "${entry.name}":`, updateError.message);
        continue;
      }

      await supabase
        .from("codex_mentions")
        .upsert(
          { codex_entry_id: entry.id, manuscript_chunk_id: chunk.id, book_id: job.book_id },
          { onConflict: "codex_entry_id,manuscript_chunk_id", ignoreDuplicates: true }
        );
      entriesUpdated += 1;
    }

    const existingNamesLower = new Set(allEntries.map((e) => e.name.toLowerCase()));
    for (const proposed of result.newEntries) {
      if (existingNamesLower.has(proposed.name.toLowerCase())) continue;

      const { data: created, error: createError } = await supabase
        .from("codex_entries")
        .insert({
          user_id: job.user_id,
          book_id: job.book_id,
          name: proposed.name,
          entry_type: proposed.entryType,
          description: proposed.description,
          auto_generated: true,
        })
        .select("id")
        .single();

      if (createError) {
        console.error(`Failed to create proposed entry "${proposed.name}":`, createError.message);
        continue;
      }

      await supabase
        .from("codex_mentions")
        .upsert(
          { codex_entry_id: created.id, manuscript_chunk_id: chunk.id, book_id: job.book_id },
          { onConflict: "codex_entry_id,manuscript_chunk_id", ignoreDuplicates: true }
        );
      entriesCreated += 1;
      existingNamesLower.add(proposed.name.toLowerCase());
    }

    const nextOffset = job.next_chunk_offset + 1;
    const isDone = nextOffset >= job.chunks_total;

    const { data, error } = await supabase
      .from("codex_sync_jobs")
      .update({
        status: isDone ? "done" : "processing",
        next_chunk_offset: nextOffset,
        chunks_processed: job.chunks_processed + 1,
        entries_updated: job.entries_updated + entriesUpdated,
        entries_created: job.entries_created + entriesCreated,
        last_chunk_summary: chunk.raw_text.slice(0, 80),
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .select("*")
      .single();

    if (error) throw new Error(`Failed to update codex sync job progress: ${error.message}`);
    return data as CodexSyncJobRow;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { data, error } = await supabase
      .from("codex_sync_jobs")
      .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to record codex sync job failure: ${error.message}`);
    return data as CodexSyncJobRow;
  }
}
