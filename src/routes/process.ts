import { Router, type Request, type Response } from "express";
import { PROCESS_VERSION, STEPS } from "../process/drafting.js";
import { renderProcessMarkdown, renderInstructions, SKILL_FILES, getSkillFile } from "../process/render.js";
import { getChapterWorkflow } from "../services/chapterWorkflow.js";

// The drafting process and the Claude-side skill files, served from one
// source (src/process/). See CLAUDE.md "Drafting Process Module".
export const processRouter = Router();

// GET /api/v1/process            → the human document (text/markdown)
// GET /api/v1/process?format=json → { version, steps, instructions, markdown }
processRouter.get("/process", (req: Request, res: Response) => {
  if (req.query.format === "json") {
    res.json({ version: PROCESS_VERSION, steps: STEPS, instructions: renderInstructions(), markdown: renderProcessMarkdown() });
    return;
  }
  res.type("text/markdown; charset=utf-8").send(renderProcessMarkdown());
});

// GET /api/v1/skills → { version, skills: [{ name, description, downloadUrl }] }
processRouter.get("/skills", (_req: Request, res: Response) => {
  res.json({
    version: PROCESS_VERSION,
    skills: SKILL_FILES.map((s) => ({ name: s.name, description: s.description, downloadUrl: `/api/v1/skills/${s.name}/download` })),
  });
});

// GET /api/v1/skills/:name/download → SKILL.md as an attachment
processRouter.get("/skills/:name/download", (req: Request, res: Response) => {
  const skill = getSkillFile(String(req.params.name));
  if (!skill) {
    res.status(404).json({ error: `No skill named ${req.params.name}. Available: ${SKILL_FILES.map((s) => s.name).join(", ")}.` });
    return;
  }
  res.setHeader("Content-Disposition", `attachment; filename="${skill.name}-SKILL.md"`);
  res.type("text/markdown; charset=utf-8").send(skill.render());
});

// GET /api/v1/chapter-workflow?bookId=&chapterNumber= → steps, next step, approvals, calls
processRouter.get("/chapter-workflow", async (req: Request, res: Response) => {
  const bookId = typeof req.query.bookId === "string" ? req.query.bookId.trim() : "";
  const chapterNumber = Number(req.query.chapterNumber);
  if (!bookId || !Number.isInteger(chapterNumber)) {
    res.status(400).json({ error: "bookId and an integer chapterNumber are required." });
    return;
  }
  try {
    res.json(await getChapterWorkflow(bookId, chapterNumber));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Failed to read the chapter workflow." });
  }
});
