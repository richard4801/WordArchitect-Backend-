import { getSupabaseClient } from "../lib/supabaseClient.js";
import { generateEmbedding } from "./embedding.js";

const DEFAULT_TARGET_WORDS_PER_CHUNK = 180;

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
    .filter(Boolean);

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
