import { Router, type Request, type Response } from "express";
import { getSupabaseClient } from "../lib/supabaseClient.js";

export const bookLinksRouter = Router();

export interface BookLinkRow {
  id: string;
  from_book_id: string;
  to_book_id: string;
  link_type: string;
  language: string | null;
  created_at: string;
}

export class BookLinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookLinkValidationError";
  }
}

export class BookLinkConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookLinkConflictError";
  }
}

export class BookLinkNotFoundError extends Error {
  constructor(id: string) {
    super(`No book link found with id ${id}.`);
    this.name = "BookLinkNotFoundError";
  }
}

function handleBookLinkError(err: unknown, res: Response): void {
  if (err instanceof BookLinkValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof BookLinkConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof BookLinkNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  console.error("book link request failed:", err);
  res.status(502).json({ error: "Book link request failed." });
}

// Every link this book participates in, either direction: "outgoing"
// (this book IS from_book_id -- e.g. it's a sequel/translation OF
// something) and "incoming" (this book IS to_book_id -- e.g. something
// else is a sequel/translation of it). Exported for the MCP
// list_book_links tool.
export async function listBookLinksForBook(bookId: string): Promise<{ outgoing: BookLinkRow[]; incoming: BookLinkRow[] }> {
  const supabase = getSupabaseClient();
  const [outgoingRes, incomingRes] = await Promise.all([
    supabase.from("book_links").select("*").eq("from_book_id", bookId),
    supabase.from("book_links").select("*").eq("to_book_id", bookId),
  ]);
  if (outgoingRes.error) throw new Error(`Failed to list outgoing book links: ${outgoingRes.error.message}`);
  if (incomingRes.error) throw new Error(`Failed to list incoming book links: ${incomingRes.error.message}`);
  return { outgoing: (outgoingRes.data ?? []) as BookLinkRow[], incoming: (incomingRes.data ?? []) as BookLinkRow[] };
}

export interface CreateBookLinkParams {
  fromBookId: string;
  toBookId: string;
  linkType: string;
  language?: string | null;
}

// Creates a directed relationship between two books. Exported for the MCP
// create_book_link tool, so both write paths validate and fail identically.
export async function createBookLink(params: CreateBookLinkParams): Promise<BookLinkRow> {
  const { fromBookId, toBookId, linkType, language } = params;
  if (!fromBookId || !toBookId || !linkType) {
    throw new BookLinkValidationError("fromBookId, toBookId, and linkType are all required.");
  }
  if (fromBookId === toBookId) {
    throw new BookLinkValidationError("fromBookId and toBookId must be different.");
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("book_links")
    .insert({ from_book_id: fromBookId, to_book_id: toBookId, link_type: linkType, language: language ?? null })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new BookLinkConflictError(
        `This book already has a "${linkType}" link — delete the existing one first if you want to change it.`
      );
    }
    throw new Error(`Failed to create book link: ${error.message}`);
  }
  return data as BookLinkRow;
}

export async function deleteBookLink(id: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("book_links").delete().eq("id", id).select("id").maybeSingle();
  if (error) throw new Error(`Failed to delete book link: ${error.message}`);
  if (!data) throw new BookLinkNotFoundError(id);
}

export interface PendingChapterSummary {
  chapterNumber: number;
  title: string | null;
  heading: string | null;
}

export interface PendingChaptersResult {
  link: BookLinkRow;
  sourceBookId: string;
  targetBookId: string;
  pendingChapters: PendingChapterSummary[];
  sourceBookStatus: string | null;
}

// The core question a daily translation (or any derived-book) session
// needs answered: which chapters have real drafted content in the SOURCE
// book (the link's to_book_id) but no corresponding chapter row yet in
// the DERIVED book (the link's from_book_id)? For a translation_of link,
// this is exactly "what's new to translate since I last checked in." No
// separate "mark as translated" state to maintain -- the presence of a
// chapter row in the derived book (created by save_manuscript_scene, the
// same call that saves the translated text) IS what removes a chapter
// from this list on the next check. "Real content" means the source
// chapter's paragraphs array is non-empty, so an empty placeholder
// chapter never counts as something to translate. Also returns the
// source book's status so a caller knows when it can stop checking in at
// all: once it's "completed" and this list comes back empty, there's
// nothing left to ever come back for.
export async function getPendingChaptersForLink(linkId: string): Promise<PendingChaptersResult> {
  const supabase = getSupabaseClient();
  const { data: link, error: linkErr } = await supabase.from("book_links").select("*").eq("id", linkId).maybeSingle();
  if (linkErr) throw new Error(`Failed to look up book link: ${linkErr.message}`);
  if (!link) throw new BookLinkNotFoundError(linkId);

  const typedLink = link as BookLinkRow;
  const [sourceRes, targetRes, bookRes] = await Promise.all([
    supabase.from("manuscript_chapters").select("number, title, heading, paragraphs").eq("book_id", typedLink.to_book_id),
    supabase.from("manuscript_chapters").select("number").eq("book_id", typedLink.from_book_id),
    supabase.from("books").select("status").eq("id", typedLink.to_book_id).maybeSingle(),
  ]);
  if (sourceRes.error) throw new Error(`Failed to load source chapters: ${sourceRes.error.message}`);
  if (targetRes.error) throw new Error(`Failed to load target chapters: ${targetRes.error.message}`);
  if (bookRes.error) throw new Error(`Failed to load source book: ${bookRes.error.message}`);

  const targetNumbers = new Set((targetRes.data ?? []).map((c) => c.number as number));
  const pendingChapters: PendingChapterSummary[] = (sourceRes.data ?? [])
    .filter((c) => Array.isArray(c.paragraphs) && c.paragraphs.length > 0 && !targetNumbers.has(c.number as number))
    .map((c) => ({
      chapterNumber: c.number as number,
      title: (c.title as string | null) ?? null,
      heading: (c.heading as string | null) ?? null,
    }))
    .sort((a, b) => a.chapterNumber - b.chapterNumber);

  return {
    link: typedLink,
    sourceBookId: typedLink.to_book_id,
    targetBookId: typedLink.from_book_id,
    pendingChapters,
    sourceBookStatus: (bookRes.data?.status as string | null) ?? null,
  };
}

// --- Express routes (thin wrappers around the exported functions above) ---

// GET /api/v1/book-links?bookId=
bookLinksRouter.get("/book-links", async (req: Request, res: Response) => {
  const bookId = req.query.bookId;
  if (typeof bookId !== "string" || bookId.trim() === "") {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }
  try {
    const result = await listBookLinksForBook(bookId);
    res.json(result);
  } catch (err) {
    handleBookLinkError(err, res);
  }
});

// POST /api/v1/book-links
// { fromBookId, toBookId, linkType, language? }
bookLinksRouter.post("/book-links", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.fromBookId !== "string" || typeof body.toBookId !== "string" || typeof body.linkType !== "string") {
    res.status(400).json({ error: "fromBookId, toBookId, and linkType are all required strings." });
    return;
  }
  if (body.language !== undefined && body.language !== null && typeof body.language !== "string") {
    res.status(400).json({ error: "language must be a string." });
    return;
  }
  try {
    const link = await createBookLink({
      fromBookId: body.fromBookId,
      toBookId: body.toBookId,
      linkType: body.linkType,
      language: (body.language as string | null | undefined) ?? null,
    });
    res.status(201).json({ link });
  } catch (err) {
    handleBookLinkError(err, res);
  }
});

// DELETE /api/v1/book-links/:id
bookLinksRouter.delete("/book-links/:id", async (req: Request, res: Response) => {
  try {
    await deleteBookLink(req.params.id as string);
    res.status(204).send();
  } catch (err) {
    handleBookLinkError(err, res);
  }
});

// GET /api/v1/book-links/:id/pending-chapters
bookLinksRouter.get("/book-links/:id/pending-chapters", async (req: Request, res: Response) => {
  try {
    const result = await getPendingChaptersForLink(req.params.id as string);
    res.json(result);
  } catch (err) {
    handleBookLinkError(err, res);
  }
});
