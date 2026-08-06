import { Router, type Request, type Response } from "express";
import { assembleContextPayload } from "../services/rag.js";
import { streamHanamiProse, generateHanamiProse } from "../services/llm.js";
import { estimateTokens } from "../lib/tokenBudget.js";

export const generateProseRouter = Router();

interface GenerateProseBody {
  userId: string;
  bookId: string;
  userSceneBeat: string;
  recentHistoryText?: string;
  // Fresh, per-generation instructions for the chapter about to be
  // written — not saved anywhere, entered on this call only. See
  // buildChapterInstructionsSection in rag.ts for how these get priority
  // over Codex/History/RAG in the compiled context.
  chapterInstructions?: string;
  chapterAvoid?: string;
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
  if (body.chapterInstructions !== undefined && typeof body.chapterInstructions !== "string") {
    return "chapterInstructions must be a string when provided.";
  }
  if (body.chapterAvoid !== undefined && typeof body.chapterAvoid !== "string") {
    return "chapterAvoid must be a string when provided.";
  }
  return null;
}

const SYSTEM_PROMPT_INSTRUCTIONS = [
  "You are Hanami, a creative fiction-writing engine continuing a novel in progress.",
  "Use the compiled context below — Codex entries, recent story history, and relevant deep-past manuscript memory — to keep characters, tone, and continuity consistent.",
  "Do not restate or summarize this context in your response. Write only the continuation prose for the upcoming scene beat.",
].join("\n");

export function buildSystemPrompt(contextPayload: string): string {
  const context = contextPayload || "No prior codex, history, or manuscript memory is available yet.";
  return [SYSTEM_PROMPT_INSTRUCTIONS, "", context].join("\n");
}

// The MUST NOT list also appears once already, at the top of the compiled
// context (buildChapterInstructionsSection in rag.ts). Restating it here,
// immediately before the scene beat Hanami is about to continue from, is
// deliberate: instructions closest to the point of generation get weighted
// more heavily than the same instruction stated once earlier in a long
// prompt, and that matters most for a negative constraint, since nothing
// later in generation naturally reinforces "don't."
export function buildUserMessage(userSceneBeat: string, chapterAvoid?: string): string {
  const avoid = chapterAvoid?.trim();
  if (!avoid) return userSceneBeat;
  return [`Reminder before you write — do NOT: ${avoid}`, "", userSceneBeat].join("\n");
}

// The fixed instructional scaffolding's token cost, reserved up front so
// assembleContextPayload's dynamic Layer 3 budget accounts for it — without
// this, Layer 3 could fill the payload right up to the 4,000/4,100 cap and
// the scaffolding wrapped around it would push the real system prompt over.
const RESERVED_SCAFFOLDING_TOKENS = estimateTokens(`${SYSTEM_PROMPT_INSTRUCTIONS}\n\n`);

// Runs the same Layer 1/2/3 context assembly as /generate-prose but returns
// the compiled payload as JSON instead of invoking Hanami — lets the test
// UI (and other callers) inspect exactly what would be sent as the system
// prompt, and confirm it stays under the 4,000-token budget from CLAUDE.md.
generateProseRouter.post("/generate-prose/preview", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const validationError = validateGenerateProseBody(body);

  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { userId, bookId, userSceneBeat, recentHistoryText, chapterInstructions, chapterAvoid } =
    body as unknown as GenerateProseBody;

  try {
    const { payload, layer3Candidates, expandedChapters, estimatedTotalTokens } = await assembleContextPayload({
      userId,
      bookId,
      userSceneBeat,
      recentHistoryText: recentHistoryText ?? "",
      chapterInstructions: chapterInstructions ?? "",
      chapterAvoid: chapterAvoid ?? "",
      reservedTokens: RESERVED_SCAFFOLDING_TOKENS,
    });
    const systemPrompt = buildSystemPrompt(payload);
    const userMessage = buildUserMessage(userSceneBeat, chapterAvoid);

    res.json({
      contextPayload: payload,
      systemPrompt,
      userMessage,
      estimatedTokens: estimateTokens(systemPrompt),
      estimatedTotalTokens,
      layer3Candidates,
      expandedChapters,
    });
  } catch (error) {
    console.error("generate-prose preview failed:", error);
    res.status(502).json({ error: "Failed to compile context. Please try again." });
  }
});

generateProseRouter.post("/generate-prose", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const validationError = validateGenerateProseBody(body);

  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { userId, bookId, userSceneBeat, recentHistoryText, chapterInstructions, chapterAvoid } =
    body as unknown as GenerateProseBody;

  try {
    const { payload } = await assembleContextPayload({
      userId,
      bookId,
      userSceneBeat,
      recentHistoryText: recentHistoryText ?? "",
      chapterInstructions: chapterInstructions ?? "",
      chapterAvoid: chapterAvoid ?? "",
      reservedTokens: RESERVED_SCAFFOLDING_TOKENS,
    });

    const systemPrompt = buildSystemPrompt(payload);
    const userMessage = buildUserMessage(userSceneBeat, chapterAvoid);
    await streamHanamiProse(systemPrompt, userMessage, res);
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

interface DirectGenerateBody {
  userSceneBeat: string;
  compiledContext: string;
}

function validateDirectGenerateBody(body: Record<string, unknown>): string | null {
  if (typeof body.userSceneBeat !== "string" || body.userSceneBeat.trim() === "") {
    return "userSceneBeat is required and must be a non-empty string.";
  }
  if (typeof body.compiledContext !== "string" || body.compiledContext.trim() === "") {
    return "compiledContext is required and must be a non-empty string.";
  }
  return null;
}

// Bypasses Layer 1/2/3 assembly entirely: the caller (an MCP client like
// Claude, which can hold and reason over far more manuscript/Codex
// context than the automatic pipeline's fixed 4,000-token budget allows)
// supplies the fully-compiled context directly, and this just runs it
// straight to Hanami. No userId/bookId needed — this endpoint never
// touches Supabase at all, purely a Hanami passthrough. Returns the
// complete prose as JSON rather than streaming, since the primary caller
// (an MCP tool result) isn't a live browser connection.
generateProseRouter.post("/generate-prose/direct", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const validationError = validateDirectGenerateBody(body);

  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { userSceneBeat, compiledContext } = body as unknown as DirectGenerateBody;

  try {
    const systemPrompt = buildSystemPrompt(compiledContext);
    const prose = await generateHanamiProse(systemPrompt, userSceneBeat);
    res.json({ prose });
  } catch (error) {
    console.error("generate-prose/direct failed:", error);
    res.status(502).json({ error: "Failed to generate prose. Please try again." });
  }
});
