import { Router, type Request, type Response } from "express";
import {
  createPlanningRun,
  getPlanningRun,
  generateStage,
  runCritique,
  runArbitration,
  approveStage,
  rejectStage,
  chatTurn,
  finalizeDirective,
  confirmEntities,
} from "../services/planningEngine.js";

export const planningRouter = Router();

function handleError(res: Response, error: unknown, context: string) {
  console.error(`${context} failed:`, error);
  res.status(502).json({ error: error instanceof Error ? error.message : `Failed to ${context}.` });
}

// POST /api/v1/planning/runs — starts a new planning run at Stage 1.
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

  try {
    const run = await createPlanningRun({ bookId: body.bookId, userId: body.userId });
    res.status(201).json({ run });
  } catch (error) {
    handleError(res, error, "create planning run");
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
// approve action. On Stage 3 (Beats), this also materializes the beats
// into chapter_beats (the existing Outliner) and starts entity
// extraction — see planningEngine.approveStage.
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
