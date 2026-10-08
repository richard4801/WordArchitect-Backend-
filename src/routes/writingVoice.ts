import { Router, type Request, type Response } from "express";
import {
  getWritingVoiceProfile,
  saveWritingVoiceSample,
  reextractWritingVoiceProfile,
  deleteWritingVoiceProfile,
} from "../services/writingVoice.js";

export const writingVoiceRouter = Router();

// GET /api/v1/writing-voice?userId=
writingVoiceRouter.get("/writing-voice", async (req: Request, res: Response) => {
  const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
  if (!userId) {
    res.status(400).json({ error: "userId query parameter is required." });
    return;
  }

  try {
    const profile = await getWritingVoiceProfile(userId);
    res.json({ profile });
  } catch (error) {
    console.error("get writing voice profile failed:", error);
    res.status(502).json({ error: "Failed to load writing voice profile. Please try again." });
  }
});

// POST /api/v1/writing-voice — { userId, sampleText }. Saves the sample and
// (re)derives the style profile from it in the same call.
writingVoiceRouter.post("/writing-voice", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const sampleText = typeof body.sampleText === "string" ? body.sampleText : "";

  if (!userId) {
    res.status(400).json({ error: "userId is required and must be a non-empty string." });
    return;
  }
  if (!sampleText.trim()) {
    res.status(400).json({ error: "sampleText is required and must be a non-empty string." });
    return;
  }

  try {
    const result = await saveWritingVoiceSample(userId, sampleText);
    res.status(201).json(result);
  } catch (error) {
    console.error("save writing voice sample failed:", error);
    res.status(502).json({ error: "Failed to save writing voice sample. Please try again." });
  }
});

// POST /api/v1/writing-voice/extract — { userId }. Re-runs style extraction
// against the already-saved sample, no re-paste required — the retry path
// for a failed extraction, or just to refresh.
writingVoiceRouter.post("/writing-voice/extract", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!userId) {
    res.status(400).json({ error: "userId is required and must be a non-empty string." });
    return;
  }

  try {
    const profile = await reextractWritingVoiceProfile(userId);
    res.json({ profile });
  } catch (error) {
    console.error("re-extract writing voice profile failed:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Failed to re-extract writing voice profile." });
  }
});

// DELETE /api/v1/writing-voice?userId= — clears the sample and profile
// entirely. Hanami falls back to its default voice on this writer's next
// generation.
writingVoiceRouter.delete("/writing-voice", async (req: Request, res: Response) => {
  const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
  if (!userId) {
    res.status(400).json({ error: "userId query parameter is required." });
    return;
  }

  try {
    await deleteWritingVoiceProfile(userId);
    res.status(204).send();
  } catch (error) {
    console.error("delete writing voice profile failed:", error);
    res.status(502).json({ error: "Failed to delete writing voice profile. Please try again." });
  }
});
