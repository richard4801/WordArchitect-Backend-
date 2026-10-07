import { Router, type Request, type Response } from "express";
import { getSupabaseClient } from "../lib/supabaseClient.js";

export const collaborationLearningsRouter = Router();

export interface CollaborationLearning {
  id: string;
  user_id: string;
  book_id: string | null;
  category: string;
  lesson: string;
  created_at: string;
}

// Scoped by userId, not bookId — see migration
// 032_collaboration_learnings.sql for why: a Hanami behavior pattern or a
// writer's stated preference is a property of this writer, not one book,
// so it should surface again on their next project rather than being
// re-learned from scratch. Exported for reuse by the MCP server's
// get_collaboration_learnings tool and the Chat Assistant's equivalent.
export async function listCollaborationLearnings(
  userId: string,
  options: { category?: string | undefined } = {}
): Promise<CollaborationLearning[]> {
  const supabase = getSupabaseClient();
  let query = supabase.from("collaboration_learnings").select("*").eq("user_id", userId);
  if (options.category) query = query.eq("category", options.category);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list collaboration learnings: ${error.message}`);
  return (data ?? []) as CollaborationLearning[];
}

export interface AddCollaborationLearningParams {
  userId: string;
  bookId?: string | null;
  category: string;
  lesson: string;
}

// Deliberately NOT propose-gated on the Chat Assistant, unlike every
// other write tool there — this is operational memory for Claude's own
// future reference, not new writer-facing canon, the same exemption
// already established for the Planning Engine's continuity ledger (see
// "The continuity ledger" in CLAUDE.md). A bad entry here costs nothing
// more than a stale note; it never silently becomes something the writer
// has to review as if it were Codex/manuscript content.
export async function addCollaborationLearning(params: AddCollaborationLearningParams): Promise<CollaborationLearning> {
  const trimmedLesson = params.lesson.trim();
  if (!trimmedLesson) throw new Error("lesson must not be empty");
  const trimmedCategory = params.category.trim();
  if (!trimmedCategory) throw new Error("category must not be empty");

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("collaboration_learnings")
    .insert({
      user_id: params.userId,
      book_id: params.bookId ?? null,
      category: trimmedCategory,
      lesson: trimmedLesson,
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to record collaboration learning: ${error.message}`);
  return data as CollaborationLearning;
}

export async function deleteCollaborationLearning(id: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("collaboration_learnings").delete().eq("id", id).select("id").maybeSingle();
  if (error) throw new Error(`Failed to delete collaboration learning: ${error.message}`);
  if (!data) throw new Error(`No collaboration learning found with id ${id}.`);
}

// --- Express routes ---

// GET /api/v1/collaboration-learnings?userId=&category=
collaborationLearningsRouter.get("/collaboration-learnings", async (req: Request, res: Response) => {
  const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
  if (!userId) {
    res.status(400).json({ error: "userId query parameter is required." });
    return;
  }

  try {
    const learnings = await listCollaborationLearnings(userId, {
      category: typeof req.query.category === "string" ? req.query.category : undefined,
    });
    res.json({ learnings });
  } catch (error) {
    console.error("list collaboration learnings failed:", error);
    res.status(502).json({ error: "Failed to load collaboration learnings. Please try again." });
  }
});

// POST /api/v1/collaboration-learnings — { userId, bookId?, category, lesson }
collaborationLearningsRouter.post("/collaboration-learnings", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const category = typeof body.category === "string" ? body.category : "";
  const lesson = typeof body.lesson === "string" ? body.lesson : "";

  if (!userId) {
    res.status(400).json({ error: "userId is required and must be a non-empty string." });
    return;
  }
  if (!category.trim()) {
    res.status(400).json({ error: "category is required and must be a non-empty string." });
    return;
  }
  if (!lesson.trim()) {
    res.status(400).json({ error: "lesson is required and must be a non-empty string." });
    return;
  }
  if (body.bookId !== undefined && body.bookId !== null && typeof body.bookId !== "string") {
    res.status(400).json({ error: "bookId must be a string when provided." });
    return;
  }

  try {
    const learning = await addCollaborationLearning({
      userId,
      bookId: (body.bookId as string | null | undefined) ?? null,
      category,
      lesson,
    });
    res.status(201).json({ learning });
  } catch (error) {
    console.error("add collaboration learning failed:", error);
    res.status(502).json({ error: "Failed to record collaboration learning. Please try again." });
  }
});

// DELETE /api/v1/collaboration-learnings/:id
collaborationLearningsRouter.delete("/collaboration-learnings/:id", async (req: Request, res: Response) => {
  try {
    await deleteCollaborationLearning(req.params.id as string);
    res.status(204).send();
  } catch (error) {
    console.error("delete collaboration learning failed:", error);
    res.status(502).json({ error: "Failed to delete collaboration learning. Please try again." });
  }
});
