import { getSupabaseClient } from "../lib/supabaseClient.js";
import { textMentionsAnyOf } from "../lib/textMatch.js";

// The manuscript-first gate. The author's rulings (26 Nov): manuscript-context
// "exists to only force Claude or any subagents to always seek context first
// from the Manuscript before doing anything at all"; an agent "would query the
// system on anything mentioned for the context it needs"; "if it can't find a
// name in codex, it goes to the Manuscript. The manuscript is always the
// source of truth."
//
// So: the read tools log every lookup (recordManuscriptRead), and before an
// action (sending a beat to Hanami, saving, starting a draft session,
// requesting reviews) the backend takes every proper name from the text being
// acted on and refuses until each has a recent manuscript lookup on record,
// naming the ones still missing. The Codex only adds aliases; it is not the
// list of what counts. Honest limits: the backend proves an agent ASKED, not
// that it read the answer; and an unnamed object or event ("the feast") can't
// be detected by a name scan, which is the gatekeeper's job.

export const READ_WINDOW_HOURS = 6;
const MAX_EXISTENCE_CHECKS = 15;

export function isManuscriptFirstEnabled(): boolean {
  return (process.env.MANUSCRIPT_FIRST ?? "on").toLowerCase() !== "off";
}

// ---------------------------------------------------------------------------
// Recording lookups (never throws: a failed log must not break a read).
// ---------------------------------------------------------------------------

export async function recordManuscriptRead(params: {
  bookId: string;
  tool: "search_manuscript" | "get_manuscript_chapter" | "get_codex_entry";
  query?: string | null;
  chapterNumber?: number | null;
  entryName?: string | null;
}): Promise<void> {
  try {
    const { error } = await getSupabaseClient()
      .from("manuscript_reads")
      .insert({ book_id: params.bookId, tool: params.tool, query: params.query ?? null, chapter_number: params.chapterNumber ?? null, entry_name: params.entryName ?? null });
    if (error) console.error("manuscript read log failed:", error.message);
  } catch (err) {
    console.error("manuscript read log failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Names in a text.
// ---------------------------------------------------------------------------

// Capitalised words that are not character or place names in this book's
// prose or in a Claude-compiled prompt (labels like "Narrator:", rules like
// "Never use…", titles, directions).
const NOT_NAMES = new Set(
  (
    "i i'm i'd i'll i've a an the he she it they we you his her their our your my its this that these those there here when then but and or so if as in on at for with after before still even no yes not only once now all some someone nobody nothing everyone every each what why how where who which while until because though although just maybe perhaps " +
    "north south east west northern southern northerner northerners southerner southerners eastern western alpha alphas luna lunas lycan lycans king queen prince princess lord lady sir god gods goddess moon mother father mom dad " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december " +
    "chapter narrator story continue rules facts fact place time pov off never do don't keep write give let show make use past present first third person tense stop note colour color beat scene context hanami claude english"
  ).split(" ")
);

function segments(text: string): string[] {
  // Sentence ends, line breaks and colons all start a new segment, so a
  // label ("Narrator: Jace") and dialogue openings count as sentence starts.
  return text.split(/(?<=[.!?…:;])\s+|\n+|(?<=["“”])\s*(?=\p{Lu})/u).filter((s) => s.trim());
}

export interface NameCandidates {
  // Capitalised mid-sentence somewhere in the text: names.
  names: string[];
  // Capitalised only where a sentence starts ("Kill me quick", but also
  // "Josie turned"): the manuscript decides (see checkManuscriptFirst).
  initialOnly: string[];
}

export function extractNameCandidates(text: string): NameCandidates {
  const normalized = text.replace(/[’‘]/g, "'");
  const initial = new Set<string>();
  const mid = new Set<string>();
  for (const seg of segments(normalized)) {
    const words = seg.match(/[\p{L}']+/gu) ?? [];
    let i = 0;
    while (i < words.length) {
      const w = words[i]!;
      const isCap = /^\p{Lu}/u.test(w) && !(w.length > 1 && w === w.toUpperCase());
      if (!isCap || NOT_NAMES.has(w.replace(/'s$/, "").toLowerCase())) {
        i++;
        continue;
      }
      // Join consecutive capitalised words into one name ("Great Hall").
      const start = i;
      const parts: string[] = [];
      while (i < words.length && /^\p{Lu}/u.test(words[i]!) && !NOT_NAMES.has(words[i]!.replace(/'s$/, "").toLowerCase())) {
        parts.push(words[i]!.replace(/'s$/, ""));
        i++;
      }
      const name = parts.join(" ");
      if (name.length < 2) continue;
      (start === 0 ? initial : mid).add(name);
    }
  }
  return { names: [...mid].sort(), initialOnly: [...initial].filter((n) => !mid.has(n) && !/(ing|ed|ly)$/.test(n) && !n.includes("'")).sort() };
}

// Kept for callers that only want the certain names.
export function extractProperNames(text: string): string[] {
  return extractNameCandidates(text).names;
}

// ---------------------------------------------------------------------------
// The check.
// ---------------------------------------------------------------------------

export interface ManuscriptFirstResult {
  ok: boolean;
  names: string[];
  missing: string[];
  // Missing names the manuscript has never mentioned at all (possibly
  // invented by Hanami, or new): reported so the author is asked.
  notInManuscript: string[];
}

interface CodexRow {
  name: string;
  aliases: string[] | null;
}

interface ReadRow {
  tool: string;
  query: string | null;
  entry_name: string | null;
}

export interface ManuscriptFirstDeps {
  codex?: (bookId: string) => Promise<CodexRow[]>;
  recentReads?: (bookId: string, sinceIso: string) => Promise<ReadRow[]>;
  existsInManuscript?: (bookId: string, name: string) => Promise<boolean>;
  // Does the manuscript use this word capitalised in mid-sentence anywhere
  // (i.e. as a name)? Resolves words the text only capitalises at sentence starts.
  usedAsNameInManuscript?: (bookId: string, word: string) => Promise<boolean>;
  now?: () => number;
}

async function codexDefault(bookId: string): Promise<CodexRow[]> {
  const { data, error } = await getSupabaseClient().from("codex_entries").select("name, aliases").eq("book_id", bookId);
  if (error) throw new Error(`Failed to read Codex: ${error.message}`);
  return (data ?? []) as CodexRow[];
}

async function recentReadsDefault(bookId: string, sinceIso: string): Promise<ReadRow[]> {
  const { data, error } = await getSupabaseClient()
    .from("manuscript_reads")
    .select("tool, query, entry_name")
    .eq("book_id", bookId)
    .gte("created_at", sinceIso)
    .limit(5000);
  if (error) throw new Error(`Failed to read the manuscript lookup log: ${error.message}`);
  return (data ?? []) as ReadRow[];
}

const MAX_INITIAL_CHECKS = 25;

async function usedAsNameDefault(bookId: string, word: string): Promise<boolean> {
  const safe = word.replace(/[^\p{L} ']/gu, "");
  if (!safe) return false;
  // Postgres regex: a lowercase letter or comma, a space, then the word.
  const { data, error } = await getSupabaseClient()
    .from("manuscript_chunks")
    .select("id")
    .eq("book_id", bookId)
    .filter("raw_text", "match", `[a-z,;] ${safe}\\M`)
    .limit(1);
  if (error) return false;
  return (data ?? []).length > 0;
}

async function existsDefault(bookId: string, name: string): Promise<boolean> {
  const { data, error } = await getSupabaseClient()
    .from("manuscript_chunks")
    .select("id")
    .eq("book_id", bookId)
    .ilike("raw_text", `%${name.replace(/[%_]/g, "")}%`)
    .limit(1);
  if (error) return true; // can't tell: don't claim it's absent
  return (data ?? []).length > 0;
}

export async function checkManuscriptFirst(params: { bookId: string; text: string }, deps: ManuscriptFirstDeps = {}): Promise<ManuscriptFirstResult> {
  const codexRows = await (deps.codex ?? codexDefault)(params.bookId);
  const candidates = extractNameCandidates(params.text);
  const names = new Set(candidates.names);
  const usedAsName = deps.usedAsNameInManuscript ?? usedAsNameDefault;
  for (const word of candidates.initialOnly.slice(0, MAX_INITIAL_CHECKS)) {
    if (await usedAsName(params.bookId, word)) names.add(word);
  }
  // Codex entries named in the text (by name or alias) count even when the
  // name only ever opens a sentence; their aliases also satisfy a lookup.
  const groups = new Map<string, string[]>();
  for (const e of codexRows) {
    const all = [e.name, ...(e.aliases ?? [])].filter(Boolean);
    if (textMentionsAnyOf(params.text, all)) {
      names.add(e.name);
      groups.set(e.name, all);
      for (const a of all) if (names.has(a) && a !== e.name) names.delete(a);
    }
  }

  const now = (deps.now ?? Date.now)();
  const since = new Date(now - READ_WINDOW_HOURS * 3600 * 1000).toISOString();
  const reads = await (deps.recentReads ?? recentReadsDefault)(params.bookId, since);
  const queries = reads.map((r) => (r.query ?? "").toLowerCase());
  const entries = new Set(reads.map((r) => (r.entry_name ?? "").toLowerCase()).filter(Boolean));

  const missing: string[] = [];
  for (const name of [...names].sort()) {
    const forms = (groups.get(name) ?? [name]).map((f) => f.toLowerCase());
    const looked = forms.some((f) => entries.has(f) || queries.some((q) => q.includes(f)));
    if (!looked) missing.push(name);
  }

  const exists = deps.existsInManuscript ?? existsDefault;
  const notInManuscript: string[] = [];
  for (const name of missing.slice(0, MAX_EXISTENCE_CHECKS)) {
    if (groups.has(name)) continue; // a Codex entry exists, so it's known
    if (!(await exists(params.bookId, name))) notInManuscript.push(name);
  }
  return { ok: missing.length === 0, names: [...names].sort(), missing, notInManuscript };
}

export function describeManuscriptFirstRefusal(action: string, r: ManuscriptFirstResult): string {
  const lines = [
    `Refused: ${action} needs the manuscript consulted first. The manuscript is always the source of truth.`,
    `Not yet looked up in the manuscript (within the last ${READ_WINDOW_HOURS} hours): ${r.missing.join(", ")}.`,
    `Call search_manuscript for each (or get_codex_entry for a Codex entry), read what comes back, then retry.`,
  ];
  if (r.notInManuscript.length) {
    lines.push(
      `Note: ${r.notInManuscript.join(", ")} appear(s) nowhere in the manuscript. If that's a new character or place, confirm it with the author first; if it came from a Hanami draft, it may be invented.`
    );
  }
  return lines.join("\n");
}

// One call for the action tools: returns an error message to refuse with, or
// null to proceed.
export async function manuscriptFirstRefusal(action: string, bookId: string, text: string, deps: ManuscriptFirstDeps = {}): Promise<string | null> {
  if (!isManuscriptFirstEnabled()) return null;
  const r = await checkManuscriptFirst({ bookId, text }, deps);
  return r.ok ? null : describeManuscriptFirstRefusal(action, r);
}
