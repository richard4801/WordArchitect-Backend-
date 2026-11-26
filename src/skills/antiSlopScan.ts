// Deterministic half of skill 07 (anti-slop): a free regex scan for the
// phrases research shows are over-used in machine-made and formula prose
// (docs/skill-research/07_anti-slop.md: the Antislop paper's over-used list,
// Wikipedia's "Signs of AI writing" word list, and the brief's own
// outline-level search list). A hit is a place to look, not proof: people
// wrote every one of these first. The LLM reviewer gets these hits as
// evidence and decides whether they are clustered or standing in for a
// specific detail.

export interface SlopPattern {
  id: string;
  label: string;
  pattern: RegExp;
  // "prose" patterns are stock figures in narration; "analysis" patterns are
  // inflated summary words that matter most in outlines and plans.
  kind: "prose" | "analysis" | "shape";
}

export const SLOP_PATTERNS: SlopPattern[] = [
  { id: "flicker", label: "flicker(ed) across/in", pattern: /\bflicker(?:ed|ing|s)?\b/gi, kind: "prose" },
  { id: "barely_whisper", label: "voice barely above a whisper", pattern: /\bbarely (?:above )?a whisper\b/gi, kind: "prose" },
  { id: "deep_breath", label: "took a deep breath", pattern: /\b(?:took|take|taking|drew|draw) a (?:deep|steadying|shaky|shuddering) breath\b/gi, kind: "prose" },
  { id: "eyes_never_leaving", label: "eyes never leaving", pattern: /\beyes never (?:leaving|left)\b/gi, kind: "prose" },
  { id: "breath_didnt_know", label: "breath I didn't know I was holding", pattern: /\bbreath (?:I|she|he|they) (?:didn'?t|did not) know\b/gi, kind: "prose" },
  { id: "every_fibre", label: "every fibre of my being", pattern: /\bevery fib(?:re|er) of (?:my|her|his|their) being\b/gi, kind: "prose" },
  { id: "pulse_roared", label: "pulse/blood roared in my ears", pattern: /\b(?:pulse|blood|heart(?:beat)?) (?:roared|pounded|thundered) in (?:my|her|his|their) ears\b/gi, kind: "prose" },
  { id: "see_through_me", label: "eyes that seemed to see right through me", pattern: /\bsee (?:right )?through (?:me|her|him)\b/gi, kind: "prose" },
  { id: "eternity", label: "after an eternity / what felt like an eternity", pattern: /\b(?:after|for) (?:what felt like )?an eternity\b/gi, kind: "prose" },
  { id: "eyes_darkened", label: "eyes darkened", pattern: /\beyes (?:darkened|darkening|went dark)\b/gi, kind: "prose" },
  { id: "growled_mine", label: "growled \"Mine\"", pattern: /["“]\s*mine[.!]?\s*["”]/gi, kind: "prose" },
  { id: "electric", label: "electric / electricity / crackled", pattern: /\b(?:electric(?:ity)?|crackl(?:e|ed|ing))\b/gi, kind: "prose" },
  { id: "something_shifted", label: "something shifted", pattern: /\bsomething (?:shifted|changed|broke) (?:between|inside|in)\b/gi, kind: "prose" },
  { id: "never_the_same", label: "nothing would ever be the same", pattern: /\b(?:nothing|things|life) would (?:ever|never) be the same\b/gi, kind: "shape" },
  { id: "not_x_but_y", label: "\"not X, it's Y\" / \"not just X but Y\"", pattern: /\b(?:it'?s|it was|this was|this is) not (?:just )?[^.,;!?]{1,40}[,;—-]+\s*(?:it'?s|it was|but)\b|\bnot only\b[^.]{1,60}\bbut also\b/gi, kind: "shape" },
  { id: "pivotal", label: "pivotal", pattern: /\bpivotal\b/gi, kind: "analysis" },
  { id: "palpable", label: "palpable", pattern: /\bpalpable\b/gi, kind: "analysis" },
  { id: "visceral", label: "visceral", pattern: /\bvisceral\b/gi, kind: "analysis" },
  { id: "tapestry", label: "tapestry", pattern: /\btapestr(?:y|ies)\b/gi, kind: "analysis" },
  { id: "testament", label: "testament to", pattern: /\btestament to\b/gi, kind: "analysis" },
  { id: "underscores", label: "underscores", pattern: /\bunderscor(?:es|ed|ing)\b/gi, kind: "analysis" },
  { id: "highlighting", label: "trailing \"highlighting / underscoring / showcasing\"", pattern: /,\s*(?:highlighting|underscoring|showcasing|emphasizing|emphasising|signaling|signalling|reflecting)\b/gi, kind: "analysis" },
  { id: "sets_stage", label: "sets the stage", pattern: /\bset(?:s|ting)? the stage\b/gi, kind: "analysis" },
  { id: "deepens", label: "deepens (their bond / the tension)", pattern: /\bdeepen(?:s|ed|ing)? (?:their|the|her|his) (?:bond|connection|tension|stakes|relationship)\b/gi, kind: "analysis" },
  { id: "tension_rises", label: "tension rises / stakes rise", pattern: /\b(?:tension|stakes) (?:rise|rises|rising|escalate|escalates|mount|mounts)\b/gi, kind: "analysis" },
  { id: "everything_changes", label: "everything changes", pattern: /\beverything (?:changes|changed)\b/gi, kind: "shape" },
  { id: "evolving", label: "evolving dynamic / landscape", pattern: /\bevolving (?:dynamic|landscape|relationship)\b/gi, kind: "analysis" },
];

export interface SlopHit {
  id: string;
  label: string;
  kind: SlopPattern["kind"];
  count: number;
  // Up to 3 short snippets (about 10 words) around the matches.
  examples: string[];
}

export interface SlopScanResult {
  wordCount: number;
  totalHits: number;
  // Hits per 1,000 words, prose-kind only (analysis words in an outline are
  // judged separately by the reviewer).
  proseHitsPer1000: number;
  hits: SlopHit[];
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const raw = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${raw}${end < text.length ? "…" : ""}`;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function scanForSlop(text: string): SlopScanResult {
  const hits: SlopHit[] = [];
  for (const p of SLOP_PATTERNS) {
    const re = new RegExp(p.pattern.source, p.pattern.flags);
    const examples: string[] = [];
    let count = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      count++;
      if (examples.length < 3) examples.push(snippetAround(text, m.index, m[0].length));
      if (m[0].length === 0) re.lastIndex++;
    }
    if (count > 0) hits.push({ id: p.id, label: p.label, kind: p.kind, count, examples });
  }
  const wordCount = countWords(text);
  const proseHits = hits.filter((h) => h.kind !== "analysis").reduce((s, h) => s + h.count, 0);
  return {
    wordCount,
    totalHits: hits.reduce((s, h) => s + h.count, 0),
    proseHitsPer1000: wordCount > 0 ? Math.round((proseHits / wordCount) * 10000) / 10 : 0,
    hits: hits.sort((a, b) => b.count - a.count),
  };
}

// One-line note for tool responses (generate_prose_direct). Empty when clean.
export function formatSlopScanNote(scan: SlopScanResult): string {
  if (scan.hits.length === 0) return "";
  const list = scan.hits
    .slice(0, 8)
    .map((h) => `${h.label} ×${h.count}`)
    .join("; ");
  return `[Anti-slop phrase scan (free, regex, not a verdict): ${scan.totalHits} hit(s) — ${list}. Each marks a place where a specific detail may be missing. The full anti-slop review runs in run_skill_review before this text can be saved.]`;
}
