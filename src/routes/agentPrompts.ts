import { Router, type Request, type Response } from "express";
import { listAgentPrompts, createAgentPrompt, updateAgentPrompt, deleteAgentPrompt } from "../services/agentPrompts.js";
import { VALID_AGENT_ROLES, VALID_PLANNING_STAGES, VALID_EFFORT_LEVELS } from "../types/domain.js";
import type { AgentRole, EffortLevel, PlanningStage, PromptAuthor } from "../types/domain.js";

export const agentPromptsRouter = Router();

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_EFFORT: EffortLevel = "high";

// GET /api/v1/agent-prompts?bookId= — every version of every role/stage
// for this book, for the Prompt Editor UI to list and let the writer pick
// which version to view/edit/reactivate.
agentPromptsRouter.get("/agent-prompts", async (req: Request, res: Response) => {
  const bookId = req.query.bookId;
  if (typeof bookId !== "string" || bookId.trim() === "") {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }

  try {
    const prompts = await listAgentPrompts(bookId);
    res.json({ prompts });
  } catch (error) {
    console.error("list agent prompts failed:", error);
    res.status(502).json({ error: "Failed to list agent prompts." });
  }
});

// POST /api/v1/agent-prompts — saves a new version and activates it
// immediately, deactivating whatever was previously active for this exact
// (bookId, agentRole, stage). This is what makes an edit in the UI a
// runtime change — no redeploy, no code touched.
agentPromptsRouter.post("/agent-prompts", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }
  if (typeof body.agentRole !== "string" || !VALID_AGENT_ROLES.includes(body.agentRole as AgentRole)) {
    res.status(400).json({ error: `agentRole must be one of: ${VALID_AGENT_ROLES.join(", ")}.` });
    return;
  }
  if (typeof body.stage !== "string" || !VALID_PLANNING_STAGES.includes(body.stage as PlanningStage)) {
    res.status(400).json({ error: `stage must be one of: ${VALID_PLANNING_STAGES.join(", ")}.` });
    return;
  }
  if (typeof body.systemPrompt !== "string" || body.systemPrompt.trim() === "") {
    res.status(400).json({ error: "systemPrompt is required and must be a non-empty string." });
    return;
  }
  if (typeof body.userPromptTemplate !== "string" || body.userPromptTemplate.trim() === "") {
    res.status(400).json({ error: "userPromptTemplate is required and must be a non-empty string." });
    return;
  }
  if (body.effort !== undefined && !VALID_EFFORT_LEVELS.includes(body.effort as EffortLevel)) {
    res.status(400).json({ error: `effort must be one of: ${VALID_EFFORT_LEVELS.join(", ")}.` });
    return;
  }
  if (body.authoredBy !== undefined && body.authoredBy !== "writer" && body.authoredBy !== "claude") {
    res.status(400).json({ error: 'authoredBy must be "writer" or "claude".' });
    return;
  }

  try {
    const prompt = await createAgentPrompt({
      bookId: body.bookId,
      agentRole: body.agentRole as AgentRole,
      stage: body.stage as PlanningStage,
      systemPrompt: body.systemPrompt,
      userPromptTemplate: body.userPromptTemplate,
      model: typeof body.model === "string" && body.model.trim() !== "" ? body.model : DEFAULT_MODEL,
      effort: (body.effort as EffortLevel) ?? DEFAULT_EFFORT,
      authoredBy: body.authoredBy as PromptAuthor | undefined,
    });
    res.status(201).json({ prompt });
  } catch (error) {
    console.error("create agent prompt failed:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Failed to create agent prompt." });
  }
});

// PATCH /api/v1/agent-prompts/:id — edit an existing version's content in
// place (no new version), or pass isActive: true to reactivate an older
// version.
agentPromptsRouter.patch("/agent-prompts/:id", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: Record<string, unknown> = {};

  if (body.systemPrompt !== undefined) {
    if (typeof body.systemPrompt !== "string" || body.systemPrompt.trim() === "") {
      res.status(400).json({ error: "systemPrompt must be a non-empty string." });
      return;
    }
    updates.systemPrompt = body.systemPrompt;
  }
  if (body.userPromptTemplate !== undefined) {
    if (typeof body.userPromptTemplate !== "string" || body.userPromptTemplate.trim() === "") {
      res.status(400).json({ error: "userPromptTemplate must be a non-empty string." });
      return;
    }
    updates.userPromptTemplate = body.userPromptTemplate;
  }
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || body.model.trim() === "") {
      res.status(400).json({ error: "model must be a non-empty string." });
      return;
    }
    updates.model = body.model;
  }
  if (body.effort !== undefined) {
    if (!VALID_EFFORT_LEVELS.includes(body.effort as EffortLevel)) {
      res.status(400).json({ error: `effort must be one of: ${VALID_EFFORT_LEVELS.join(", ")}.` });
      return;
    }
    updates.effort = body.effort;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      res.status(400).json({ error: "isActive must be a boolean." });
      return;
    }
    updates.isActive = body.isActive;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updatable fields were provided." });
    return;
  }

  try {
    const prompt = await updateAgentPrompt((req.params.id as string), updates);
    res.json({ prompt });
  } catch (error) {
    console.error("update agent prompt failed:", error);
    const message = error instanceof Error ? error.message : "Failed to update agent prompt.";
    res.status(message.includes("No agent prompt found") ? 404 : 502).json({ error: message });
  }
});

// DELETE /api/v1/agent-prompts/:id — refuses to delete the active version
// of a role/stage (see deleteAgentPrompt for why).
agentPromptsRouter.delete("/agent-prompts/:id", async (req: Request, res: Response) => {
  try {
    await deleteAgentPrompt((req.params.id as string));
    res.status(204).end();
  } catch (error) {
    console.error("delete agent prompt failed:", error);
    const message = error instanceof Error ? error.message : "Failed to delete agent prompt.";
    const status = message.includes("No agent prompt found") ? 404 : message.includes("Cannot delete") ? 409 : 502;
    res.status(status).json({ error: message });
  }
});
