import { Router, type Request, type Response } from "express";
import { listBannedTerms, addBannedTerm, removeBannedTerm } from "../services/bannedTerms.js";

export const bannedTermsRouter = Router();

bannedTermsRouter.get("/banned-terms", async (req: Request, res: Response) => {
  const bookId = typeof req.query.bookId === "string" ? req.query.bookId.trim() : "";
  if (!bookId) {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }

  try {
    const terms = await listBannedTerms(bookId);
    res.json({ terms });
  } catch (error) {
    console.error("list banned terms failed:", error);
    res.status(502).json({ error: "Failed to load banned terms. Please try again." });
  }
});

bannedTermsRouter.post("/banned-terms", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const bookId = typeof body.bookId === "string" ? body.bookId.trim() : "";
  const term = typeof body.term === "string" ? body.term : "";

  if (!userId) {
    res.status(400).json({ error: "userId is required and must be a non-empty string." });
    return;
  }
  if (!bookId) {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }
  if (!term.trim()) {
    res.status(400).json({ error: "term is required and must be a non-empty string." });
    return;
  }

  try {
    const created = await addBannedTerm({ userId, bookId, term });
    res.status(201).json(created);
  } catch (error) {
    console.error("add banned term failed:", error);
    res.status(502).json({ error: "Failed to add banned term. Please try again." });
  }
});

bannedTermsRouter.delete("/banned-terms/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "id path parameter is required." });
    return;
  }

  try {
    await removeBannedTerm(id);
    res.status(204).send();
  } catch (error) {
    console.error("remove banned term failed:", error);
    res.status(502).json({ error: "Failed to remove banned term. Please try again." });
  }
});
