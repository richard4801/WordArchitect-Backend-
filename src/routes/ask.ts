import { Router, type Request, type Response } from "express";
import { assembleContextPayload } from "../services/rag.js";
import { generateHanamiProse } from "../services/llm.js";
import { estimateTokens } from "../lib/tokenBudget.js";
import { getBookFacts, formatBookFactsSection } from "../services/bookFacts.js";

export const askRouter = Router();

interface AskBody {
  userId: string;
  bookId: string;
  question: string;
}

function validateAskBody(body: Record<string, unknown>): string | null {
  if (typeof body.userId !== "string" || body.userId.trim() === "") {
    return "userId is required and must be a non-empty string.";
  }
  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    return "bookId is required and must be a non-empty string.";
  }
  if (typeof body.question !== "string" || body.question.trim() === "") {
    return "question is required and must be a non-empty string.";
  }
  return null;
}

// Deliberately stricter than generateProse's creative-continuation framing:
// this route exists to diagnose retrieval accuracy, so a wrong-but-confident
// answer is worse than an honest "not found" — it would mask a Layer 1/3 gap
// instead of surfacing it.
const ASK_SYSTEM_INSTRUCTIONS = [
  "You are a precise story-continuity assistant answering a question about a novel in progress.",
  "Answer using ONLY the compiled context below — Book Facts, Codex entries, and manuscript memory. Do not invent or infer details that are not explicitly present in it.",
  "Book Facts are exact, computed facts about the manuscript's structure (e.g. the highest chapter number written). If the question is about the manuscript's structure or progress, prefer Book Facts over inferring from Codex/manuscript memory.",
  "Be as specific as the context allows (names, numbers, exact wording) rather than vague or general.",
  "If the exact answer isn't present, share the closest relevant detail that is, and say plainly what's missing — do not just refuse.",
  "Only say the context has nothing relevant if it truly doesn't touch the question at all.",
  "Keep the answer short — a few sentences, not prose continuation.",
].join("\n");

function buildAskSystemPrompt(contextPayload: string): string {
  const context = contextPayload || "No prior codex, history, or manuscript memory is available yet.";
  return [ASK_SYSTEM_INSTRUCTIONS, "", context].join("\n");
}

const RESERVED_SCAFFOLDING_TOKENS = estimateTokens(`${ASK_SYSTEM_INSTRUCTIONS}\n\n`);

// Hanami's default temperature (0.85) is tuned for creative prose variation,
// which works against strict "answer only from context, say so if you can't"
// instruction-following. A low temperature here favors precise adherence to
// the compiled context over creative embellishment.
const ASK_TEMPERATURE = 0.2;

// Reuses the same Layer 1/2/3 retrieval engine /generate-prose relies on,
// but asks a direct factual question instead of continuing the story — a
// diagnostic for whether the automatic pipeline actually retrieves the
// right, specific context, rather than good prose quality masking a
// retrieval gap. Layer 2 (Recent History) is skipped by passing an empty
// recentHistoryText: a question has no cursor position, so there's nothing
// for that layer to slice, and the budget it would have used flows to
// Layer 1/3 instead.
askRouter.post("/ask", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const validationError = validateAskBody(body);

  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { userId, bookId, question } = body as unknown as AskBody;

  try {
    const bookFacts = await getBookFacts(bookId);
    const bookFactsSection = formatBookFactsSection(bookFacts);
    const bookFactsTokens = estimateTokens(bookFactsSection) + estimateTokens("\n\n---\n\n");

    const { payload, layer3Candidates, expandedChapters, estimatedTotalTokens } = await assembleContextPayload({
      userId,
      bookId,
      userSceneBeat: question,
      recentHistoryText: "",
      reservedTokens: RESERVED_SCAFFOLDING_TOKENS + bookFactsTokens,
    });

    const fullContext = [bookFactsSection, payload].filter(Boolean).join("\n\n---\n\n");
    const systemPrompt = buildAskSystemPrompt(fullContext);
    const answer = await generateHanamiProse(systemPrompt, question, ASK_TEMPERATURE);

    res.json({
      answer,
      contextPayload: fullContext,
      estimatedTotalTokens: estimatedTotalTokens + bookFactsTokens,
      layer3Candidates,
      expandedChapters,
    });
  } catch (error) {
    console.error("ask failed:", error);
    res.status(502).json({ error: "Failed to answer question. Please try again." });
  }
});
