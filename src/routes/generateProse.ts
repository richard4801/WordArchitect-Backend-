import { Router, type Request, type Response } from "express";
import { assembleContextPayload } from "../services/rag.js";
import { streamHanamiProse, generateHanamiProse } from "../services/llm.js";
import { estimateTokens } from "../lib/tokenBudget.js";
import { markBracketedInstructions } from "../lib/bracketInstructions.js";
import { listBannedTerms } from "../services/bannedTerms.js";
import { enforceBannedTerms } from "../services/ghostEditor.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";

export const generateProseRouter = Router();

interface GenerateProseBody {
  userId: string;
  bookId: string;
  // Either userSceneBeat or beatId is required — see resolveUserSceneBeat.
  userSceneBeat?: string;
  // An Outliner beat (chapter_beats.id) whose outline_text is used as the
  // scene beat instead of a freehand userSceneBeat — the beat card the
  // writer already filled in becomes the generation input.
  beatId?: string;
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
  if (body.userSceneBeat !== undefined && typeof body.userSceneBeat !== "string") {
    return "userSceneBeat must be a string when provided.";
  }
  if (body.beatId !== undefined && typeof body.beatId !== "string") {
    return "beatId must be a string when provided.";
  }
  const hasSceneBeat = typeof body.userSceneBeat === "string" && body.userSceneBeat.trim() !== "";
  const hasBeatId = typeof body.beatId === "string" && body.beatId.trim() !== "";
  if (!hasSceneBeat && !hasBeatId) {
    return "Either userSceneBeat or beatId is required.";
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

// When beatId is supplied instead of (or alongside) a freehand
// userSceneBeat, an explicit userSceneBeat still wins — beatId is the
// fallback source, not an override, so a writer can paste a one-off tweak
// without editing the saved beat. Pulls chapter_beats.outline_text, the
// Outliner card the writer already filled in, instead of requiring it to
// be retyped/pasted into the generation form every time.
async function resolveUserSceneBeat(body: GenerateProseBody): Promise<{ text: string } | { error: string }> {
  if (body.userSceneBeat && body.userSceneBeat.trim() !== "") {
    return { text: body.userSceneBeat };
  }
  if (!body.beatId) {
    return { error: "Either userSceneBeat or beatId is required." };
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("chapter_beats")
    .select("outline_text")
    .eq("id", body.beatId)
    .maybeSingle();

  if (error) {
    return { error: "Failed to load the beat's outline text." };
  }
  if (!data) {
    return { error: `No beat found with id ${body.beatId}.` };
  }
  if (!data.outline_text || data.outline_text.trim() === "") {
    return { error: "This beat has no outline text yet — add one before generating." };
  }
  return { text: data.outline_text };
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
//
// Bracketed (parenthetical) notes inside the beat itself are rewritten
// into explicit [INSTRUCTION: ...] tags by markBracketedInstructions —
// deliberately kept out of the compiled context (assembleContextPayload)
// entirely, since the point is to put them directly in the one message
// Hanami is actually writing from, not have them compete for attention
// with Codex/History/RAG further up the prompt.
export function buildUserMessage(userSceneBeat: string, chapterAvoid?: string): string {
  const { text: beatWithDirectives, instructionCount } = markBracketedInstructions(userSceneBeat);
  const parts: string[] = [];

  const avoid = chapterAvoid?.trim();
  if (avoid) {
    parts.push(`Reminder before you write — do NOT: ${avoid}`, "");
  }
  if (instructionCount > 0) {
    parts.push(
      "The scene beat below contains <<DIRECTIVE: ...>> tags at specific points. Each is an instruction for exactly that moment in the scene — follow it silently. Never write the tag's text, punctuation, or brackets into your response, and never invent or add a <<DIRECTIVE: ...>> tag of your own anywhere in your output.",
      ""
    );
  }
  parts.push(beatWithDirectives);

  return parts.join("\n");
}

// The fixed instructional scaffolding's token cost, reserved up front so
// assembleContextPayload's dynamic Layer 3 budget accounts for it — without
// this, Layer 3 could fill the payload right up to the 6,000/6,100 cap and
// the scaffolding wrapped around it would push the real system prompt over.
const RESERVED_SCAFFOLDING_TOKENS = estimateTokens(`${SYSTEM_PROMPT_INSTRUCTIONS}\n\n`);

// Runs the same Layer 1/2/3 context assembly as /generate-prose but returns
// the compiled payload as JSON instead of invoking Hanami — lets the test
// UI (and other callers) inspect exactly what would be sent as the system
// prompt, and confirm it stays under the 6,000-token budget from CLAUDE.md.
generateProseRouter.post("/generate-prose/preview", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const validationError = validateGenerateProseBody(body);

  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { userId, bookId, recentHistoryText, chapterInstructions, chapterAvoid } =
    body as unknown as GenerateProseBody;

  const resolvedBeat = await resolveUserSceneBeat(body as unknown as GenerateProseBody);
  if ("error" in resolvedBeat) {
    res.status(400).json({ error: resolvedBeat.error });
    return;
  }
  const userSceneBeat = resolvedBeat.text;

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

// Precedes a trailing JSON blob the test UI strips out of the raw prose
// stream and renders separately — see the Ghost Editor block below for why
// this only ever gets appended when a book actually has banned terms
// configured, and never touches the response for anyone who doesn't use
// the feature.
export const GHOST_EDITOR_REPORT_MARKER = "\n\n<<<GHOST_EDITOR_REPORT>>>";

generateProseRouter.post("/generate-prose", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const validationError = validateGenerateProseBody(body);

  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { userId, bookId, recentHistoryText, chapterInstructions, chapterAvoid } =
    body as unknown as GenerateProseBody;

  const resolvedBeat = await resolveUserSceneBeat(body as unknown as GenerateProseBody);
  if ("error" in resolvedBeat) {
    res.status(400).json({ error: resolvedBeat.error });
    return;
  }
  const userSceneBeat = resolvedBeat.text;

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

    const bannedTerms = await listBannedTerms(bookId);

    if (bannedTerms.length === 0) {
      // No banned terms configured for this book — identical to the
      // original behavior, live token-by-token streaming, zero added cost.
      await streamHanamiProse(systemPrompt, userMessage, res);
      return;
    }

    // Banned terms exist: there is no generation-time way to guarantee a
    // banned word/phrase never appears (confirmed — logit_bias isn't
    // honored by the Infermatic API, and wouldn't safely suppress whole
    // words even if it were, since most words are multiple subword tokens
    // sharing pieces with unrelated vocabulary). The only mechanism that
    // actually works is detect-then-regenerate, which means the full
    // generation has to be buffered and checked before anything is shown
    // — this trades live streaming for a guarantee the writer never sees
    // a banned term land on screen, only for books that opted into it.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const rawProse = await generateHanamiProse(systemPrompt, userMessage);
    const { finalText, corrections } = await enforceBannedTerms({
      text: rawProse,
      bannedTerms: bannedTerms.map((t) => t.term),
      systemPrompt,
    });

    res.write(finalText);
    if (corrections.length > 0) {
      res.write(GHOST_EDITOR_REPORT_MARKER + JSON.stringify(corrections));
    }
    res.end();
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
// context than the automatic pipeline's fixed 6,000-token budget allows)
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
