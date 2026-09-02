import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "../lib/anthropicClient.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { getActivePrompt, interpolateTemplate } from "./agentPrompts.js";
import type { PlatformCraftNotes } from "../types/domain.js";

// A per-book reference doc feeding {{PLATFORM_TRENDS}} into the Contract
// Pipeline's hook-focused generator/critics (see planningEngine.ts). This
// is deliberately NOT a live/automatic feed — see CLAUDE.md's Contract
// Pipeline section for why: scraping ranking/algorithm behavior in real
// time is fragile and platform-ToS-risky, and a silently-updating
// judgment reference is exactly the kind of ungoverned drift this
// project avoids everywhere else. Instead this is a one row per book
// doc, refreshed only when the writer explicitly asks for a research pass
// and only saved once they've reviewed the draft.

export async function getPlatformCraftNotes(bookId: string): Promise<PlatformCraftNotes | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("platform_craft_notes").select("*").eq("book_id", bookId).maybeSingle();
  if (error) throw new Error(`Failed to load platform craft notes: ${error.message}`);
  if (!data) return null;
  return { bookId: data.book_id, content: data.content, updatedAt: data.updated_at };
}

export async function savePlatformCraftNotes(bookId: string, content: string): Promise<PlatformCraftNotes> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("platform_craft_notes")
    .upsert({ book_id: bookId, content, updated_at: new Date().toISOString() }, { onConflict: "book_id" })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to save platform craft notes: ${error.message}`);
  return { bookId: data.book_id, content: data.content, updatedAt: data.updated_at };
}

// Matches planningEngine.ts's callAgent default — a real generative call
// with adaptive thinking enabled can spend its entire budget on thinking
// before emitting visible text if max_tokens is too low (confirmed live
// elsewhere in this project); reusing the same safe default here rather
// than re-learning that lesson with a smaller number.
const DEFAULT_MAX_TOKENS = 16000;

// On-demand research draft — never saved automatically, and never called
// from anywhere but the explicit POST /platform-craft-notes/research
// route. Uses Claude's own server-side web_search + web_fetch tools, the
// same pattern intakeChatTurn already uses for reading a pasted URL
// (planningEngine.ts) — the backend never scrapes HTML itself. Prompt
// content (what to research, how to write it up) is fully owned by the
// writer via the Prompt Editor like every other agent role in this
// project — role "platform_researcher", stage "all".
export async function researchPlatformCraftNotes(bookId: string): Promise<string> {
  const existing = await getPlatformCraftNotes(bookId);
  const prompt = await getActivePrompt(bookId, "platform_researcher", "all");
  const userMessage = interpolateTemplate(prompt.user_prompt_template, { EXISTING_NOTES: existing?.content ?? "" });

  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: prompt.model,
    max_tokens: DEFAULT_MAX_TOKENS,
    system: prompt.system_prompt,
    thinking: { type: "adaptive" },
    output_config: { effort: prompt.effort },
    // Server-side tools — Anthropic runs the searches/fetches itself
    // within this same call, no client-side execution loop needed. Not in
    // the SDK's plain Tool type (that's for custom tools with an
    // input_schema), hence the through-unknown cast — same pattern
    // intakeChatTurn already uses for web_fetch in planningEngine.ts.
    tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: 8 } as unknown as Anthropic.Tool,
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 } as unknown as Anthropic.Tool,
    ],
    messages: [{ role: "user", content: userMessage }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error(
      `Platform craft notes research returned no text output (stop_reason: ${response.stop_reason}). This usually means max_tokens was exhausted by thinking before any visible output.`
    );
  }

  return text;
}
