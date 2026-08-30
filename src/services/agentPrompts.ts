import { getSupabaseClient } from "../lib/supabaseClient.js";
import type { AgentPrompt, AgentRole, EffortLevel, PlanningStage } from "../types/domain.js";

// Every prompt an agent runs is a row here, authored by the writer — this
// backend never generates or hardcodes prompt content. getActivePrompt is
// the only thing the planning engine calls at runtime; everything else is
// CRUD for the prompt editor UI.

export async function listAgentPrompts(bookId: string): Promise<AgentPrompt[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("agent_prompts")
    .select("*")
    .eq("book_id", bookId)
    .order("agent_role", { ascending: true })
    .order("stage", { ascending: true })
    .order("version", { ascending: false });

  if (error) throw new Error(`Failed to list agent prompts: ${error.message}`);
  return (data ?? []) as AgentPrompt[];
}

// Tries the exact (agent_role, stage) first, then falls back to
// (agent_role, 'all') for a role whose prompt doesn't vary by stage. Throws
// a clear, specific error rather than silently running with no prompt —
// there is no built-in default prompt content for anything here.
export async function getActivePrompt(bookId: string, agentRole: AgentRole, stage: PlanningStage): Promise<AgentPrompt> {
  const supabase = getSupabaseClient();

  const { data: exact, error: exactError } = await supabase
    .from("agent_prompts")
    .select("*")
    .eq("book_id", bookId)
    .eq("agent_role", agentRole)
    .eq("stage", stage)
    .eq("is_active", true)
    .maybeSingle();
  if (exactError) throw new Error(`Failed to load prompt for ${agentRole}/${stage}: ${exactError.message}`);
  if (exact) return exact as AgentPrompt;

  if (stage !== "all") {
    const { data: fallback, error: fallbackError } = await supabase
      .from("agent_prompts")
      .select("*")
      .eq("book_id", bookId)
      .eq("agent_role", agentRole)
      .eq("stage", "all")
      .eq("is_active", true)
      .maybeSingle();
    if (fallbackError) throw new Error(`Failed to load prompt for ${agentRole}/all: ${fallbackError.message}`);
    if (fallback) return fallback as AgentPrompt;
  }

  throw new Error(
    `No active prompt configured for role "${agentRole}" at stage "${stage}" (or "all") for this book — add one in the Prompt Editor before running this step.`
  );
}

// Creating a prompt is always a new version: the previous active version
// for this exact (book_id, agent_role, stage) is deactivated, and the new
// one becomes active immediately. This is what makes an edit in the
// prompt-editor UI a runtime change, never a redeploy.
export async function createAgentPrompt(params: {
  bookId: string;
  agentRole: AgentRole;
  stage: PlanningStage;
  systemPrompt: string;
  userPromptTemplate: string;
  model: string;
  effort: EffortLevel;
}): Promise<AgentPrompt> {
  const supabase = getSupabaseClient();
  const { bookId, agentRole, stage, systemPrompt, userPromptTemplate, model, effort } = params;

  const { data: existing, error: existingError } = await supabase
    .from("agent_prompts")
    .select("id, version")
    .eq("book_id", bookId)
    .eq("agent_role", agentRole)
    .eq("stage", stage)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) throw new Error(`Failed to check existing prompt versions: ${existingError.message}`);

  const nextVersion = existing ? existing.version + 1 : 1;

  if (existing) {
    const { error: deactivateError } = await supabase
      .from("agent_prompts")
      .update({ is_active: false })
      .eq("book_id", bookId)
      .eq("agent_role", agentRole)
      .eq("stage", stage)
      .eq("is_active", true);
    if (deactivateError) throw new Error(`Failed to deactivate previous prompt version: ${deactivateError.message}`);
  }

  const { data, error } = await supabase
    .from("agent_prompts")
    .insert({
      book_id: bookId,
      agent_role: agentRole,
      stage,
      version: nextVersion,
      is_active: true,
      system_prompt: systemPrompt,
      user_prompt_template: userPromptTemplate,
      model,
      effort,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create agent prompt: ${error.message}`);
  return data as AgentPrompt;
}

// Edits an existing version's content in place — no new version, no
// activation change — for fixing a typo without cluttering version
// history. Pass isActive to reactivate an older version instead (this
// deactivates any other currently-active row for the same role/stage
// first, so the uniqueness of "one active per role/stage" always holds).
export async function updateAgentPrompt(
  id: string,
  updates: Partial<{
    systemPrompt: string;
    userPromptTemplate: string;
    model: string;
    effort: EffortLevel;
    isActive: boolean;
  }>
): Promise<AgentPrompt> {
  const supabase = getSupabaseClient();

  if (updates.isActive) {
    const { data: row, error: fetchError } = await supabase
      .from("agent_prompts")
      .select("book_id, agent_role, stage")
      .eq("id", id)
      .maybeSingle();
    if (fetchError) throw new Error(`Failed to load prompt: ${fetchError.message}`);
    if (!row) throw new Error(`No agent prompt found with id ${id}.`);

    const { error: deactivateError } = await supabase
      .from("agent_prompts")
      .update({ is_active: false })
      .eq("book_id", row.book_id)
      .eq("agent_role", row.agent_role)
      .eq("stage", row.stage)
      .eq("is_active", true);
    if (deactivateError) throw new Error(`Failed to deactivate other versions: ${deactivateError.message}`);
  }

  const payload: Record<string, unknown> = {};
  if (updates.systemPrompt !== undefined) payload.system_prompt = updates.systemPrompt;
  if (updates.userPromptTemplate !== undefined) payload.user_prompt_template = updates.userPromptTemplate;
  if (updates.model !== undefined) payload.model = updates.model;
  if (updates.effort !== undefined) payload.effort = updates.effort;
  if (updates.isActive !== undefined) payload.is_active = updates.isActive;

  const { data, error } = await supabase.from("agent_prompts").update(payload).eq("id", id).select("*").maybeSingle();
  if (error) throw new Error(`Failed to update agent prompt: ${error.message}`);
  if (!data) throw new Error(`No agent prompt found with id ${id}.`);
  return data as AgentPrompt;
}

// Refuses to delete the active version of a role/stage — deleting it would
// leave that step with no prompt to run at all, a silent trap the writer
// wouldn't notice until the next pipeline run fails.
export async function deleteAgentPrompt(id: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { data: row, error: fetchError } = await supabase.from("agent_prompts").select("is_active").eq("id", id).maybeSingle();
  if (fetchError) throw new Error(`Failed to load prompt: ${fetchError.message}`);
  if (!row) throw new Error(`No agent prompt found with id ${id}.`);
  if (row.is_active) {
    throw new Error("Cannot delete the active version of a prompt — activate a different version first, or it would leave this step with nothing to run.");
  }

  const { error } = await supabase.from("agent_prompts").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete agent prompt: ${error.message}`);
}

// Replaces {{KEY}} tokens with the given values. Keys not present in the
// template are simply not replaced — a role's template only ever
// references the slots it actually needs.
export function interpolateTemplate(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}
