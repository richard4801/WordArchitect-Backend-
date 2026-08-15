import { Router, type Request, type Response } from "express";
import { getSupabaseClient } from "../lib/supabaseClient.js";

export const outlineRouter = Router();

// GET /api/v1/outline/beats?bookId= — everything needed to render the full
// Acts -> Chapters -> Beats board (parts, chapter metadata, and every beat
// across the book), returned flat rather than deeply nested — same
// convention as GET /manuscript/chapters/:id returning { chapter, scenes }
// separately. The frontend groups beats under chapters under parts itself;
// for a single open chapter's beats (the editor's own Outline side-panel
// tab), use GET /manuscript/chapters/:chapterId/beats instead.
outlineRouter.get("/outline/beats", async (req: Request, res: Response) => {
  const bookId = req.query.bookId;
  if (typeof bookId !== "string" || bookId.trim() === "") {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }

  const supabase = getSupabaseClient();

  const [{ data: parts, error: partsError }, { data: chapters, error: chaptersError }] = await Promise.all([
    supabase.from("manuscript_parts").select("*").eq("book_id", bookId).order("order_index", { ascending: true }),
    supabase
      .from("manuscript_chapters")
      .select("id, part_id, number, title, heading, complete")
      .eq("book_id", bookId)
      .order("number", { ascending: true }),
  ]);

  if (partsError || chaptersError) {
    res.status(502).json({ error: "Failed to load outline structure." });
    return;
  }

  if ((chapters ?? []).length === 0) {
    res.json({ parts: parts ?? [], chapters: [], beats: [] });
    return;
  }

  // Filtered via a PostgREST FK-embedded join on manuscript_chapters.book_id
  // rather than .in("chapter_id", <every chapter id in the book>) — a real
  // book can have hundreds of chapters (confirmed against production: one
  // real book has 403), and passing that many UUIDs as an .in() filter
  // encodes them all into the request URL, which blows past PostgREST's
  // ~16KB header limit and fails with a HeadersOverflowError. Filtering on
  // the embedded relationship instead sends one UUID regardless of chapter
  // count, so this scales the same way at 10 chapters or 1,000.
  const { data: beatsWithChapter, error: beatsError } = await supabase
    .from("chapter_beats")
    .select("*, manuscript_chapters!inner(book_id)")
    .eq("manuscript_chapters.book_id", bookId)
    .order("order_index", { ascending: true });

  if (beatsError) {
    console.error("outline beats query failed:", beatsError);
    res.status(502).json({ error: "Failed to load beats." });
    return;
  }

  const beats = (beatsWithChapter ?? []).map(({ manuscript_chapters, ...beat }) => beat);

  res.json({ parts: parts ?? [], chapters: chapters ?? [], beats });
});
