import { Router, type Request, type Response } from "express";
import { assembleContextPayload } from "../services/rag.js";
import { streamHanamiProse } from "../services/llm.js";

export const generateProseRouter = Router();

interface GenerateProseBody {
  userId: string;
  bookId: string;
  userSceneBeat: string;
  recentHistoryText?: string;
}

function validateGenerateProseBody(body: Record<string, unknown>): string | null {
  if (typeof body.userId !== "string" || body.userId.trim() === "") {
    return "userId is required and must be a non-empty string.";
  }
  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    return "bookId is required and must be a non-empty string.";
  }
  if (typeof body.userSceneBeat !== "string" || body.userSceneBeat.trim() === "") {
    return "userSceneBeat is required and must be a non-empty string.";
  }
  if (body.recentHistoryText !== undefined && typeof body.recentHistoryText !== "string") {
    return "recentHistoryText must be a string when provided.";
  }
  return null;
}

function buildSystemPrompt(contextPayload: string): string {
  const context = contextPayload || "No prior codex, history, or manuscript memory is available yet.";
  return [
    "You are Hanami, a creative fiction-writing engine continuing a novel in progress.",
    "Use the compiled context below — Codex entries, recent story history, and relevant deep-past manuscript memory — to keep characters, tone, and continuity consistent.",
    "Do not restate or summarize this context in your response. Write only the continuation prose for the upcoming scene beat.",
    "",
    context,
  ].join("\n");
}

generateProseRouter.post("/generate-prose", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const validationError = validateGenerateProseBody(body);

  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { userId, bookId, userSceneBeat, recentHistoryText } = body as unknown as GenerateProseBody;

  try {
    const contextPayload = await assembleContextPayload({
      userId,
      bookId,
      userSceneBeat,
      recentHistoryText: recentHistoryText ?? "",
    });

    const systemPrompt = buildSystemPrompt(contextPayload);
    await streamHanamiProse(systemPrompt, userSceneBeat, res);
  } catch (error) {
    console.error("generate-prose failed:", error);

    if (!res.headersSent) {
      res.status(502).json({ error: "Failed to generate prose. Please try again." });
      return;
    }
    if (!res.writableEnded) {
      res.end();
    }
  }
});
