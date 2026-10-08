import Anthropic from "@anthropic-ai/sdk";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { getAnthropicClient } from "../lib/anthropicClient.js";

const EXTRACTION_MODEL = "claude-sonnet-5";
const EXTRACTION_MAX_TOKENS = 700;

export interface WritingVoiceProfile {
  id: string;
  user_id: string;
  sample_text: string;
  style_profile: string | null;
  extraction_error: string | null;
  updated_at: string;
}

export async function getWritingVoiceProfile(userId: string): Promise<WritingVoiceProfile | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("writing_voice_profiles").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`Failed to fetch writing voice profile: ${error.message}`);
  return (data as WritingVoiceProfile) ?? null;
}

// Analyzes a raw prose sample and writes a compact, Hanami-actionable style
// profile — concrete instructions ("short declarative sentences, dialogue-
// heavy, present tense"), not literary-critic commentary ("evocative,"
// "lyrical") that a generation model can't actually execute. This, not the
// raw sample, is what gets injected into every /generate-prose system
// prompt (see buildVoiceSection in rag.ts) — a bounded, predictable token
// cost regardless of how long the writer's pasted sample was.
async function extractStyleProfile(sampleText: string): Promise<string> {
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: EXTRACTION_MAX_TOKENS,
    system: [
      "You analyze a prose sample and write a compact style profile for a separate, less capable prose-generation model to follow when continuing a novel in this writer's own voice.",
      "Write CONCRETE, ACTIONABLE instructions the model can actually execute: sentence length/rhythm, vocabulary register, dialogue-tag conventions, POV/tense, pacing (scene vs. summary balance), paragraph length, distinctive tics or recurring constructions, and what to avoid. Not generic literary-critic adjectives like 'evocative' or 'lyrical' — those don't tell a model what to DO differently.",
      'Write it as a short list of direct rules, e.g.: "Short, declarative sentences, rarely more than 15 words. Dialogue carries most scenes; minimal internal narration between lines. Present tense, close third person. Paragraph breaks every 2-4 sentences. Avoid adverbs modifying dialogue tags (no \'she said angrily\') — show it in the line itself instead."',
      "Keep the whole profile under roughly 300 words. Base it only on what the sample actually demonstrates — never invent a convention the sample doesn't show.",
    ].join("\n\n"),
    messages: [{ role: "user", content: sampleText }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!text) throw new Error(`Style extraction returned no text (stop_reason: ${response.stop_reason}).`);
  return text;
}

export interface SaveWritingVoiceSampleResult {
  profile: WritingVoiceProfile;
  extractionFailed: boolean;
}

// Upserts sampleText (ALWAYS saved, even if extraction below fails — never
// lose a writer's pasted sample over a transient API error) and attempts to
// derive style_profile from it synchronously, in the same request. If
// extraction fails, style_profile is left at whatever it already was
// (a previously-good profile keeps being used rather than silently going
// blank — see migration 033) and extraction_error records why, so the
// caller can show that and let the writer retry via reextractWritingVoiceProfile
// without re-pasting anything.
export async function saveWritingVoiceSample(userId: string, sampleText: string): Promise<SaveWritingVoiceSampleResult> {
  const trimmed = sampleText.trim();
  if (!trimmed) throw new Error("sampleText must not be empty");

  const existing = await getWritingVoiceProfile(userId);
  let styleProfile = existing?.style_profile ?? null;
  let extractionError: string | null = null;
  try {
    styleProfile = await extractStyleProfile(trimmed);
  } catch (err) {
    extractionError = err instanceof Error ? err.message : String(err);
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("writing_voice_profiles")
    .upsert(
      {
        user_id: userId,
        sample_text: trimmed,
        style_profile: styleProfile,
        extraction_error: extractionError,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    )
    .select("*")
    .single();

  if (error) throw new Error(`Failed to save writing voice sample: ${error.message}`);
  return { profile: data as WritingVoiceProfile, extractionFailed: extractionError !== null };
}

// Re-runs extraction against the already-saved sample_text — the retry path
// for a failed attempt, or just to refresh the profile with no re-paste
// required. Same "keep the last good profile on failure" behavior as save.
export async function reextractWritingVoiceProfile(userId: string): Promise<WritingVoiceProfile> {
  const existing = await getWritingVoiceProfile(userId);
  if (!existing) throw new Error("No writing voice sample saved for this writer yet — paste one first.");

  let styleProfile = existing.style_profile;
  let extractionError: string | null = null;
  try {
    styleProfile = await extractStyleProfile(existing.sample_text);
  } catch (err) {
    extractionError = err instanceof Error ? err.message : String(err);
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("writing_voice_profiles")
    .update({ style_profile: styleProfile, extraction_error: extractionError, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error) throw new Error(`Failed to re-extract writing voice profile: ${error.message}`);
  return data as WritingVoiceProfile;
}

export async function deleteWritingVoiceProfile(userId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("writing_voice_profiles").delete().eq("user_id", userId);
  if (error) throw new Error(`Failed to delete writing voice profile: ${error.message}`);
}
