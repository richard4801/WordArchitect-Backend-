import { Router, type Request, type Response } from "express";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { ingestManuscriptText } from "../services/manuscriptIngest.js";

export const manuscriptChaptersRouter = Router();

function isParagraphsArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
      const paragraph = item as Record<string, unknown>;
      return typeof paragraph.id === "string" && typeof paragraph.text === "string";
    })
  );
}

// ============================================================================
// Parts (light chapter grouping — matches the frontend's ManuscriptPart)
// ============================================================================

// GET /api/v1/manuscript/parts?bookId=
manuscriptChaptersRouter.get("/manuscript/parts", async (req: Request, res: Response) => {
  const bookId = req.query.bookId;
  if (typeof bookId !== "string" || bookId.trim() === "") {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_parts")
    .select("*")
    .eq("book_id", bookId)
    .order("order_index", { ascending: true });

  if (error) {
    res.status(502).json({ error: "Failed to list manuscript parts." });
    return;
  }
  res.json({ parts: data });
});

// POST /api/v1/manuscript/parts
manuscriptChaptersRouter.post("/manuscript/parts", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }
  if (typeof body.title !== "string" || body.title.trim() === "") {
    res.status(400).json({ error: "title is required and must be a non-empty string." });
    return;
  }
  if (body.orderIndex !== undefined && typeof body.orderIndex !== "number") {
    res.status(400).json({ error: "orderIndex must be a number." });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_parts")
    .insert({ book_id: body.bookId, title: body.title, order_index: body.orderIndex ?? 0 })
    .select("*")
    .single();

  if (error) {
    console.error("manuscript part creation failed:", error);
    res.status(502).json({ error: "Failed to create manuscript part." });
    return;
  }
  res.status(201).json({ part: data });
});

// PATCH /api/v1/manuscript/parts/:id
manuscriptChaptersRouter.patch("/manuscript/parts/:id", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const payload: Record<string, unknown> = {};

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.trim() === "") {
      res.status(400).json({ error: "title must be a non-empty string." });
      return;
    }
    payload.title = body.title;
  }
  if (body.orderIndex !== undefined) {
    if (typeof body.orderIndex !== "number") {
      res.status(400).json({ error: "orderIndex must be a number." });
      return;
    }
    payload.order_index = body.orderIndex;
  }
  if (Object.keys(payload).length === 0) {
    res.status(400).json({ error: "No updatable fields were provided." });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_parts")
    .update(payload)
    .eq("id", req.params.id)
    .select("*")
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to update manuscript part." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No manuscript part found with id ${req.params.id}.` });
    return;
  }
  res.json({ part: data });
});

// DELETE /api/v1/manuscript/parts/:id — chapters referencing this part have
// part_id set to NULL (ON DELETE SET NULL), never deleted as a side effect.
manuscriptChaptersRouter.delete("/manuscript/parts/:id", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_parts")
    .delete()
    .eq("id", req.params.id)
    .select("id")
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to delete manuscript part." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No manuscript part found with id ${req.params.id}.` });
    return;
  }
  res.status(204).end();
});

// ============================================================================
// Chapters — the rich-editor source of truth
// ============================================================================

// GET /api/v1/manuscript/chapters?bookId= — metadata only (no paragraphs),
// for a chapter list/navigation view. Use GET /manuscript/chapters/:id for
// full content.
manuscriptChaptersRouter.get("/manuscript/chapters", async (req: Request, res: Response) => {
  const bookId = req.query.bookId;
  if (typeof bookId !== "string" || bookId.trim() === "") {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_chapters")
    .select("id, user_id, book_id, part_id, number, title, heading, complete, synced_to_memory_at, created_at, updated_at")
    .eq("book_id", bookId)
    .order("number", { ascending: true });

  if (error) {
    res.status(502).json({ error: "Failed to list manuscript chapters." });
    return;
  }
  res.json({ chapters: data });
});

// GET /api/v1/manuscript/chapters/:id — full content, including paragraphs
// and its scene markers.
manuscriptChaptersRouter.get("/manuscript/chapters/:id", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data: chapter, error } = await supabase
    .from("manuscript_chapters")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to fetch manuscript chapter." });
    return;
  }
  if (!chapter) {
    res.status(404).json({ error: `No manuscript chapter found with id ${req.params.id}.` });
    return;
  }

  const { data: scenes, error: scenesError } = await supabase
    .from("manuscript_scenes")
    .select("*")
    .eq("chapter_id", req.params.id)
    .order("order_index", { ascending: true });

  if (scenesError) {
    res.status(502).json({ error: "Failed to fetch chapter's scenes." });
    return;
  }

  res.json({ chapter, scenes });
});

// POST /api/v1/manuscript/chapters
manuscriptChaptersRouter.post("/manuscript/chapters", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (typeof body.userId !== "string" || body.userId.trim() === "") {
    res.status(400).json({ error: "userId is required and must be a non-empty string." });
    return;
  }
  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }
  if (typeof body.number !== "number" || !Number.isInteger(body.number) || body.number < 1) {
    res.status(400).json({ error: "number is required and must be a positive integer." });
    return;
  }
  if (body.partId !== undefined && body.partId !== null && typeof body.partId !== "string") {
    res.status(400).json({ error: "partId must be a string." });
    return;
  }
  if (body.paragraphs !== undefined && !isParagraphsArray(body.paragraphs)) {
    res.status(400).json({ error: "paragraphs must be an array of { id, text, ... } objects." });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_chapters")
    .insert({
      user_id: body.userId,
      book_id: body.bookId,
      part_id: body.partId ?? null,
      number: body.number,
      title: typeof body.title === "string" ? body.title : null,
      heading: typeof body.heading === "string" ? body.heading : null,
      complete: typeof body.complete === "boolean" ? body.complete : false,
      paragraphs: body.paragraphs ?? [],
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      res.status(409).json({ error: `Chapter ${body.number} already exists for this book.` });
      return;
    }
    console.error("manuscript chapter creation failed:", error);
    res.status(502).json({ error: "Failed to create manuscript chapter." });
    return;
  }
  res.status(201).json({ chapter: data });
});

// PATCH /api/v1/manuscript/chapters/:id — this is the editor's autosave
// endpoint. Cheap and fast: it only ever touches this row, never
// manuscript_chunks/embeddings — see POST .../sync-to-memory for that.
manuscriptChaptersRouter.patch("/manuscript/chapters/:id", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const payload: Record<string, unknown> = {};

  if (body.partId !== undefined) {
    if (body.partId !== null && typeof body.partId !== "string") {
      res.status(400).json({ error: "partId must be a string or null." });
      return;
    }
    payload.part_id = body.partId;
  }
  if (body.number !== undefined) {
    if (typeof body.number !== "number" || !Number.isInteger(body.number) || body.number < 1) {
      res.status(400).json({ error: "number must be a positive integer." });
      return;
    }
    payload.number = body.number;
  }
  if (body.title !== undefined) {
    if (body.title !== null && typeof body.title !== "string") {
      res.status(400).json({ error: "title must be a string." });
      return;
    }
    payload.title = body.title;
  }
  if (body.heading !== undefined) {
    if (body.heading !== null && typeof body.heading !== "string") {
      res.status(400).json({ error: "heading must be a string." });
      return;
    }
    payload.heading = body.heading;
  }
  if (body.complete !== undefined) {
    if (typeof body.complete !== "boolean") {
      res.status(400).json({ error: "complete must be a boolean." });
      return;
    }
    payload.complete = body.complete;
  }
  if (body.paragraphs !== undefined) {
    if (!isParagraphsArray(body.paragraphs)) {
      res.status(400).json({ error: "paragraphs must be an array of { id, text, ... } objects." });
      return;
    }
    payload.paragraphs = body.paragraphs;
  }
  if (Object.keys(payload).length === 0) {
    res.status(400).json({ error: "No updatable fields were provided." });
    return;
  }
  payload.updated_at = new Date().toISOString();

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_chapters")
    .update(payload)
    .eq("id", req.params.id)
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      res.status(409).json({ error: `Chapter ${payload.number} already exists for this book.` });
      return;
    }
    console.error("manuscript chapter update failed:", error);
    res.status(502).json({ error: "Failed to update manuscript chapter." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No manuscript chapter found with id ${req.params.id}.` });
    return;
  }
  res.json({ chapter: data });
});

// DELETE /api/v1/manuscript/chapters/:id — deletes only this chapter's
// editor content and its scene markers (ON DELETE CASCADE). Does NOT touch
// manuscript_chunks — a chapter already synced into Deep Past memory stays
// retrievable even if its editor row is removed, consistent with how
// DELETE /books/:id never cascades into manuscript memory either.
manuscriptChaptersRouter.delete("/manuscript/chapters/:id", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_chapters")
    .delete()
    .eq("id", req.params.id)
    .select("id")
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to delete manuscript chapter." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No manuscript chapter found with id ${req.params.id}.` });
    return;
  }
  res.status(204).end();
});

// POST /api/v1/manuscript/chapters/:id/sync-to-memory — the explicit,
// writer-triggered bridge into Layer 2/3 memory. Reads this chapter's
// current paragraphs, joins them into plain text, DELETES any existing
// manuscript_chunks rows for this book_id + chapter number, then re-runs
// the normal chunk/embed/store pipeline against the fresh text. Replacing
// rather than appending means re-syncing an edited chapter can never leave
// stale/duplicate chunks from a previous draft sitting in Deep Past memory
// alongside the current one.
manuscriptChaptersRouter.post("/manuscript/chapters/:id/sync-to-memory", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data: chapter, error: fetchError } = await supabase
    .from("manuscript_chapters")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (fetchError) {
    res.status(502).json({ error: "Failed to fetch manuscript chapter." });
    return;
  }
  if (!chapter) {
    res.status(404).json({ error: `No manuscript chapter found with id ${req.params.id}.` });
    return;
  }

  const paragraphs = (chapter.paragraphs ?? []) as Record<string, unknown>[];
  const rawText = paragraphs
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter((text) => text.trim() !== "")
    .join("\n\n");

  if (rawText.trim() === "") {
    res.status(400).json({ error: "This chapter has no paragraph text to sync." });
    return;
  }

  try {
    const { error: deleteError } = await supabase
      .from("manuscript_chunks")
      .delete()
      .eq("book_id", chapter.book_id)
      .eq("chapter_number", chapter.number);

    if (deleteError) {
      throw new Error(`Failed to clear previous chunks for this chapter: ${deleteError.message}`);
    }

    const chunks = await ingestManuscriptText({
      userId: chapter.user_id,
      bookId: chapter.book_id,
      chapterNumber: chapter.number,
      rawText,
      startingSceneOrder: 1,
    });

    const syncedAt = new Date().toISOString();
    await supabase.from("manuscript_chapters").update({ synced_to_memory_at: syncedAt }).eq("id", chapter.id);

    res.status(201).json({ chunks, syncedAt });
  } catch (error) {
    console.error("manuscript chapter sync-to-memory failed:", error);
    res.status(502).json({ error: "Failed to sync chapter into manuscript memory. Please try again." });
  }
});

// ============================================================================
// Scenes — lightweight navigation markers within a chapter
// ============================================================================

// GET /api/v1/manuscript/chapters/:chapterId/scenes
manuscriptChaptersRouter.get("/manuscript/chapters/:chapterId/scenes", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_scenes")
    .select("*")
    .eq("chapter_id", req.params.chapterId)
    .order("order_index", { ascending: true });

  if (error) {
    res.status(502).json({ error: "Failed to list chapter scenes." });
    return;
  }
  res.json({ scenes: data });
});

// POST /api/v1/manuscript/chapters/:chapterId/scenes
manuscriptChaptersRouter.post("/manuscript/chapters/:chapterId/scenes", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (typeof body.title !== "string" || body.title.trim() === "") {
    res.status(400).json({ error: "title is required and must be a non-empty string." });
    return;
  }
  if (body.orderIndex !== undefined && typeof body.orderIndex !== "number") {
    res.status(400).json({ error: "orderIndex must be a number." });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_scenes")
    .insert({ chapter_id: req.params.chapterId, title: body.title, order_index: body.orderIndex ?? 0 })
    .select("*")
    .single();

  if (error) {
    console.error("manuscript scene creation failed:", error);
    res.status(502).json({ error: "Failed to create scene." });
    return;
  }
  res.status(201).json({ scene: data });
});

// PATCH /api/v1/manuscript/scenes/:id
manuscriptChaptersRouter.patch("/manuscript/scenes/:id", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const payload: Record<string, unknown> = {};

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.trim() === "") {
      res.status(400).json({ error: "title must be a non-empty string." });
      return;
    }
    payload.title = body.title;
  }
  if (body.orderIndex !== undefined) {
    if (typeof body.orderIndex !== "number") {
      res.status(400).json({ error: "orderIndex must be a number." });
      return;
    }
    payload.order_index = body.orderIndex;
  }
  if (Object.keys(payload).length === 0) {
    res.status(400).json({ error: "No updatable fields were provided." });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_scenes")
    .update(payload)
    .eq("id", req.params.id)
    .select("*")
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to update scene." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No scene found with id ${req.params.id}.` });
    return;
  }
  res.json({ scene: data });
});

// DELETE /api/v1/manuscript/scenes/:id
manuscriptChaptersRouter.delete("/manuscript/scenes/:id", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_scenes")
    .delete()
    .eq("id", req.params.id)
    .select("id")
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to delete scene." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No scene found with id ${req.params.id}.` });
    return;
  }
  res.status(204).end();
});
