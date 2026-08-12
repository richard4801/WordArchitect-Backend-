import { generateHanamiProse } from "./llm.js";
import { diffDrafts, type TextDiffResult } from "../lib/textDiff.js";

// Confirmed by direct testing against the Infermatic API (temperature 0,
// identical output with/without logit_bias on real token IDs) that
// generation-time token suppression is not honored, and wouldn't be safe
// even if it were — most words are multiple subword tokens sharing pieces
// with unrelated vocabulary. So there's no cheap path: every banned term,
// word or phrase, is enforced the same way — detect it in already-
// generated text and regenerate the offending paragraph — which is why
// this module has one code path, not a fast one and a slow one.
const MAX_REGENERATION_ATTEMPTS = 3;

export interface BannedTermMatch {
  term: string;
  index: number;
}

// Case-insensitive substring search — not strict word-boundary matching.
// This is a deliberate simplification: it means banning "delve" also
// catches "delved" (contains "delve" as a substring) but not "delving"
// (doesn't). A writer who wants full conjugation coverage can ban
// multiple literal forms; a real stemmer is more machinery than this
// warrants until real usage shows it's actually needed.
export function detectBannedTerms(text: string, bannedTerms: string[]): BannedTermMatch[] {
  const lowerText = text.toLowerCase();
  const matches: BannedTermMatch[] = [];

  for (const term of bannedTerms) {
    const lowerTerm = term.toLowerCase().trim();
    if (!lowerTerm) continue;
    const index = lowerText.indexOf(lowerTerm);
    if (index !== -1) matches.push({ term, index });
  }

  return matches;
}

// Paragraph is the unit of both detection and correction — matches the
// project's established finding that Hanami's scope discipline holds up
// well at roughly one paragraph per call and degrades sharply beyond it,
// so regenerating a whole scene to fix one cliché would both cost more
// and be less reliable than a narrowly scoped rewrite.
function splitIntoParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/);
}

export interface ParagraphCorrection {
  paragraphIndex: number;
  originalText: string;
  finalText: string;
  bannedTermsFound: string[];
  attempts: number;
  resolved: boolean;
  diff: TextDiffResult;
}

export interface GhostEditorResult {
  finalText: string;
  corrections: ParagraphCorrection[];
}

function buildRegenerationPrompt(params: {
  before: string | null;
  paragraph: string;
  after: string | null;
  bannedTerms: string[];
}): string {
  const parts = [
    `Rewrite ONLY the paragraph marked "PARAGRAPH TO REWRITE" below so it no longer contains any of these banned words/phrases: ${params.bannedTerms.map((t) => `"${t}"`).join(", ")}.`,
    "Keep the same narrative meaning, tone, and approximate length — this is a targeted correction, not a new scene. Do not invent new plot content.",
    "The surrounding paragraphs are given only for continuity — do not rewrite them, do not repeat them in your answer.",
    "Respond with ONLY the rewritten replacement paragraph. No preamble, no explanation, no surrounding paragraphs.",
    "",
  ];

  if (params.before) parts.push("--- PRECEDING PARAGRAPH (context only) ---", params.before, "");
  parts.push("--- PARAGRAPH TO REWRITE ---", params.paragraph, "");
  if (params.after) parts.push("--- FOLLOWING PARAGRAPH (context only) ---", params.after, "");

  return parts.join("\n");
}

// Walks every paragraph, regenerating (with verification + a bounded
// retry loop, not a single blind pass — see CLAUDE.md on why trusting one
// corrective instruction isn't reliable enough) any paragraph that
// contains a banned term, until it's clean or the attempt cap is reached.
// Paragraphs are only ever replaced whole, never partially — Hanami's
// scope discipline is what's being narrowed to here, not the story's.
export async function enforceBannedTerms(params: {
  text: string;
  bannedTerms: string[];
  systemPrompt: string;
}): Promise<GhostEditorResult> {
  const { bannedTerms, systemPrompt } = params;
  if (bannedTerms.length === 0) {
    return { finalText: params.text, corrections: [] };
  }

  const paragraphs = splitIntoParagraphs(params.text);
  const corrections: ParagraphCorrection[] = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const original = paragraphs[i] ?? "";
    let matches = detectBannedTerms(original, bannedTerms);
    if (matches.length === 0) continue;

    let current = original;
    let attempts = 0;
    const foundTerms = matches.map((m) => m.term);

    while (matches.length > 0 && attempts < MAX_REGENERATION_ATTEMPTS) {
      attempts += 1;
      const prompt = buildRegenerationPrompt({
        before: i > 0 ? (paragraphs[i - 1] ?? null) : null,
        paragraph: current,
        after: i < paragraphs.length - 1 ? (paragraphs[i + 1] ?? null) : null,
        bannedTerms: matches.map((m) => m.term),
      });

      const rewritten = await generateHanamiProse(systemPrompt, prompt);
      current = rewritten.trim();
      matches = detectBannedTerms(current, bannedTerms);
    }

    paragraphs[i] = current;
    corrections.push({
      paragraphIndex: i,
      originalText: original,
      finalText: current,
      bannedTermsFound: foundTerms,
      attempts,
      resolved: matches.length === 0,
      diff: diffDrafts(original, current),
    });
  }

  return { finalText: paragraphs.join("\n\n"), corrections };
}
