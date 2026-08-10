import { getSupabaseClient } from "../lib/supabaseClient.js";

export interface PlotPoint {
  description: string;
  satisfied: boolean;
}

export type SceneDraftStatus = "in_progress" | "done" | "abandoned";

export interface SceneDraftSession {
  id: string;
  user_id: string;
  book_id: string;
  chapter_number: number | null;
  label: string | null;
  scene_beat: string;
  plot_points: PlotPoint[];
  current_draft: string;
  open_issues: string[];
  iteration_count: number;
  status: SceneDraftStatus;
  created_at: string;
  updated_at: string;
}

export interface SceneDraftIteration {
  id: string;
  session_id: string;
  iteration_number: number;
  instructions_given: string | null;
  draft_text: string;
  critique: string | null;
  created_at: string;
}

// Kicks off a supervised drafting session for one scene beat. plotPoints
// is the checklist derived from brainstorming — stored as { description,
// satisfied: false } so later iterations can mark them off individually
// rather than tracking progress only in conversation memory.
export async function startSceneDraftSession(params: {
  userId: string;
  bookId: string;
  sceneBeat: string;
  plotPoints: string[];
  chapterNumber?: number | undefined;
  label?: string | undefined;
}): Promise<SceneDraftSession> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("scene_draft_sessions")
    .insert({
      user_id: params.userId,
      book_id: params.bookId,
      scene_beat: params.sceneBeat,
      plot_points: params.plotPoints.map((description) => ({ description, satisfied: false })),
      chapter_number: params.chapterNumber ?? null,
      label: params.label ?? null,
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to start scene draft session: ${error.message}`);
  return data as SceneDraftSession;
}

// Records one generate-critique-redirect pass: appends an entry to the
// audit log (scene_draft_iterations) and updates the session's current
// state — the latest draft, which plot points are now satisfied, and
// what issues (if any) remain open. A resumed session only needs to read
// the parent row to know exactly where things stand.
export async function recordSceneDraftIteration(params: {
  sessionId: string;
  draftText: string;
  instructionsGiven?: string | undefined;
  critique?: string | undefined;
  satisfiedPlotPoints?: string[] | undefined;
  openIssues?: string[] | undefined;
}): Promise<SceneDraftSession> {
  const supabase = getSupabaseClient();

  const { data: session, error: fetchError } = await supabase
    .from("scene_draft_sessions")
    .select("*")
    .eq("id", params.sessionId)
    .maybeSingle();
  if (fetchError) throw new Error(`Failed to load scene draft session: ${fetchError.message}`);
  if (!session) throw new Error(`No scene draft session found with id ${params.sessionId}`);

  const nextIterationNumber = (session.iteration_count as number) + 1;

  const { error: insertError } = await supabase.from("scene_draft_iterations").insert({
    session_id: params.sessionId,
    iteration_number: nextIterationNumber,
    instructions_given: params.instructionsGiven ?? null,
    draft_text: params.draftText,
    critique: params.critique ?? null,
  });
  if (insertError) throw new Error(`Failed to record scene draft iteration: ${insertError.message}`);

  const satisfiedSet = new Set(params.satisfiedPlotPoints ?? []);
  const updatedPlotPoints = ((session.plot_points as PlotPoint[]) ?? []).map((point) =>
    satisfiedSet.has(point.description) ? { ...point, satisfied: true } : point
  );

  const updatePayload: Record<string, unknown> = {
    current_draft: params.draftText,
    iteration_count: nextIterationNumber,
    plot_points: updatedPlotPoints,
    updated_at: new Date().toISOString(),
  };
  if (params.openIssues !== undefined) updatePayload.open_issues = params.openIssues;

  const { data: updated, error: updateError } = await supabase
    .from("scene_draft_sessions")
    .update(updatePayload)
    .eq("id", params.sessionId)
    .select("*")
    .single();
  if (updateError) throw new Error(`Failed to update scene draft session: ${updateError.message}`);

  return updated as SceneDraftSession;
}

// Full detail for resuming: current state plus the complete pass-by-pass
// history, so a brand new conversation (not just the one that started it)
// can pick this session back up with full context of what's already been
// tried and why.
export async function getSceneDraftSession(
  sessionId: string
): Promise<{ session: SceneDraftSession; iterations: SceneDraftIteration[] }> {
  const supabase = getSupabaseClient();

  const { data: session, error: sessionError } = await supabase
    .from("scene_draft_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) throw new Error(`Failed to load scene draft session: ${sessionError.message}`);
  if (!session) throw new Error(`No scene draft session found with id ${sessionId}`);

  const { data: iterations, error: iterationsError } = await supabase
    .from("scene_draft_iterations")
    .select("*")
    .eq("session_id", sessionId)
    .order("iteration_number", { ascending: true });
  if (iterationsError) throw new Error(`Failed to load scene draft iterations: ${iterationsError.message}`);

  return { session: session as SceneDraftSession, iterations: (iterations ?? []) as SceneDraftIteration[] };
}

// Lightweight listing (no iteration history) for discovering what's
// in-progress for a book before resuming a specific one.
export async function listSceneDraftSessions(bookId: string, status?: SceneDraftStatus): Promise<SceneDraftSession[]> {
  const supabase = getSupabaseClient();
  let query = supabase.from("scene_draft_sessions").select("*").eq("book_id", bookId);
  if (status) query = query.eq("status", status);

  const { data, error } = await query.order("updated_at", { ascending: false });
  if (error) throw new Error(`Failed to list scene draft sessions: ${error.message}`);
  return (data ?? []) as SceneDraftSession[];
}

// Marks a session done. Deliberately separate from save_manuscript_scene
// (the existing MCP tool that actually ingests accepted prose into
// permanent manuscript memory) — finishing a draft session means Claude
// and the writer are satisfied with it, not that it's been accepted into
// canon yet; those are different moments.
export async function finishSceneDraftSession(sessionId: string, finalDraft?: string): Promise<SceneDraftSession> {
  const supabase = getSupabaseClient();
  const updatePayload: Record<string, unknown> = { status: "done" as SceneDraftStatus, updated_at: new Date().toISOString() };
  if (finalDraft !== undefined) updatePayload.current_draft = finalDraft;

  const { data, error } = await supabase
    .from("scene_draft_sessions")
    .update(updatePayload)
    .eq("id", sessionId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Failed to finish scene draft session: ${error.message}`);
  if (!data) throw new Error(`No scene draft session found with id ${sessionId}`);
  return data as SceneDraftSession;
}
