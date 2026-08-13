import { Router, type Request, type Response } from "express";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { VALID_NOTE_CATEGORIES, type NoteCategory } from "../types/domain.js";

export const notesRouter = Router();

// Maps the request body's camelCase fields onto notes' snake_case columns,
// validating each field only when present. `requireCore` enforces
// userId/bookId/title/excerpt/category for creation; PATCH omits it so
// every field stays optional on update.
function buildNotePayload(
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
  if (requireCore || body.bookId !== undefined) {
    if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
      return { payload, error: "bookId is required and must be a non-empty string." };
    }
    payload.book_id = body.bookId;
  }
  if (requireCore || body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.trim() === "") {
      return { payload, error: "title is required and must be a non-empty string." };
    }
    payload.title = body.title;
  }
  if (requireCore || body.excerpt !== undefined) {
    if (typeof body.excerpt !== "string" || body.excerpt.trim() === "") {
      return { payload, error: "excerpt is required and must be a non-empty string." };
    }
    payload.excerpt = body.excerpt;
  }
  if (requireCore || body.category !== undefined) {
    if (typeof body.category !== "string" || !VALID_NOTE_CATEGORIES.includes(body.category as NoteCategory)) {
      return { payload, error: `category must be one of: ${VALID_NOTE_CATEGORIES.join(", ")}.` };
    }
    payload.category = body.category;
  }

  if (body.pinned !== undefined) {
    if (typeof body.pinned !== "boolean") return { payload, error: "pinned must be a boolean." };
    payload.pinned = body.pinned;
  }
  if (body.comments !== undefined) {
    if (typeof body.comments !== "number" || !Number.isInteger(body.comments) || body.comments < 0) {
      return { payload, error: "comments must be a non-negative integer." };
    }
    payload.comments = body.comments;
  }

  return { payload, error: null };
}

// Pinned notes first, then most recently updated — matches the
// frontend's dateRank-style "recent activity" ordering. Exported for
// reuse by the MCP server's list_notes tool and the Chat Assistant's
// tool loop (src/services/chatAssistant.ts), so both LLM-facing surfaces
// query notes identically rather than each inlining their own version.
export async function listNotesForBook(
  bookId: string,
  options: { category?: string | undefined; pinned?: boolean | undefined } = {}
) {
  const supabase = getSupabaseClient();
  let query = supabase.from("notes").select("*").eq("book_id", bookId);
  if (options.category) query = query.eq("category", options.category);
  if (options.pinned !== undefined) query = query.eq("pinned", options.pinned);

  const { data, error } = await query
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`Failed to list notes: ${error.message}`);
  return data;
}

// GET /api/v1/notes?bookId=&category=&pinned=
notesRouter.get("/notes", async (req: Request, res: Response) => {
  const bookId = req.query.bookId;
  if (typeof bookId !== "string" || bookId.trim() === "") {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }

  try {
    const notes = await listNotesForBook(bookId, {
      category: typeof req.query.category === "string" ? req.query.category : undefined,
      pinned: typeof req.query.pinned === "string" ? req.query.pinned === "true" : undefined,
    });
    res.json({ notes });
  } catch (error) {
    console.error("list notes failed:", error);
    res.status(502).json({ error: "Failed to list notes." });
  }
});

// GET /api/v1/notes/:id
notesRouter.get("/notes/:id", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("notes").select("*").eq("id", req.params.id).maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to fetch note." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No note found with id ${req.params.id}.` });
    return;
  }
  res.json({ note: data });
});

// POST /api/v1/notes
notesRouter.post("/notes", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { payload, error: validationError } = buildNotePayload(body, true);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("notes").insert(payload).select("*").single();

  if (error) {
    console.error("note creation failed:", error);
    res.status(502).json({ error: "Failed to create note." });
    return;
  }
  res.status(201).json({ note: data });
});

// PATCH /api/v1/notes/:id
notesRouter.patch("/notes/:id", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { payload, error: validationError } = buildNotePayload(body, false);
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
  const { data, error } = await supabase
    .from("notes")
    .update(payload)
    .eq("id", req.params.id)
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("note update failed:", error);
    res.status(502).json({ error: "Failed to update note." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No note found with id ${req.params.id}.` });
    return;
  }
  res.json({ note: data });
});

// DELETE /api/v1/notes/:id
notesRouter.delete("/notes/:id", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("notes").delete().eq("id", req.params.id).select("id").maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to delete note." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No note found with id ${req.params.id}.` });
    return;
  }
  res.status(204).end();
});
