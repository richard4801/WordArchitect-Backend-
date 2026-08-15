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

  const chapterIds = (chapters ?? []).map((c) => c.id);
  if (chapterIds.length === 0) {
    res.json({ parts: parts ?? [], chapters: [], beats: [] });
    return;
  }

  const { data: beats, error: beatsError } = await supabase
    .from("chapter_beats")
    .select("*")
    .in("chapter_id", chapterIds)
    .order("order_index", { ascending: true });

  if (beatsError) {
    res.status(502).json({ error: "Failed to load beats." });
    return;
  }

  res.json({ parts: parts ?? [], chapters: chapters ?? [], beats: beats ?? [] });
});
