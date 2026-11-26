import type Anthropic from "@anthropic-ai/sdk";
import { generateHanamiProse } from "./llm.js";
import { getAnthropicClient } from "../lib/anthropicClient.js";
import { diffDrafts, type TextDiffResult } from "../lib/textDiff.js";
import { scanForSlop } from "../skills/antiSlopScan.js";

// The Ghost Editor: guarantees no banned word or phrase survives in a draft.
//
// Confirmed by direct testing against the Infermatic API that token-level
// suppression (logit_bias) is not honored, so every banned term is enforced
// the same way: detect it in finished text, rewrite, re-check.
//
// HOW IT REWRITES (the author's design, 26 Nov): the SYSTEM finds and marks
// every occurrence itself (deterministic; nothing is missed), and a Sonnet
// agent, run by the backend automatically, rewrites ONLY the sentence that
// holds the marked words, given the sentences around it as context so it
// understands how the words fit. The agent never needs the banned list: the
// system re-checks its rewrite against the FULL list and the guards below,
// and if the rewrite lands on another banned word, flags that spot again.
// Nothing is accepted until the system is satisfied, or the attempt cap is
// reached and the spot is reported unresolved (never claimed as fixed).
//
// Why a sentence, not the paragraph or the word (live test, LEARNINGS
// 2026-11-26): whole-paragraph rewrites dropped named characters and added
// invented content; word-only replacements broke grammar because the model
// rewrites around the marked span. A sentence is the smallest unit that can
// be rewritten safely.
//
// If Sonnet declines a spot (some explicit or violent sentences), that one
// spot falls back to Hanami with the same mark-and-recheck loop, and the
// report says which engine fixed it. GHOST_EDITOR_MODE=paragraph restores the
// previous whole-paragraph Hanami behaviour without a code change.

// Shared with the narration editor (3 tries per paragraph there). Spot fixes
// get their own, higher cap: each attempt is one short sentence.
export const MAX_REGENERATION_ATTEMPTS = 3;
export const MAX_SPOT_ATTEMPTS = 5;
const CONTEXT_SENTENCES = 2;
const DEFAULT_FIXER_MODEL = "claude-sonnet-5-5";

export interface BannedTermMatch {
  term: string;
  index: number;
}

// Case-insensitive substring search, deliberately not word-boundary: banning
// "delve" also catches "delved" (but not "delving"). Returns the FIRST
// occurrence of each term; see findAllBannedSpans for every occurrence.
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

export interface BannedSpan {
  term: string;
  start: number;
  end: number;
}

// Every occurrence of every banned term, in text order.
export function findAllBannedSpans(text: string, bannedTerms: string[]): BannedSpan[] {
  const lower = text.toLowerCase();
  const spans: BannedSpan[] = [];
  for (const term of bannedTerms) {
    const t = term.toLowerCase().trim();
    if (!t) continue;
    let from = 0;
    while (true) {
      const i = lower.indexOf(t, from);
      if (i === -1) break;
      spans.push({ term, start: i, end: i + t.length });
      from = i + 1;
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Sentences.
// ---------------------------------------------------------------------------

interface Sentence {
  start: number;
  end: number; // exclusive, includes trailing whitespace
}

// A sentence ends at . ! ? or … (optionally followed by a closing quote)
// followed by whitespace, or at a paragraph break. Good enough for prose; a
// mis-split only makes the rewrite unit slightly larger or smaller.
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const re = /[.!?…]+["”’')]*\s+|\n\s*\n/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (end > start) out.push({ start, end });
    start = end;
  }
  if (start < text.length) out.push({ start, end: text.length });
  return out;
}

// ---------------------------------------------------------------------------
// Guards: a rewrite is rejected (and the agent told why) if it does more
// than remove the banned words.
// ---------------------------------------------------------------------------

// Capitalised words that commonly open a sentence without being a name.
const COMMON_OPENERS = new Set(
  "the a an i he she it they we you his her their our your my its this that these those there here when then but and or so if as in on at for with after before still even no yes not only once now all some someone nobody nothing everyone every each what why how where who which while until because though although just maybe perhaps one two three".split(" ")
);

function properNames(sentence: string): Set<string> {
  const words = sentence.match(/[\p{L}'’]+/gu) ?? [];
  const names = new Set<string>();
  words.forEach((w, i) => {
    if (!/^\p{Lu}/u.test(w) || w === "I" || /^I['’]/.test(w)) return;
    // ALL-CAPS words are emphasis ("I MADE MYSELF"), not names.
    if (w.length > 1 && w === w.toUpperCase()) return;
    const bare = w.replace(/['’]s$/, "");
    // A sentence-initial capital is only a name if it isn't a common opener
    // or an obvious verb/adverb form ("Counting", "Trying", "Slowly").
    if (i === 0 && (COMMON_OPENERS.has(bare.toLowerCase()) || /(ing|ed|ly)$/.test(bare))) return;
    names.add(bare);
  });
  return names;
}

const DASH = /[–—]|\s-\s|--/;

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function guardProblems(original: string, rewrite: string): string[] {
  const problems: string[] = [];
  if (!rewrite.trim()) return ["the rewrite was empty"];
  const before = properNames(original);
  const after = properNames(rewrite);
  // Compared case-insensitively against the other sentence's words, so a
  // word that merely moved to the start of the sentence ("unable" →
  // "Unable") is not mistaken for a new name.
  const lowerOriginal = original.toLowerCase();
  const lowerRewrite = rewrite.toLowerCase();
  const lost = [...before].filter((n) => !after.has(n) && !lowerRewrite.includes(n.toLowerCase()));
  const added = [...after].filter((n) => !before.has(n) && !lowerOriginal.includes(n.toLowerCase()));
  if (lost.length) problems.push(`it dropped the name(s) ${lost.join(", ")}`);
  if (added.length) problems.push(`it added the name(s) ${added.join(", ")}, which are not in the original`);
  if (DASH.test(rewrite) && !DASH.test(original)) problems.push("it added a dash (the house style allows none)");
  const ow = wordCount(original);
  const rw = wordCount(rewrite);
  if (rw > Math.max(ow * 1.6, ow + 8)) problems.push(`it is much longer than the original (${rw} words vs ${ow})`);
  if (rw < Math.min(ow * 0.4, ow - 6)) problems.push(`it is much shorter than the original (${rw} words vs ${ow})`);
  const COMPARISON = /\b(like an?|like the|as if|as though)\b/i;
  if (COMPARISON.test(rewrite) && !COMPARISON.test(original)) problems.push("it added a comparison (like / as if), and new figures of speech are not allowed in a fix");
  const stockBefore = new Set(scanForSlop(original).hits.map((h) => h.id));
  const stockAdded = scanForSlop(rewrite).hits.filter((h) => !stockBefore.has(h.id));
  if (stockAdded.length) problems.push(`it added stock phrasing (${stockAdded.map((h) => h.label).join(", ")})`);
  return problems;
}

// ---------------------------------------------------------------------------
// The rewriters, injectable for tests.
// ---------------------------------------------------------------------------

export type RewriteOutcome = { text: string } | { refused: true; reason: string };
export type Rewriter = (system: string, user: string) => Promise<RewriteOutcome>;

const FIXER_SYSTEM = `You are a line editor for an adult dark werewolf romance. You make one small, surgical fix at a time: rewrite a single marked sentence so that the words between [[ and ]] no longer appear, keeping everything else about it. Same meaning, same point of view, same tense, same voice, about the same length. Do not add any new event, detail, name, figure of speech or dash. Violence and sexual content are part of this book; edit them as a professional line editor would, without softening or censoring the meaning. Reply with ONLY the rewritten sentence.`;

export const sonnetRewriter: Rewriter = async (system, user) => {
  const client = getAnthropicClient();
  const response = (await client.messages.create({
    model: process.env.GHOST_EDITOR_MODEL?.trim() || DEFAULT_FIXER_MODEL,
    max_tokens: 2000,
    system,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: user }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming)) as Anthropic.Message;
  if (response.stop_reason === "refusal") return { refused: true, reason: "the model declined this sentence" };
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  if (!text) return { refused: true, reason: `empty reply (stop_reason: ${response.stop_reason})` };
  return { text };
};

export function hanamiRewriter(hanamiSystemPrompt: string): Rewriter {
  return async (_system, user) => ({ text: (await generateHanamiProse(hanamiSystemPrompt, `${FIXER_SYSTEM}\n\n${user}`)).trim() });
}

// Models sometimes wrap the answer in quotes, add a label, or return the
// context too. Keep the first non-empty line and strip wrapping.
function cleanReply(raw: string): string {
  const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.replace(/^(rewritten sentence|sentence)\s*:\s*/i, "").replace(/^\[\[|\]\]$/g, "").replace(/^["“](.*)["”]$/s, "$1").replace(/\[\[|\]\]/g, "").trim();
}

// ---------------------------------------------------------------------------
// Fixing one spot (one sentence that holds at least one banned span).
// ---------------------------------------------------------------------------

export interface SpotFix {
  sentenceBefore: string;
  sentenceAfter: string;
  termsFound: string[];
  attempts: number;
  resolved: boolean;
  engine: "sonnet" | "hanami" | "none";
  log: string[];
}

function buildSpotPrompt(context: { before: string; marked: string; after: string }, avoid: string[], rejections: string[]): string {
  const parts = [
    "CONTEXT BEFORE (do not rewrite):",
    context.before || "(start of passage)",
    "",
    "SENTENCE TO REWRITE (remove the words between [[ and ]]):",
    context.marked,
    "",
    "CONTEXT AFTER (do not rewrite):",
    context.after || "(end of passage)",
  ];
  if (avoid.length) parts.push("", `Your rewrite must not contain any of: ${avoid.map((t) => `"${t}"`).join(", ")}.`);
  if (rejections.length) parts.push("", `Your previous attempt was rejected because ${rejections.join("; ")}. Fix that.`);
  parts.push("", "Reply with only the rewritten sentence.");
  return parts.join("\n");
}

async function fixSpot(params: {
  text: string;
  sentence: Sentence;
  sentences: Sentence[];
  index: number;
  bannedTerms: string[];
  primary: Rewriter;
  fallback: Rewriter | null;
}): Promise<{ replacement: string; fix: SpotFix }> {
  const { text, sentence, sentences, index, bannedTerms } = params;
  const raw = text.slice(sentence.start, sentence.end);
  const trailing = raw.match(/\s*$/)?.[0] ?? "";
  const original = raw.slice(0, raw.length - trailing.length);
  const before = text.slice(sentences[Math.max(0, index - CONTEXT_SENTENCES)]!.start, sentence.start).trim();
  const afterEnd = sentences[Math.min(sentences.length - 1, index + CONTEXT_SENTENCES)]!.end;
  const after = text.slice(sentence.end, afterEnd).trim();

  const termsFound = [...new Set(findAllBannedSpans(original, bannedTerms).map((s) => s.term))];
  const avoid = new Set<string>();
  const log: string[] = [];
  let current = original;
  let rejections: string[] = [];
  let engine: SpotFix["engine"] = "sonnet";
  let rewriter = params.primary;
  let attempts = 0;

  while (attempts < MAX_SPOT_ATTEMPTS) {
    const spans = findAllBannedSpans(current, bannedTerms);
    if (spans.length === 0 && rejections.length === 0) {
      return { replacement: current + trailing, fix: { sentenceBefore: original, sentenceAfter: current, termsFound, attempts, resolved: true, engine, log } };
    }
    // Always mark the CURRENT candidate's banned spans; on a guard rejection
    // re-mark the original so the agent starts from the author's words.
    const base = spans.length ? current : original;
    const marks = findAllBannedSpans(base, bannedTerms);
    let marked = "";
    let pos = 0;
    for (const s of marks) {
      if (s.start < pos) continue; // overlapping terms: the first mark covers it
      marked += base.slice(pos, s.start) + "[[" + base.slice(s.start, s.end) + "]]";
      pos = s.end;
    }
    marked += base.slice(pos);
    marks.forEach((s) => avoid.add(s.term));

    attempts++;
    let outcome: RewriteOutcome;
    try {
      outcome = await rewriter(FIXER_SYSTEM, buildSpotPrompt({ before, marked, after }, [...avoid], rejections));
    } catch (err) {
      outcome = { refused: true, reason: err instanceof Error ? err.message : String(err) };
    }
    if ("refused" in outcome) {
      log.push(`attempt ${attempts} (${engine}): declined — ${outcome.reason}`);
      if (engine === "sonnet" && params.fallback) {
        engine = "hanami";
        rewriter = params.fallback;
        rejections = [];
        continue;
      }
      break;
    }
    const candidate = cleanReply(outcome.text);
    const stillBanned = [...new Set(findAllBannedSpans(candidate, bannedTerms).map((s) => s.term))];
    const problems = guardProblems(original, candidate);
    log.push(
      `attempt ${attempts} (${engine}): "${candidate}"${stillBanned.length ? ` — still banned: ${stillBanned.join(", ")}` : ""}${problems.length ? ` — rejected: ${problems.join("; ")}` : ""}`
    );
    if (problems.length) {
      rejections = problems;
      current = stillBanned.length ? candidate : original;
      continue;
    }
    rejections = [];
    current = candidate;
  }

  const clean = findAllBannedSpans(current, bannedTerms).length === 0 && rejections.length === 0;
  // Never hand back a guard-rejected candidate: keep the author's sentence.
  const final = clean ? current : original;
  return {
    replacement: final + trailing,
    fix: { sentenceBefore: original, sentenceAfter: final, termsFound, attempts, resolved: clean, engine: clean ? engine : "none", log },
  };
}

// ---------------------------------------------------------------------------
// Public API (same shape as before, so callers and the report reader are
// unchanged; per-spot details are added fields).
// ---------------------------------------------------------------------------

export interface ParagraphCorrection {
  paragraphIndex: number;
  originalText: string;
  finalText: string;
  bannedTermsFound: string[];
  attempts: number;
  resolved: boolean;
  diff: TextDiffResult;
  spots?: SpotFix[];
}

export interface GhostEditorResult {
  finalText: string;
  corrections: ParagraphCorrection[];
}

function splitIntoParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/);
}

export async function enforceBannedTerms(params: {
  text: string;
  bannedTerms: string[];
  // Hanami system prompt, used only for the fallback and paragraph mode.
  systemPrompt: string;
  primary?: Rewriter;
  fallback?: Rewriter | null;
}): Promise<GhostEditorResult> {
  const bannedTerms = params.bannedTerms.filter((t) => t.trim());
  if (bannedTerms.length === 0) return { finalText: params.text, corrections: [] };
  if ((process.env.GHOST_EDITOR_MODE ?? "").toLowerCase() === "paragraph") {
    return enforceBannedTermsByParagraph({ text: params.text, bannedTerms, systemPrompt: params.systemPrompt });
  }
  const primary = params.primary ?? sonnetRewriter;
  const fallback = params.fallback === undefined ? hanamiRewriter(params.systemPrompt) : params.fallback;

  const paragraphs = splitIntoParagraphs(params.text);
  const corrections: ParagraphCorrection[] = [];

  for (let p = 0; p < paragraphs.length; p++) {
    const originalParagraph = paragraphs[p] ?? "";
    if (findAllBannedSpans(originalParagraph, bannedTerms).length === 0) continue;
    let paragraph = originalParagraph;
    const spots: SpotFix[] = [];
    // Fix one sentence at a time, re-splitting after each fix so offsets stay right.
    for (let guard = 0; guard < 50; guard++) {
      const sentences = splitSentences(paragraph);
      const idx = sentences.findIndex(
        (s) => findAllBannedSpans(paragraph.slice(s.start, s.end), bannedTerms).length > 0 && !spots.some((f) => !f.resolved && paragraph.slice(s.start, s.end).trim() === f.sentenceBefore.trim())
      );
      if (idx === -1) break;
      const s = sentences[idx]!;
      const { replacement, fix } = await fixSpot({ text: paragraph, sentence: s, sentences, index: idx, bannedTerms, primary, fallback });
      spots.push(fix);
      paragraph = paragraph.slice(0, s.start) + replacement + paragraph.slice(s.end);
    }
    paragraphs[p] = paragraph;
    corrections.push({
      paragraphIndex: p,
      originalText: originalParagraph,
      finalText: paragraph,
      bannedTermsFound: [...new Set(spots.flatMap((f) => f.termsFound))],
      attempts: spots.reduce((n, f) => n + f.attempts, 0),
      resolved: spots.every((f) => f.resolved),
      diff: diffDrafts(originalParagraph, paragraph),
      spots,
    });
  }

  return { finalText: paragraphs.join("\n\n"), corrections };
}

// ---------------------------------------------------------------------------
// The previous behaviour: regenerate the whole paragraph with Hanami. Kept
// behind GHOST_EDITOR_MODE=paragraph as a switch-back, not the default.
// ---------------------------------------------------------------------------

function buildParagraphPrompt(params: { before: string | null; paragraph: string; after: string | null; bannedTerms: string[] }): string {
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

async function enforceBannedTermsByParagraph(params: { text: string; bannedTerms: string[]; systemPrompt: string }): Promise<GhostEditorResult> {
  const { bannedTerms, systemPrompt } = params;
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
      const prompt = buildParagraphPrompt({
        before: i > 0 ? (paragraphs[i - 1] ?? null) : null,
        paragraph: current,
        after: i < paragraphs.length - 1 ? (paragraphs[i + 1] ?? null) : null,
        bannedTerms: matches.map((m) => m.term),
      });
      current = (await generateHanamiProse(systemPrompt, prompt)).trim();
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
