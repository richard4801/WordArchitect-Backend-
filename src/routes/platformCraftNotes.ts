import { Router, type Request, type Response } from "express";
import {
  getPlatformCraftNotes,
  savePlatformCraftNotes,
  startPlatformResearchJob,
  discardPlatformResearchDraft,
  cancelPlatformResearchJob,
} from "../services/platformCraftNotes.js";

export const platformCraftNotesRouter = Router();

const EMPTY_NOTES = (bookId: string) => ({
  bookId,
  content: "",
  updatedAt: null,
  draftStatus: "idle" as const,
  draftContent: null,
  draftError: null,
  draftUpdatedAt: null,
});

// GET /api/v1/platform-craft-notes?bookId= — the current saved notes for a
// book, or an empty stub if none have been saved yet (a book with no
// notes yet isn't an error — the Contract Pipeline works fine with
// {{PLATFORM_TRENDS}} empty, just without this extra grounding). Also
// carries draftStatus/draftContent/draftError — poll THIS endpoint (same
// pattern as polling a Planning Engine run) to watch a research pass
// started via POST .../research below progress from "running" to
// "ready"/"failed", independent of whether the tab that started it is
// still open.
platformCraftNotesRouter.get("/platform-craft-notes", async (req: Request, res: Response) => {
  const bookId = req.query.bookId;
  if (typeof bookId !== "string" || bookId.trim() === "") {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }

  try {
    const notes = await getPlatformCraftNotes(bookId);
    res.json({ notes: notes ?? EMPTY_NOTES(bookId) });
  } catch (error) {
    console.error("get platform craft notes failed:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Failed to load platform craft notes." });
  }
});

// PATCH /api/v1/platform-craft-notes — { bookId, content } — the only way
// these notes actually get saved. Whether content came from the writer
// typing directly or from editing a research draft, this call is
// identical either way. Also clears any pending draft state back to
// "idle" — see savePlatformCraftNotes.
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

// POST /api/v1/platform-craft-notes/research — { bookId, force? } — starts
// an on-demand research pass (Claude + web_search/web_fetch) as a
// detached background job and returns immediately with draft_status
// "running". The actual call is NOT awaited by this request — it keeps
// running server-side after this response is sent, unaffected by the
// writer closing the tab or navigating away, since it's an independent
// connection to Anthropic with no tie to this request's socket. Poll
// GET /platform-craft-notes above to see it land. Refuses to start a
// second job while one is already running for this book (returns the
// existing in-flight state instead) rather than double-billing an
// impatient double-click. Also refuses (409) to overwrite an unsaved
// "ready" draft already waiting for review unless force: true is passed
// — starting a new pass would otherwise silently discard it. Deliberately
// not automatic/scheduled — this is a real, billed LLM call the writer
// triggers themselves every time.
platformCraftNotesRouter.post("/platform-craft-notes/research", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }

  try {
    const notes = await startPlatformResearchJob(body.bookId, body.force === true);
    res.status(202).json({ notes });
  } catch (error) {
    console.error("start platform research job failed:", error);
    const message = error instanceof Error ? error.message : "Failed to start platform craft notes research.";
    res.status(message.includes("unsaved research draft") ? 409 : 502).json({ error: message });
  }
});

// POST /api/v1/platform-craft-notes/research/cancel — { bookId } — stops
// an in-flight research pass and resets draft_status back to "idle".
// Only actually aborts the in-flight call if this same server process is
// still the one running it (see activeResearchJobs in
// platformCraftNotes.ts — in-memory, single-process only, same
// limitation this project already accepts for the MCP session map); if
// not found, this still resets the stored state so the writer isn't
// stuck looking at a permanently "running" job either way.
platformCraftNotesRouter.post("/platform-craft-notes/research/cancel", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }

  try {
    const notes = await cancelPlatformResearchJob(body.bookId);
    res.json({ notes });
  } catch (error) {
    console.error("cancel platform research job failed:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Failed to cancel platform craft notes research." });
  }
});

// POST /api/v1/platform-craft-notes/research/discard — { bookId } —
// discards a "ready" or "failed" draft without saving it, resetting to
// "idle". Leaves the last actually-saved `content` untouched.
platformCraftNotesRouter.post("/platform-craft-notes/research/discard", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }

  try {
    const notes = await discardPlatformResearchDraft(body.bookId);
    res.json({ notes });
  } catch (error) {
    console.error("discard platform research draft failed:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Failed to discard platform research draft." });
  }
});
