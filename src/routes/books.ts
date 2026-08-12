import { Router, type Request, type Response } from "express";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { getBookFacts } from "../services/bookFacts.js";

export const booksRouter = Router();

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// Maps the request body's camelCase fields onto books' snake_case columns,
// validating each field only when present. `requireCore` enforces
// userId/title for creation; PATCH omits it so every field stays optional
// on update.
function buildBookPayload(
  body: Record<string, unknown>,
  requireCore: boolean
): { payload: Record<string, unknown>; error: string | null } {
  const payload: Record<string, unknown> = {};

  if (requireCore || body.userId !== undefined) {
    if (typeof body.userId !== "string" || body.userId.trim() === "") {
      return { payload, error: "userId is required and must be a non-empty string." };
    }
    payload.user_id = body.userId;
  }
  if (requireCore || body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.trim() === "") {
      return { payload, error: "title is required and must be a non-empty string." };
    }
    payload.title = body.title;
  }

  if (body.tagline !== undefined) {
    if (body.tagline !== null && typeof body.tagline !== "string")
      return { payload, error: "tagline must be a string." };
    payload.tagline = body.tagline;
  }
  if (body.genre !== undefined) {
    if (body.genre !== null && typeof body.genre !== "string") return { payload, error: "genre must be a string." };
    payload.genre = body.genre;
  }
  if (body.subgenres !== undefined) {
    if (body.subgenres !== null && !isStringArray(body.subgenres))
      return { payload, error: "subgenres must be an array of strings." };
    payload.subgenres = body.subgenres;
  }
  if (body.pov !== undefined) {
    if (body.pov !== null && typeof body.pov !== "string") return { payload, error: "pov must be a string." };
    payload.pov = body.pov;
  }
  if (body.tense !== undefined) {
    if (body.tense !== null && typeof body.tense !== "string") return { payload, error: "tense must be a string." };
    payload.tense = body.tense;
  }
  if (body.targetWords !== undefined) {
    if (body.targetWords !== null && typeof body.targetWords !== "number")
      return { payload, error: "targetWords must be a number." };
    payload.target_words = body.targetWords;
  }
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || body.status.trim() === "")
      return { payload, error: "status must be a non-empty string." };
    payload.status = body.status;
  }
  if (body.coverUrl !== undefined) {
    if (body.coverUrl !== null && typeof body.coverUrl !== "string")
      return { payload, error: "coverUrl must be a string." };
    payload.cover_url = body.coverUrl;
  }

  return { payload, error: null };
}

// GET /api/v1/books?userId=...
booksRouter.get("/books", async (req: Request, res: Response) => {
  const userId = req.query.userId;
  if (typeof userId !== "string" || userId.trim() === "") {
    res.status(400).json({ error: "userId query parameter is required." });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("books")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("list books failed:", error);
    res.status(502).json({ error: "Failed to list books." });
    return;
  }
  res.json({ books: data });
});

// GET /api/v1/books/:id — includes best-effort manuscript stats (highest
// chapter, total chapters, total chunks) from the same get_book_facts RPC
// /ask uses, since a project's chapter count is derived from manuscript
// data, not something stored on the book row itself. Falls back to nulls
// rather than failing the whole request if that lookup errors (e.g. no
// manuscript ingested yet for a brand-new project).
booksRouter.get("/books/:id", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("books").select("*").eq("id", req.params.id).maybeSingle();

  if (error) {
    console.error("get book failed:", error);
    res.status(502).json({ error: "Failed to fetch book." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No book found with id ${req.params.id}.` });
    return;
  }

  let facts = { highestChapter: null as number | null, totalChapters: 0, totalChunks: 0 };
  try {
    facts = await getBookFacts(req.params.id as string);
  } catch (factsError) {
    console.error("get_book_facts lookup failed for book detail (non-fatal):", factsError);
  }

  res.json({ book: data, stats: facts });
});

// POST /api/v1/books
booksRouter.post("/books", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { payload, error: validationError } = buildBookPayload(body, true);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("books").insert(payload).select("*").single();

  if (error) {
    console.error("book creation failed:", error);
    res.status(502).json({ error: "Failed to create book." });
    return;
  }
  res.status(201).json({ book: data });
});

// PATCH /api/v1/books/:id
booksRouter.patch("/books/:id", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { payload, error: validationError } = buildBookPayload(body, false);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }
  if (Object.keys(payload).length === 0) {
    res.status(400).json({ error: "No updatable fields were provided." });
    return;
  }
  payload.updated_at = new Date().toISOString();

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("books").update(payload).eq("id", req.params.id).select("*").maybeSingle();

  if (error) {
    console.error("book update failed:", error);
    res.status(502).json({ error: "Failed to update book." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No book found with id ${req.params.id}.` });
    return;
  }
  res.json({ book: data });
});

// DELETE /api/v1/books/:id — deletes only the project's own metadata row.
// Deliberately does not cascade to codex_entries/manuscript_chunks/etc.
// (there's no foreign key to cascade through, by design — see migration
// 013) so deleting a project can never silently wipe its Codex or
// manuscript memory as an unreviewed side effect.
booksRouter.delete("/books/:id", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("books").delete().eq("id", req.params.id).select("id").maybeSingle();

  if (error) {
    console.error("book deletion failed:", error);
    res.status(502).json({ error: "Failed to delete book." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No book found with id ${req.params.id}.` });
    return;
  }
  res.status(204).send();
});
