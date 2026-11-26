import { Router, type Request, type Response } from "express";
import { runSkillReview, getSkillReview, listSkillReviews } from "../services/skillReview.js";
import type { ReviewTargetType } from "../skills/types.js";

// Skill reviews over HTTP — the same runSkillReview the MCP run_skill_review
// tool calls. See CLAUDE.md "Skill Reviews".
export const skillReviewsRouter = Router();

const PROSE_TARGETS: ReviewTargetType[] = ["prose_fragment", "prose_scene", "prose_chapter"];

// POST /api/v1/skill-reviews — { userId, bookId, text, targetType, chapterNumber?, sceneDraftSessionId? }
skillReviewsRouter.post("/skill-reviews", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const bookId = typeof body.bookId === "string" ? body.bookId.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";
  const targetType = body.targetType as ReviewTargetType;
  const chapterNumber = typeof body.chapterNumber === "number" && Number.isInteger(body.chapterNumber) ? body.chapterNumber : null;
  const sceneDraftSessionId = typeof body.sceneDraftSessionId === "string" ? body.sceneDraftSessionId : null;

  if (!userId || !bookId) {
    res.status(400).json({ error: "userId and bookId are required." });
    return;
  }
  if (!text.trim()) {
    res.status(400).json({ error: "text is required and must be non-empty." });
    return;
  }
  if (!PROSE_TARGETS.includes(targetType)) {
    res.status(400).json({ error: `targetType must be one of ${PROSE_TARGETS.join(", ")}.` });
    return;
  }

  try {
    const review = await runSkillReview({ userId, bookId, text, targetType, chapterNumber, sceneDraftSessionId });
    res.status(201).json({ review });
  } catch (error) {
    console.error("skill review failed:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Skill review failed." });
  }
});

// GET /api/v1/skill-reviews?bookId=&chapterNumber=&planningRunId=
skillReviewsRouter.get("/skill-reviews", async (req: Request, res: Response) => {
  const bookId = typeof req.query.bookId === "string" ? req.query.bookId.trim() : "";
  if (!bookId) {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }
  const chapterRaw = typeof req.query.chapterNumber === "string" ? Number(req.query.chapterNumber) : undefined;
  const planningRunId = typeof req.query.planningRunId === "string" ? req.query.planningRunId : undefined;
  try {
    const reviews = await listSkillReviews({
      bookId,
      ...(chapterRaw !== undefined && Number.isInteger(chapterRaw) ? { chapterNumber: chapterRaw } : {}),
      ...(planningRunId ? { planningRunId } : {}),
    });
    res.json({ reviews });
  } catch (error) {
    console.error("list skill reviews failed:", error);
    res.status(502).json({ error: "Failed to list skill reviews." });
  }
});

// GET /api/v1/skill-reviews/:id
skillReviewsRouter.get("/skill-reviews/:id", async (req: Request, res: Response) => {
  try {
    const review = await getSkillReview(String(req.params.id));
    res.json({ review });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.startsWith("No skill review found") ? 404 : 502).json({ error: message });
  }
});
