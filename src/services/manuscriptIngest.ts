import { getSupabaseClient } from "../lib/supabaseClient.js";
import { generateEmbedding } from "./embedding.js";

const DEFAULT_TARGET_WORDS_PER_CHUNK = 180;

// A "paragraph" (from the blank-line split below) bigger than this multiple
// of targetWords is treated as unsegmented text — e.g. a whole chapter
// pasted with single line breaks between paragraphs rather than blank
// lines — and gets force-split further so it can't become one oversized
// chunk that swallows the entire chapter into a single embedding.
const OVERSIZED_BLOCK_MULTIPLIER = 2;

function wordCountOf(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// Falls back through progressively coarser split strategies until a block
// is broken into pieces no larger than ~targetWords: single newlines (for
// text with one-line-per-paragraph formatting), then sentence boundaries
// (for a block with no newlines at all), then hard word-count slicing as
// the last resort (for a single run-on line with no sentence punctuation).
function splitOversizedBlock(block: string, targetWords: number): string[] {
  if (wordCountOf(block) <= targetWords * OVERSIZED_BLOCK_MULTIPLIER) {
    return [block];
  }

  const lines = block
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    return lines.flatMap((line) => splitOversizedBlock(line, targetWords));
  }

  const sentences = block.match(/[^.!?]+[.!?]+(?:\s+|$)/g);
  if (sentences && sentences.length > 1) {
    const pieces: string[] = [];
    let buffer: string[] = [];
    let bufferWords = 0;

    for (const sentence of sentences) {
      const sentenceWords = wordCountOf(sentence);
      if (bufferWords > 0 && bufferWords + sentenceWords > targetWords) {
        pieces.push(buffer.join("").trim());
        buffer = [];
        bufferWords = 0;
      }
      buffer.push(sentence);
      bufferWords += sentenceWords;
    }
    if (buffer.length > 0) {
      pieces.push(buffer.join("").trim());
    }
    return pieces;
  }

  const words = block.split(/\s+/).filter(Boolean);
  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += targetWords) {
    pieces.push(words.slice(i, i + targetWords).join(" "));
  }
  return pieces;
}

// Groups consecutive paragraphs into ~targetWords-sized chunks without ever
// splitting a paragraph mid-sentence. Keeps chunk granularity consistent
// with the ~150-300 word paragraphs Layer 3 (Deep Past RAG) retrieves.
export function chunkManuscriptText(
  rawText: string,
  targetWords: number = DEFAULT_TARGET_WORDS_PER_CHUNK
): string[] {
  const paragraphs = rawText
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap((paragraph) => splitOversizedBlock(paragraph, targetWords));

  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferWords = 0;

  for (const paragraph of paragraphs) {
    const wordCount = paragraph.split(/\s+/).filter(Boolean).length;

    if (bufferWords > 0 && bufferWords + wordCount > targetWords) {
      chunks.push(buffer.join("\n\n"));
      buffer = [];
      bufferWords = 0;
    }

    buffer.push(paragraph);
    bufferWords += wordCount;
  }

  if (buffer.length > 0) {
    chunks.push(buffer.join("\n\n"));
  }

  return chunks;
}

// Spelled-out chapter numbers up to twenty (e.g. "Chapter Nine") — beyond
// that, real manuscripts overwhelmingly switch to digits ("Chapter 47"),
// which the regex below already handles directly.
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

// Matches a whole line like "Chapter 12", "CHAPTER 12: The Harbor Gate", or
// "Chapter Nine — Homecoming". Deliberately doesn't match "chapter" appearing
// mid-sentence since it requires the line (minus an optional title) to be
// short — see MAX_HEADER_LINE_LENGTH.
const CHAPTER_HEADER_RE = /^chapter\s+([a-z]+|\d+)\s*[:.\-–—]?\s*(.*)$/i;
const MAX_HEADER_LINE_LENGTH = 100;

function resolveChapterNumber(token: string): number | null {
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  return NUMBER_WORDS[token.toLowerCase()] ?? null;
}

export interface ParsedChapter {
  chapterNumber: number;
  title: string | null;
  text: string;
}

// Splits one big pasted manuscript into per-chapter text blocks by
// detecting "Chapter N" header lines. Any text before the first detected
// header (a title page, foreword, etc.) is dropped rather than indexed as
// its own chapter. If no headers are found at all, the whole input is
// treated as a single chapter so bulk import still works for a manuscript
// that isn't chapter-labeled.
export function splitIntoChapters(rawText: string): ParsedChapter[] {
  const lines = rawText.split(/\r?\n/);
  const chapters: ParsedChapter[] = [];

  let currentNumber: number | null = null;
  let currentTitle: string | null = null;
  let currentBody: string[] = [];

  const flush = () => {
    if (currentNumber === null) return;
    const text = currentBody.join("\n").trim();
    if (text) {
      chapters.push({ chapterNumber: currentNumber, title: currentTitle, text });
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length <= MAX_HEADER_LINE_LENGTH) {
      const match = trimmed.match(CHAPTER_HEADER_RE);
      const chapterNumber = match ? resolveChapterNumber(match[1] ?? "") : null;

      if (match && chapterNumber !== null) {
        flush();
        currentNumber = chapterNumber;
        currentTitle = match[2]?.trim() || null;
        currentBody = [];
        continue;
      }
    }
    currentBody.push(line);
  }
  flush();

  if (chapters.length === 0) {
    const text = rawText.trim();
    if (text) {
      chapters.push({ chapterNumber: 1, title: null, text });
    }
  }

  return chapters;
}

export interface IngestManuscriptTextParams {
  userId: string;
  bookId: string;
  chapterNumber: number;
  rawText: string;
  startingSceneOrder?: number;
}

export interface IngestedManuscriptChunk {
  id: string;
  chapter_number: number;
  scene_order: number;
  word_count: number;
}

// Chunks, embeds, and stores manuscript text so it becomes part of Layer
// 3's searchable "Deep Past" memory — this is what keeps that memory
// growing automatically as a writer finishes scenes/chapters, rather than
// staying frozen at whatever was originally seeded.
export async function ingestManuscriptText(
  params: IngestManuscriptTextParams
): Promise<IngestedManuscriptChunk[]> {
  const { userId, bookId, chapterNumber, rawText } = params;
  const supabase = getSupabaseClient();

  let nextSceneOrder: number;
  if (params.startingSceneOrder !== undefined) {
    nextSceneOrder = params.startingSceneOrder;
  } else {
    const { data: existing, error: maxError } = await supabase
      .from("manuscript_chunks")
      .select("scene_order")
      .eq("book_id", bookId)
      .eq("chapter_number", chapterNumber)
      .order("scene_order", { ascending: false })
      .limit(1);

    if (maxError) {
      throw new Error(`Failed to determine next scene_order: ${maxError.message}`);
    }
    nextSceneOrder = (existing?.[0]?.scene_order ?? 0) + 1;
  }

  const chunks = chunkManuscriptText(rawText);
  if (chunks.length === 0) {
    throw new Error("ingestManuscriptText: rawText contained no non-empty paragraphs");
  }

  const ingested: IngestedManuscriptChunk[] = [];

  for (const chunkText of chunks) {
    const embedding = await generateEmbedding(chunkText);
    const { data, error } = await supabase
      .from("manuscript_chunks")
      .insert({
        user_id: userId,
        book_id: bookId,
        chapter_number: chapterNumber,
        scene_order: nextSceneOrder,
        raw_text: chunkText,
        embedding,
      })
      .select("id, chapter_number, scene_order")
      .single();

    if (error) {
      throw new Error(`Failed to store manuscript chunk (scene_order ${nextSceneOrder}): ${error.message}`);
    }

    ingested.push({
      id: data.id,
      chapter_number: data.chapter_number,
      scene_order: data.scene_order,
      word_count: chunkText.split(/\s+/).filter(Boolean).length,
    });

    nextSceneOrder += 1;
  }

  return ingested;
}

export interface BulkIngestManuscriptParams {
  userId: string;
  bookId: string;
  rawText: string;
}

export interface BulkIngestedChapter {
  chapterNumber: number;
  title: string | null;
  wordCount: number;
  chunksStored: number;
}

// Splits one big pasted manuscript into chapters (via splitIntoChapters)
// and runs each through the normal single-chapter ingest pipeline in turn.
// Chapters are processed sequentially, same as their individual chunk
// embeddings — for a full-length novel this is a lot of sequential OpenAI
// calls in one request (see the comment on ingestManuscriptText), so this
// is the first thing to move to a background job if it ever needs to
// handle imports large enough to risk a request timeout.
export async function bulkIngestManuscript(
  params: BulkIngestManuscriptParams
): Promise<BulkIngestedChapter[]> {
  const { userId, bookId, rawText } = params;
  const chapters = splitIntoChapters(rawText);

  if (chapters.length === 0) {
    throw new Error("bulkIngestManuscript: rawText contained no importable content");
  }

  const results: BulkIngestedChapter[] = [];

  for (const chapter of chapters) {
    const chunks = await ingestManuscriptText({
      userId,
      bookId,
      chapterNumber: chapter.chapterNumber,
      rawText: chapter.text,
    });

    results.push({
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      wordCount: wordCountOf(chapter.text),
      chunksStored: chunks.length,
    });
  }

  return results;
}
