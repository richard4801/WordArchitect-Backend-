import { generateHanamiProse } from "./llm.js";
import { diffDrafts, type TextDiffResult } from "../lib/textDiff.js";
import { MAX_REGENERATION_ATTEMPTS } from "./ghostEditor.js";
import { describeNarration, type NarrationSetting } from "../lib/narration.js";

// Verify-then-regenerate enforcement of a book's narration switch (point of
// view + tense), built on the same pattern Ghost Editor already established
// for banned terms: detect in already-generated text, rewrite only the
// offending paragraph with a narrowly scoped call, re-check, retry up to
// MAX_REGENERATION_ATTEMPTS, and report honestly if it never resolved.
//
// The detector is a deterministic HEURISTIC, not a grammar parser. It is
// deliberately conservative: it only flags a paragraph when several clauses
// are in the wrong tense, so a single stray present-tense thought inside past
// narration does not trigger a rewrite. It will miss subtle slips and can
// misjudge unusual prose; the NARRATION_ENFORCEMENT=off env var turns the
// verify step off without touching the prompt wording.

export type NarrationProblem = "tense" | "pov";

// Corrective calls run cooler than the creative default (1.3): a rewrite that
// must follow a rule exactly is the opposite of the job high temperature is
// for, and testing showed lower temperatures follow format rules more
// reliably.
const REWRITE_TEMPERATURE = 0.85;

// Below this many narration words a paragraph has too little to judge.
const MIN_PARAGRAPH_WORDS = 12;
// A whole generation with at least this many narration words and no
// first-person pronoun at all is not first-person narration.
// Set high enough that a single short paragraph — the way a supervised
// session usually calls Hanami — can't trip it: a 60-word paragraph of pure
// scene description can legitimately contain no "I".
const MIN_TEXT_WORDS_FOR_POV = 100;

// ---------- dialogue stripping ----------

// Quoted speech may legitimately use any tense/person, so it is removed
// before analysis. Handles straight and curly double quotes, and an
// unterminated opening quote (drops to the end of the paragraph).
export function stripDialogue(text: string): string {
  let out = text.replace(/“[^”]*”/g, " ").replace(/"[^"]*"/g, " ");
  out = out.replace(/[“"][^”"]*$/g, " ");
  return out;
}

// ---------- lexicons ----------

const SUBJECTS = new Set(["i", "he", "she", "it", "we", "they", "you"]);

const SKIP_ADVERBS = new Set([
  "just", "still", "never", "also", "even", "only", "always", "now", "then", "not", "hardly",
  "barely", "almost", "simply", "already", "soon", "once", "again", "really", "quite", "too",
]);

// Contractions that are subject + present-tense verb in a single token.
const PRESENT_CONTRACTIONS = new Set([
  "i'm", "i've", "i'll", "you're", "we're", "they're", "he's", "she's", "it's",
]);

const PAST_IRREGULAR = new Set([
  "was", "were", "had", "did", "said", "went", "saw", "knew", "took", "came", "made", "got", "gave",
  "found", "thought", "told", "felt", "left", "kept", "stood", "held", "ran", "began", "became",
  "sat", "fell", "heard", "brought", "wrote", "spoke", "broke", "chose", "drew", "drove", "ate",
  "flew", "forgot", "grew", "hid", "lay", "lost", "met", "paid", "rose", "sent", "shook", "sang",
  "slept", "spent", "struck", "swam", "threw", "understood", "woke", "wore", "won", "caught",
  "bought", "built", "dug", "fought", "hung", "laid", "led", "lit", "meant", "rode", "rang", "sold",
  "shot", "slid", "sprang", "swept", "taught", "tore", "wept", "wound", "stole", "bit", "blew",
  "dove", "fled", "froze", "ground", "knelt", "leapt", "swore", "swung", "sank", "sought", "smelt",
  "couldn't", "wouldn't", "didn't", "wasn't", "weren't", "hadn't", "shouldn't",
]);

const PRESENT_FORMS = new Set([
  "am", "is", "are", "has", "have", "do", "does", "don't", "doesn't", "can", "can't", "cannot",
  "will", "won't", "shall", "isn't", "aren't", "hasn't", "haven't",
]);

// Words ending in "-ed" that are not past-tense verbs after a subject.
const NOT_PAST_ED = new Set([
  "need", "bed", "red", "shed", "seed", "speed", "feed", "bleed", "breed", "proceed", "succeed",
  "exceed", "indeed",
]);

// Common narration verbs, base form. Verbs whose past and present are
// identical (read, put, cut, set, hit, let, hurt, shut, cost, burst, spread,
// quit, beat) are deliberately left out — they cannot be classified.
const BASE_VERBS = new Set([
  "see", "hear", "watch", "look", "feel", "know", "think", "walk", "stand", "wait", "turn", "take",
  "run", "step", "reach", "hold", "pull", "push", "move", "breathe", "swallow", "listen", "wonder",
  "notice", "smell", "taste", "touch", "grab", "open", "close", "lift", "drop", "fall", "sit", "stay",
  "keep", "try", "want", "need", "hope", "fear", "pray", "say", "tell", "ask", "call", "shout",
  "whisper", "nod", "shake", "shrug", "laugh", "smile", "cry", "scream", "stare", "glance", "blink",
  "freeze", "flinch", "tense", "clench", "bite", "lean", "bend", "kneel", "climb", "jump", "follow",
  "find", "give", "get", "go", "come", "leave", "stop", "start", "begin", "continue", "remember",
  "forget", "understand", "decide", "choose", "wish", "force", "press", "strike", "kick", "throw",
  "catch", "carry", "bring", "hang", "cover", "hide", "seek", "search", "trust", "believe", "mean",
  "love", "hate", "miss", "seem", "appear", "become", "sleep", "wake", "rise", "pause", "hesitate",
  "wipe", "rub", "scratch", "slide", "drag", "stumble", "cough", "gasp", "sigh", "mutter", "murmur",
  "speak", "answer", "reply", "pretend", "imagine", "guess", "suppose", "agree", "refuse", "accept",
  "share", "learn", "stand", "lie", "bleed", "drip", "spill", "flow", "burn", "shiver", "tremble",
]);

function thirdSingular(v: string): string {
  if (v === "go") return "goes";
  if (v === "do") return "does";
  if (v === "have") return "has";
  if (/(s|x|z|ch|sh|o)$/.test(v)) return `${v}es`;
  if (/[^aeiou]y$/.test(v)) return `${v.slice(0, -1)}ies`;
  return `${v}s`;
}
const THIRD_SG = new Set([...BASE_VERBS].map(thirdSingular));

// A subject pronoun right after one of these is an inverted question or a
// conditional ("where would they start?", "did he know?"), not a plain
// clause, so its tense says nothing about the narration's tense.
const AUX_BEFORE_SUBJECT = new Set([
  "would", "could", "should", "might", "must", "will", "shall", "can", "may", "did", "do", "does",
  "is", "are", "was", "were", "had", "has", "have", "if", "that", "whether",
]);

type VerbKind = "past" | "present" | null;

function classifyVerb(subject: string, word: string): VerbKind {
  if (PAST_IRREGULAR.has(word)) return "past";
  if (PRESENT_FORMS.has(word)) return "present";
  const subjectIsSingular3 = subject === "he" || subject === "she" || subject === "it";
  if (subjectIsSingular3) {
    if (THIRD_SG.has(word)) return "present";
  } else if (BASE_VERBS.has(word)) {
    return "present";
  }
  if (word.length >= 4 && word.endsWith("ed") && !NOT_PAST_ED.has(word)) return "past";
  return null;
}

export interface TenseCounts {
  present: number;
  past: number;
}

// Counts clauses anchored on a subject pronoun, classified by the verb right
// after it (skipping up to two adverbs). Anchoring on pronouns keeps this
// precise — it never tries to find verbs anywhere in a sentence — at the cost
// of ignoring clauses whose subject is a name or a noun.
export function countTenseClauses(narration: string): TenseCounts {
  const tokens = narration.toLowerCase().replace(/’/g, "'").match(/[a-z]+(?:'[a-z]+)*/g) ?? [];
  let present = 0;
  let past = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (PRESENT_CONTRACTIONS.has(token)) {
      present += 1;
      continue;
    }
    if (!SUBJECTS.has(token)) continue;
    if (i > 0 && AUX_BEFORE_SUBJECT.has(tokens[i - 1] as string)) continue;

    let j = i + 1;
    let skipped = 0;
    while (j < tokens.length && skipped < 2 && (SKIP_ADVERBS.has(tokens[j] as string) || (tokens[j] as string).endsWith("ly"))) {
      j += 1;
      skipped += 1;
    }
    const next = tokens[j];
    if (!next) continue;
    const kind = classifyVerb(token, next);
    if (kind === "present") present += 1;
    else if (kind === "past") past += 1;
  }
  return { present, past };
}

// First-person pronouns in narration (dialogue already stripped).
export function countFirstPerson(narration: string): number {
  const matches = narration.match(/\bI(?:['’](?:m|d|ll|ve))?\b|\b(?:[Mm]e|[Mm]y|[Mm]ine|[Mm]yself)\b/g);
  return matches ? matches.length : 0;
}

function wordCount(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

// ---------- analysis ----------

export interface ParagraphAnalysis {
  narrationWords: number;
  firstPerson: number;
  tense: TenseCounts;
  problems: NarrationProblem[];
}

function tenseProblem(counts: TenseCounts, setting: NarrationSetting): boolean {
  const wrong = setting.tense === "past" ? counts.present : counts.past;
  const right = setting.tense === "past" ? counts.past : counts.present;
  return wrong >= 2 && wrong / (wrong + right) > 0.5;
}

export function analyzeParagraph(paragraph: string, setting: NarrationSetting): ParagraphAnalysis {
  const narration = stripDialogue(paragraph);
  const narrationWords = wordCount(narration);
  const firstPerson = countFirstPerson(narration);
  const tense = countTenseClauses(narration);
  const problems: NarrationProblem[] = [];

  if (narrationWords >= MIN_PARAGRAPH_WORDS) {
    if (tenseProblem(tense, setting)) problems.push("tense");
    // In third person, any first-person narration is a slip. (In first
    // person the opposite check — "no I at all" — only makes sense over the
    // whole text, see isPovMissing, since a single paragraph of pure scene
    // description can legitimately have no "I".)
    if (setting.pov === "third" && firstPerson >= 2) problems.push("pov");
  }
  return { narrationWords, firstPerson, tense, problems };
}

// True when a whole generation claims to be first person but never uses a
// first-person pronoun outside dialogue.
export function isPovMissing(text: string, setting: NarrationSetting): boolean {
  if (setting.pov !== "first") return false;
  const narration = stripDialogue(text);
  return wordCount(narration) >= MIN_TEXT_WORDS_FOR_POV && countFirstPerson(narration) === 0;
}

function splitIntoParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/);
}

// ---------- enforcement ----------

export interface NarrationCorrection {
  // -1 means the whole generation was regenerated (wrong point of view
  // throughout), not a single paragraph.
  paragraphIndex: number;
  problems: NarrationProblem[];
  originalText: string;
  finalText: string;
  attempts: number;
  resolved: boolean;
  diff: TextDiffResult;
}

export interface NarrationEditorResult {
  finalText: string;
  corrections: NarrationCorrection[];
}

function buildRewritePrompt(params: {
  before: string | null;
  paragraph: string;
  after: string | null;
  setting: NarrationSetting;
}): string {
  const { setting } = params;
  const parts = [
    `Rewrite ONLY the paragraph marked "PARAGRAPH TO REWRITE" below so its narration is entirely in ${describeNarration(setting)}.`,
    setting.pov === "first"
      ? 'The narrator is the point-of-view character and says "I".'
      : "Never use I, me or my in the narration outside dialogue.",
    "Keep every event, detail and the approximate length. Do not add or remove content. Text inside quotation marks stays exactly as it is.",
    "The surrounding paragraphs are context only. Do not rewrite or repeat them.",
    "Respond with ONLY the rewritten paragraph. No preamble, no explanation.",
    "",
  ];
  if (params.before) parts.push("--- PRECEDING PARAGRAPH (context only) ---", params.before, "");
  parts.push("--- PARAGRAPH TO REWRITE ---", params.paragraph, "");
  if (params.after) parts.push("--- FOLLOWING PARAGRAPH (context only) ---", params.after, "");
  return parts.join("\n");
}

// Verifies a finished generation against the book's narration switch and
// repairs it. Two passes: (1) a first-person book whose text never says "I"
// is regenerated whole, since the entire piece is wrong; (2) each paragraph
// with a tense (or, in third person, a point-of-view) slip is rewritten on
// its own with a bounded retry loop. Anything still wrong after
// MAX_REGENERATION_ATTEMPTS is returned as-is and flagged resolved:false —
// never reported as fixed.
export async function enforceNarration(params: {
  text: string;
  setting: NarrationSetting;
  systemPrompt: string;
  userMessage: string;
}): Promise<NarrationEditorResult> {
  const { setting, systemPrompt, userMessage } = params;
  const corrections: NarrationCorrection[] = [];
  let text = params.text;

  if (isPovMissing(text, setting)) {
    const original = text;
    let attempts = 0;
    while (isPovMissing(text, setting) && attempts < MAX_REGENERATION_ATTEMPTS) {
      attempts += 1;
      const retry = await generateHanamiProse(
        systemPrompt,
        `${userMessage}\n\nIMPORTANT: write this in ${describeNarration(setting)}. The narrator is the point-of-view character and says "I".`,
        REWRITE_TEMPERATURE
      );
      if (retry.trim() !== "") text = retry;
    }
    corrections.push({
      paragraphIndex: -1,
      problems: ["pov"],
      originalText: original,
      finalText: text,
      attempts,
      resolved: !isPovMissing(text, setting),
      diff: diffDrafts(original, text),
    });
  }

  const paragraphs = splitIntoParagraphs(text);
  for (let i = 0; i < paragraphs.length; i++) {
    const original = paragraphs[i] ?? "";
    let analysis = analyzeParagraph(original, setting);
    if (analysis.problems.length === 0) continue;

    const foundProblems = [...analysis.problems];
    let current = original;
    let attempts = 0;

    while (analysis.problems.length > 0 && attempts < MAX_REGENERATION_ATTEMPTS) {
      attempts += 1;
      const rewritten = (
        await generateHanamiProse(
          systemPrompt,
          buildRewritePrompt({
            before: i > 0 ? (paragraphs[i - 1] ?? null) : null,
            paragraph: current,
            after: i < paragraphs.length - 1 ? (paragraphs[i + 1] ?? null) : null,
            setting,
          }),
          REWRITE_TEMPERATURE
        )
      ).trim();
      if (rewritten === "") continue;
      current = rewritten;
      analysis = analyzeParagraph(current, setting);
    }

    paragraphs[i] = current;
    corrections.push({
      paragraphIndex: i,
      problems: foundProblems,
      originalText: original,
      finalText: current,
      attempts,
      resolved: analysis.problems.length === 0,
      diff: diffDrafts(original, current),
    });
  }

  return { finalText: paragraphs.join("\n\n"), corrections };
}
