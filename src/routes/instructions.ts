import { Router, type Request, type Response } from "express";
import { getBookInstructions, saveBookInstructions } from "../services/bookInstructions.js";

export const instructionsRouter = Router();

instructionsRouter.get("/instructions", async (req: Request, res: Response) => {
  const bookId = typeof req.query.bookId === "string" ? req.query.bookId.trim() : "";
  if (!bookId) {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }

  try {
    const instructions = await getBookInstructions(bookId);
    res.json({ instructions });
  } catch (error) {
    console.error("get instructions failed:", error);
    res.status(502).json({ error: "Failed to load writing instructions. Please try again." });
  }
});

instructionsRouter.put("/instructions", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const bookId = typeof body.bookId === "string" ? body.bookId.trim() : "";
  if (!bookId) {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }
  if (typeof body.instructions !== "string") {
    res.status(400).json({ error: "instructions is required and must be a string." });
    return;
  }

  try {
    const instructions = await saveBookInstructions(bookId, body.instructions);
    res.json({ instructions });
  } catch (error) {
    console.error("save instructions failed:", error);
    res.status(502).json({ error: "Failed to save writing instructions. Please try again." });
  }
});
