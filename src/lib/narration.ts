// Narration switch — a book-level setting for point of view and tense that
// the backend injects into every generation and then verifies, instead of
// relying on whoever (or whichever Claude session) compiles the prompt to
// remember to say it. See the "Narration Switch" section of CLAUDE.md.
//
// The setting lives in the existing books.pov / books.tense columns, which
// predate this feature and are free text (no CHECK constraint) because the
// frontend's exact values were never settled. So this module NORMALIZES
// whatever is stored rather than tightening validation on write: nothing the
// frontend already sends gets rejected, and a value that can't be understood
// simply leaves the switch off for that book instead of erroring.

export type NarrationPov = "first" | "third";
export type NarrationTense = "past" | "present";

export interface NarrationSetting {
  pov: NarrationPov;
  tense: NarrationTense;
}

export function normalizePov(raw: unknown): NarrationPov | null {
  if (typeof raw !== "string") return null;
  const v = raw.toLowerCase().trim();
  if (v === "") return null;
  if (/^(1st|first)\b/.test(v) || v.includes("first person") || v.includes("first-person")) return "first";
  if (/^(3rd|third)\b/.test(v) || v.includes("third person") || v.includes("third-person")) return "third";
  return null;
}

export function normalizeTense(raw: unknown): NarrationTense | null {
  if (typeof raw !== "string") return null;
  const v = raw.toLowerCase().trim();
  if (v === "") return null;
  if (v.includes("past")) return "past";
  if (v.includes("present")) return "present";
  return null;
}

// The switch is ON only when both halves are understood. A book with just a
// POV or just a tense set stays off — half a rule would be enforced
// inconsistently, which is worse than a clear "not configured".
export function resolveNarrationSetting(pov: unknown, tense: unknown): NarrationSetting | null {
  const p = normalizePov(pov);
  const t = normalizeTense(tense);
  if (!p || !t) return null;
  return { pov: p, tense: t };
}

export function describeNarration(setting: NarrationSetting): string {
  return `${setting.pov === "first" ? "first person" : "third person"}, ${setting.tense} tense`;
}

// Standard wording, written once here so every call states the rule the same
// way. Placed in the system prompt (buildSystemPrompt) AND echoed at the end
// of the user turn (buildNarrationReminder) — the same recency trick the
// MUST NOT list already uses, since a rule stated only once, far from where
// generation starts, is the one a model drops.
export function buildNarrationSection(setting: NarrationSetting): string {
  const pov =
    setting.pov === "first"
      ? "first person (I, me, my). The narrator is the point-of-view character; never refer to the narrator by name or as he or she in the narration."
      : "third person (he, she, they, or the character's name). Never use I, me or my in the narration outside of dialogue.";
  const tense =
    setting.tense === "past"
      ? "the past tense. Every sentence of narration is in the past tense."
      : "the present tense. Every sentence of narration is in the present tense.";
  return [
    "## Narration (fixed for this book)",
    `Write the narration in ${pov}`,
    `Write the narration in ${tense} Only dialogue and quoted speech may differ.`,
  ].join("\n");
}

export function buildNarrationReminder(setting: NarrationSetting): string {
  return `Narration: ${describeNarration(setting)}, every sentence.`;
}

export function appendNarrationReminder(userMessage: string, setting: NarrationSetting): string {
  return `${userMessage}\n\n${buildNarrationReminder(setting)}`;
}

// Master kill switch for the VERIFY step only (the prompt wording is cheap
// and always applied). The detector is a deterministic heuristic, not a
// grammar parser; if it ever misfires in production this lets it be turned
// off with an env var, without a redeploy of code, while the injection keeps
// working. Default is on.
export function isNarrationEnforcementEnabled(): boolean {
  return (process.env.NARRATION_ENFORCEMENT ?? "on").toLowerCase() !== "off";
}
