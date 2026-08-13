// One-time admin utility: brings a book that predates the Books and
// Manuscript Chapters tables (created by migrations 013 and 015) up to
// date, without touching manuscript_chunks (Deep Past / Layer 3 memory) at
// all — this only ever reads from it.
//
// Does two things, both additive:
//   1. Creates a `books` row with an EXPLICIT id matching the book's
//      existing (pre-Books-table) book_id — something POST /api/v1/books
//      can't do, since it always mints a fresh gen_random_uuid(). Without
//      this, the book has no Project row and won't show up in the
//      frontend's Projects list even though its Codex/manuscript data is
//      all real.
//   2. Reconstructs manuscript_chapters (the rich-editor's source of
//      truth — see CLAUDE.md's "Database Schema" section for why it's a
//      separate table from manuscript_chunks) from the book's existing
//      manuscript_chunks, one row per chapter_number. Each chunk's
//      raw_text is split back on blank-line boundaries (the same
//      convention chunkManuscriptText joined paragraphs with) to recover
//      individual paragraphs — a reasonable reconstruction, not a
//      byte-perfect restoration: a very long original paragraph that
//      chunking force-split at sentence/word boundaries (splitOversizedBlock
//      in manuscriptIngest.ts) can't be perfectly rejoined, since that
//      boundary information wasn't preserved at ingestion time.
//
// Idempotent: skips the books insert if a row with that id already
// exists, and skips the manuscript_chapters backfill entirely if that
// book already has any manuscript_chapters rows (so a second accidental
// run can't create duplicates or clobber real edits).
//
// Usage:
//   tsx scripts/backfill-project-and-chapters.ts \
//     --book-id=<uuid> --user-id=<uuid> --title="Book Title" \
//     [--tagline="..."] [--genre="..."] [--pov="..."] [--tense="..."]

import "dotenv/config";
import { getSupabaseClient } from "../src/lib/supabaseClient.js";
import { splitIntoChapterParagraphs } from "../src/lib/chapterParagraphs.js";

const PAGE_SIZE = 1000;
const CHAPTER_INSERT_BATCH_SIZE = 50;

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  for (const raw of process.argv.slice(2)) {
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]!] = match[2]!;
  }
  return args;
}

interface ManuscriptChunkRow {
  chapter_number: number;
  scene_order: number;
  raw_text: string;
}

// Paginates past Supabase/PostgREST's default 1,000-row cap — the exact
// silent-truncation trap this project's own get_book_facts RPC exists to
// avoid (see CLAUDE.md's Book Facts section). Fetching all chunks
// client-side here is fine since this is a one-time script, not a
// per-request code path.
async function fetchAllChunks(bookId: string): Promise<ManuscriptChunkRow[]> {
  const supabase = getSupabaseClient();
  const all: ManuscriptChunkRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("manuscript_chunks")
      .select("chapter_number, scene_order, raw_text")
      .eq("book_id", bookId)
      .order("chapter_number", { ascending: true })
      .order("scene_order", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`Failed to fetch manuscript_chunks page starting at ${from}: ${error.message}`);
    if (!data || data.length === 0) break;

    all.push(...(data as ManuscriptChunkRow[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return all;
}

async function main() {
  const args = parseArgs();
  const bookId = args["book-id"];
  const userId = args["user-id"];
  const title = args["title"];

  if (!bookId || !userId || !title) {
    console.error("Usage: tsx scripts/backfill-project-and-chapters.ts --book-id=<uuid> --user-id=<uuid> --title=\"...\" [--tagline=...] [--genre=...] [--pov=...] [--tense=...]");
    process.exit(1);
  }

  const supabase = getSupabaseClient();

  // --- 1. Books row (explicit id) ---
  const { data: existingBook, error: existingBookErr } = await supabase
    .from("books")
    .select("id")
    .eq("id", bookId)
    .maybeSingle();
  if (existingBookErr) throw new Error(`Failed to check existing book: ${existingBookErr.message}`);

  if (existingBook) {
    console.log(`books row for ${bookId} already exists — skipping creation.`);
  } else {
    const { error: insertBookErr } = await supabase.from("books").insert({
      id: bookId,
      user_id: userId,
      title,
      tagline: args["tagline"] ?? null,
      genre: args["genre"] ?? null,
      pov: args["pov"] ?? null,
      tense: args["tense"] ?? null,
    });
    if (insertBookErr) throw new Error(`Failed to create books row: ${insertBookErr.message}`);
    console.log(`Created books row ${bookId} — "${title}".`);
  }

  // --- 2. manuscript_chapters backfill from manuscript_chunks ---
  const { count: existingChapterCount, error: existingChaptersErr } = await supabase
    .from("manuscript_chapters")
    .select("*", { count: "exact", head: true })
    .eq("book_id", bookId);
  if (existingChaptersErr) throw new Error(`Failed to check existing manuscript_chapters: ${existingChaptersErr.message}`);

  if ((existingChapterCount ?? 0) > 0) {
    console.log(`manuscript_chapters already has ${existingChapterCount} row(s) for this book — skipping backfill entirely.`);
    return;
  }

  console.log("Fetching all manuscript_chunks (paginated)...");
  const chunks = await fetchAllChunks(bookId);
  console.log(`Fetched ${chunks.length} chunks.`);

  const byChapter = new Map<number, ManuscriptChunkRow[]>();
  for (const chunk of chunks) {
    const list = byChapter.get(chunk.chapter_number) ?? [];
    list.push(chunk);
    byChapter.set(chunk.chapter_number, list);
  }

  const chapterNumbers = Array.from(byChapter.keys()).sort((a, b) => a - b);
  console.log(`Reconstructing ${chapterNumbers.length} chapters (numbers ${chapterNumbers[0]}–${chapterNumbers[chapterNumbers.length - 1]})...`);

  const syncedAt = new Date().toISOString();
  const rows = chapterNumbers.map((number) => {
    const chunksForChapter = byChapter.get(number)!; // already sorted by scene_order from the query
    const paragraphs = chunksForChapter.flatMap((c) => splitIntoChapterParagraphs(c.raw_text));
    return {
      user_id: userId,
      book_id: bookId,
      number,
      complete: true,
      paragraphs,
      synced_to_memory_at: syncedAt,
    };
  });

  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHAPTER_INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + CHAPTER_INSERT_BATCH_SIZE);
    const { error } = await supabase.from("manuscript_chapters").insert(batch);
    if (error) throw new Error(`Failed inserting chapters batch starting at index ${i}: ${error.message}`);
    inserted += batch.length;
    console.log(`  ${inserted}/${rows.length} chapters inserted...`);
  }

  console.log(`Done. Backfilled ${inserted} manuscript_chapters rows for book ${bookId}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
