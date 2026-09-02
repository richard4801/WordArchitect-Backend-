import { Router, type Request, type Response } from "express";
import {
  createPlanningRun,
  getPlanningRun,
  listPlanningRuns,
  deletePlanningRun,
  generateStage,
  runCritique,
  runArbitration,
  approveStage,
  rejectStage,
  unapproveStage,
  discardStage,
  chatTurn,
  finalizeDirective,
  extractEntities,
  confirmEntities,
  intakeChatTurn,
  finalizeIntake,
  promoteContractRunToFull,
} from "../services/planningEngine.js";
import { VALID_PIPELINE_TYPES, type PipelineType } from "../types/domain.js";

export const planningRouter = Router();

function handleError(res: Response, error: unknown, context: string) {
  console.error(`${context} failed:`, error);
  res.status(502).json({ error: error instanceof Error ? error.message : `Failed to ${context}.` });
}

// POST /api/v1/planning/runs — starts a new planning run in the intake
// conversation (status: intake_active) — NOT Stage 1 generation yet. The
// writer talks to the Arbitrator via intake-chat below until they're
// ready to call intake-finalize, which is what actually opens Stage 1.
// Optional pipelineType: "full" (default) or "contract" — see
// PipelineType in src/types/domain.ts. Both share this exact same intake
// flow; they only diverge after Stage 1 is approved.
planningRouter.post("/planning/runs", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }
  if (typeof body.userId !== "string" || body.userId.trim() === "") {
    res.status(400).json({ error: "userId is required and must be a non-empty string." });
    return;
  }
  if (body.pipelineType !== undefined && !VALID_PIPELINE_TYPES.includes(body.pipelineType as PipelineType)) {
    res.status(400).json({ error: `pipelineType must be one of: ${VALID_PIPELINE_TYPES.join(", ")}.` });
    return;
  }

  try {
    const run = await createPlanningRun(
      body.pipelineType !== undefined
        ? { bookId: body.bookId, userId: body.userId, pipelineType: body.pipelineType as PipelineType }
        : { bookId: body.bookId, userId: body.userId }
    );
    res.status(201).json({ run });
  } catch (error) {
    handleError(res, error, "create planning run");
  }
});

// POST /api/v1/planning/runs/:id/promote-to-full — takes a COMPLETED
// (status: done) Contract Pipeline run and creates a brand new "full"
// pipeline run for the same book, seeded with its approved Stage 1
// Summary and its already-materialized Part 1 (chapters 1-5). Returns the
// NEW run — the frontend should switch to its id, the original contract
// run is left untouched as a historical record. 409 if the source run
// isn't a completed contract run.
planningRouter.post("/planning/runs/:id/promote-to-full", async (req: Request, res: Response) => {
  try {
    const run = await promoteContractRunToFull(req.params.id as string);
    res.status(201).json({ run });
  } catch (error) {
    console.error("promote contract run to full failed:", error);
    const message = error instanceof Error ? error.message : "Failed to promote Contract Pipeline run.";
    res.status(message.includes("must be") || message.includes("Only a Contract Pipeline run") ? 409 : 502).json({ error: message });
  }
});

// GET /api/v1/planning/runs?bookId= — every run for a book, most recently
// updated first. Lets the frontend resolve "what's this book's current
// planning run" on its own (e.g. on load, or after losing whatever URL
// was carrying a specific run id) instead of depending on that id
// surviving client-side — the run's actual state was never at risk, only
// the frontend's pointer to it was.
planningRouter.get("/planning/runs", async (req: Request, res: Response) => {
  const bookId = req.query.bookId;
  if (typeof bookId !== "string" || bookId.trim() === "") {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }

  try {
    const runs = await listPlanningRuns(bookId);
    res.json({ runs });
  } catch (error) {
    console.error("list planning runs failed:", error);
    res.status(502).json({ error: "Failed to list planning runs." });
  }
});

// POST /api/v1/planning/runs/:id/intake-chat — one turn of the pre-Stage-1
// conversation. { message: string, documentBase64?: string, documentMediaType?: string }
// Pasting a URL directly in `message` lets Claude fetch and read it itself
// (server-side web_fetch tool — no separate scraping call needed). The
// optional document is read for this call only, never persisted.
planningRouter.post("/planning/runs/:id/intake-chat", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.message !== "string" || body.message.trim() === "") {
    res.status(400).json({ error: "message is required and must be a non-empty string." });
    return;
  }
  if (body.documentBase64 !== undefined && typeof body.documentBase64 !== "string") {
    res.status(400).json({ error: "documentBase64 must be a string when provided." });
    return;
  }
  if (body.documentBase64 !== undefined && typeof body.documentMediaType !== "string") {
    res.status(400).json({ error: "documentMediaType is required when documentBase64 is provided." });
    return;
  }

  const document =
    typeof body.documentBase64 === "string"
      ? { base64: body.documentBase64, mediaType: body.documentMediaType as string }
      : undefined;

  try {
    res.json({ run: await intakeChatTurn((req.params.id as string), body.message, document) });
  } catch (error) {
    handleError(res, error, "run intake chat turn");
  }
});

// POST /api/v1/planning/runs/:id/intake-finalize — compiles the intake
// conversation into the Generator's first directive and opens Stage 1
// (status -> generating). Call this once the writer is done describing
// what they want.
planningRouter.post("/planning/runs/:id/intake-finalize", async (req: Request, res: Response) => {
  try {
    res.json({ run: await finalizeIntake((req.params.id as string)) });
  } catch (error) {
    handleError(res, error, "finalize intake");
  }
});

// GET /api/v1/planning/runs/:id — poll current state. Every step below
// runs exactly one (or one-parallel-pair) LLM call and returns — the
// frontend drives the pipeline forward by calling the next step, the same
// resumable-job pattern as bulk manuscript import, so nothing here risks
// a request timeout regardless of hosting tier.
planningRouter.get("/planning/runs/:id", async (req: Request, res: Response) => {
  try {
    const run = await getPlanningRun((req.params.id as string));
    res.json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch planning run.";
    res.status(message.includes("No planning run found") ? 404 : 502).json({ error: message });
  }
});

// DELETE /api/v1/planning/runs/:id — abandons the run's own bookkeeping
// row (intake/chat history, stage artifacts, panel reviews). Does NOT
// touch anything already materialized from it — a chapter_beats row or
// codex_entries created by a prior approval on this run stay exactly
// where they are; delete those through their own normal endpoints if
// that's what's actually intended.
planningRouter.delete("/planning/runs/:id", async (req: Request, res: Response) => {
  try {
    await deletePlanningRun((req.params.id as string));
    res.status(204).end();
  } catch (error) {
    console.error("delete planning run failed:", error);
    const message = error instanceof Error ? error.message : "Failed to delete planning run.";
    res.status(message.includes("No planning run found") ? 404 : 502).json({ error: message });
  }
});

planningRouter.post("/planning/runs/:id/generate", async (req: Request, res: Response) => {
  try {
    res.json({ run: await generateStage((req.params.id as string)) });
  } catch (error) {
    handleError(res, error, "generate stage");
  }
});

planningRouter.post("/planning/runs/:id/critique", async (req: Request, res: Response) => {
  try {
    res.json({ run: await runCritique((req.params.id as string)) });
  } catch (error) {
    handleError(res, error, "run critique");
  }
});

planningRouter.post("/planning/runs/:id/arbitrate", async (req: Request, res: Response) => {
  try {
    res.json({ run: await runArbitration((req.params.id as string)) });
  } catch (error) {
    handleError(res, error, "run arbitration");
  }
});

// POST /api/v1/planning/runs/:id/approve — the human review gate's
// approve action. On a part_outline, this also records the Part's
// committed chapter range; on a part_beats chunk, this also materializes
// the beats into chapter_beats (the existing Outliner) and reconciles the
// continuity ledger — see planningEngine.approveStage.
planningRouter.post("/planning/runs/:id/approve", async (req: Request, res: Response) => {
  try {
    res.json({ run: await approveStage((req.params.id as string)) });
  } catch (error) {
    handleError(res, error, "approve stage");
  }
});

// POST /api/v1/planning/runs/:id/reject — opens the Arbitrator chat.
planningRouter.post("/planning/runs/:id/reject", async (req: Request, res: Response) => {
  try {
    res.json({ run: await rejectStage((req.params.id as string)) });
  } catch (error) {
    handleError(res, error, "reject stage");
  }
});

// POST /api/v1/planning/runs/:id/unapprove — undoes approving the CURRENT
// stage's prior stage (i.e. reopens whatever was just approved) and opens
// its rejection interview directly. Only safe to call before anything has
// been generated for the stage that approval advanced into — 409 if that
// stage already has its own artifact, since reverting would discard it.
planningRouter.post("/planning/runs/:id/unapprove", async (req: Request, res: Response) => {
  try {
    res.json({ run: await unapproveStage((req.params.id as string)) });
  } catch (error) {
    console.error("unapprove stage failed:", error);
    const message = error instanceof Error ? error.message : "Failed to unapprove stage.";
    res.status(message.includes("already has a generated artifact") || message.includes("Already at the first stage") ? 409 : 502).json({ error: message });
  }
});

// POST /api/v1/planning/runs/:id/discard-stage — trashes the CURRENT
// stage's draft outright (unlike unapprove, this is allowed even when one
// exists — that's the point) and falls back to the PREVIOUS stage's review
// gate, ready to re-approve into a genuinely fresh generation. No
// interview — there's nothing to discuss, the writer just doesn't want
// this draft.
planningRouter.post("/planning/runs/:id/discard-stage", async (req: Request, res: Response) => {
  try {
    res.json({ run: await discardStage((req.params.id as string)) });
  } catch (error) {
    console.error("discard stage failed:", error);
    const message = error instanceof Error ? error.message : "Failed to discard stage.";
    res.status(message.includes("Already at the first stage") ? 409 : 502).json({ error: message });
  }
});

// POST /api/v1/planning/runs/:id/chat — one turn of the Arbitrator
// interview. { message: string }
planningRouter.post("/planning/runs/:id/chat", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.message !== "string" || body.message.trim() === "") {
    res.status(400).json({ error: "message is required and must be a non-empty string." });
    return;
  }
  try {
    res.json({ run: await chatTurn((req.params.id as string), body.message) });
  } catch (error) {
    handleError(res, error, "run chat turn");
  }
});

// POST /api/v1/planning/runs/:id/finalize-directive — compiles the chat
// into a delta directive and loops back to Generator for this stage.
planningRouter.post("/planning/runs/:id/finalize-directive", async (req: Request, res: Response) => {
  try {
    res.json({ run: await finalizeDirective((req.params.id as string)) });
  } catch (error) {
    handleError(res, error, "finalize directive");
  }
});

// POST /api/v1/planning/runs/:id/entities/extract — on-demand entity
// extraction, callable whenever the writer wants (not tied to any one
// beats-chunk approval — see extractEntities). Scans every approved
// part_beats chunk so far. Does not change the run's status; extraction
// is a side action independent of the run's actual pipeline position.
planningRouter.post("/planning/runs/:id/entities/extract", async (req: Request, res: Response) => {
  try {
    res.json({ run: await extractEntities((req.params.id as string)) });
  } catch (error) {
    handleError(res, error, "extract entities");
  }
});

// POST /api/v1/planning/runs/:id/entities/confirm — the batch review
// screen's confirm action. { approvedIndexes: number[] } — indexes into
// the run's extracted_entities array; anything not listed is discarded.
planningRouter.post("/planning/runs/:id/entities/confirm", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const approvedIndexes = Array.isArray(body.approvedIndexes) ? body.approvedIndexes.filter((n) => typeof n === "number") : [];

  try {
    res.json({ run: await confirmEntities((req.params.id as string), approvedIndexes) });
  } catch (error) {
    handleError(res, error, "confirm extracted entities");
  }
});
