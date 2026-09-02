import { Router, type Request, type Response } from "express";
import { getPlatformCraftNotes, savePlatformCraftNotes, researchPlatformCraftNotes } from "../services/platformCraftNotes.js";

export const platformCraftNotesRouter = Router();

// GET /api/v1/platform-craft-notes?bookId= — the current saved notes for a
// book, or an empty stub if none have been saved yet (a book with no
// notes yet isn't an error — the Contract Pipeline works fine with
// {{PLATFORM_TRENDS}} empty, just without this extra grounding).
platformCraftNotesRouter.get("/platform-craft-notes", async (req: Request, res: Response) => {
  const bookId = req.query.bookId;
  if (typeof bookId !== "string" || bookId.trim() === "") {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }

  try {
    const notes = await getPlatformCraftNotes(bookId);
    res.json({ notes: notes ?? { bookId, content: "", updatedAt: null } });
  } catch (error) {
    console.error("get platform craft notes failed:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Failed to load platform craft notes." });
  }
});

// PATCH /api/v1/platform-craft-notes — { bookId, content } — the only way
// these notes actually get saved. Whether content came from the writer
// typing directly or from editing a research draft, this call is
// identical either way; the research step below never writes here itself.
platformCraftNotesRouter.patch("/platform-craft-notes", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }
  if (typeof body.content !== "string") {
    res.status(400).json({ error: "content is required and must be a string." });
    return;
  }

  try {
    const notes = await savePlatformCraftNotes(body.bookId, body.content);
    res.json({ notes });
  } catch (error) {
    console.error("save platform craft notes failed:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Failed to save platform craft notes." });
  }
});

// POST /api/v1/platform-craft-notes/research — { bookId } — an on-demand
// research pass (Claude + web_search/web_fetch) that returns a DRAFT only.
// Nothing is saved here — the writer reviews/edits the draft, then calls
// PATCH above to actually commit it. Deliberately not automatic/scheduled;
// this is a real, billed LLM call the writer triggers themselves.
platformCraftNotesRouter.post("/platform-craft-notes/research", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }

  try {
    const draft = await researchPlatformCraftNotes(body.bookId);
    res.json({ draft });
  } catch (error) {
    console.error("research platform craft notes failed:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Failed to research platform craft notes." });
  }
});
