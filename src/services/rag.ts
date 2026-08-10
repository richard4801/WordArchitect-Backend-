import { getSupabaseClient } from "../lib/supabaseClient.js";
import { estimateTokens, truncateToTokenBudget } from "../lib/tokenBudget.js";
import { textMentionsAnyOf } from "../lib/textMatch.js";
import { generateEmbedding } from "./embedding.js";
import { expandSceneBeatConcepts } from "./queryExpansion.js";
import type { CodexEntry, ManuscriptChunkMatch } from "../types/domain.js";

// The hard ceiling from CLAUDE.md's Strict Context Boundary: Layer 1 + 2 +
// 3 + scaffolding must stay under this. Layers used to have fixed
// sub-budgets (800/2000/1000) regardless of whether earlier layers
// actually used theirs, which routinely left hundreds of tokens unused
// instead of going to Layer 3 — the difference between a full chapter of
// context and one isolated fragment. Layer 3 now gets whatever's left
// after Layer 1/2/scaffolding, not a fixed slice.
// Raised from 4,000 to 6,000 based on real usage against a live 172-chapter
// book: a realistic "continue writing" beat with pasted recent history was
// landing at 4,095-4,096/4,100 — maxed out — and squeezing a second
// relevant chapter down to ~100 tokens purely because the budget ran out,
// not because it was less relevant. Still leaves ~26,000 tokens of
// headroom in Hanami's 32k window for the actual generated chapter.
const TOTAL_TOKEN_BUDGET = 6000;
// It's fine to land slightly over budget rather than leave it unused —
// not fine to blow past this by more than a small margin.
const BUDGET_TOLERANCE_TOKENS = 100;
const SECTION_SEPARATOR = "\n\n---\n\n";

// Per-chapter instructions (entered fresh before each generation, not
// saved) sit above every retrieval layer in priority — see
// buildChapterInstructionsSection below. Capped so an unusually long
// do/avoid list can't eat the entire 6,100-token ceiling and starve
// Codex/History/RAG outright; this is meant for a handful of concrete
// directives for the chapter about to be written, not a full style guide.
const CHAPTER_INSTRUCTIONS_TOKEN_BUDGET = 500;

const LAYER1_TOKEN_BUDGET = 800;
const LAYER2_MAX_WORDS = 2000;
const LAYER2_TOKEN_BUDGET = 2000;
// Was 0.5, picked with no real calibration behind it. A stress test against
// real manuscript content found genuinely relevant matches scoring 0.33-0.37
// and getting wrongly excluded — 0.5 was simply too strict for short
// beat-to-prose comparisons on this embedding model. Lowered based on that
// evidence, not just a guess.
const LAYER3_MATCH_THRESHOLD = 0.3;
// Each extracted concept gets its own search for this many nearest chunks —
// not one shared top-N across the whole beat, which would let one concept
// (e.g. "pregnancy") crowd out another (e.g. "totem") in a single search.
const LAYER3_MATCH_COUNT_PER_CONCEPT = 3;
// Estimated cost of a "### Memory N — Chapter X (best match similarity:
// 0.000)\n" header line, reserved before expanding a chapter's content so
// the header itself doesn't push a block over budget unaccounted-for.
const MEMORY_HEADER_TOKENS_ESTIMATE = 20;

export interface AssembleContextParams {
  userId: string;
  bookId: string;
  userSceneBeat: string;
  recentHistoryText: string;
  // Fresh, per-generation directives for the chapter about to be written —
  // entered in the Generate Prose form, not saved anywhere. Distinct
  // do/avoid fields rather than one free-text block so a negative
  // constraint ("don't reveal the pregnancy yet") is structurally
  // unambiguous rather than buried in prose Hanami might read as
  // description instead of a rule.
  chapterInstructions?: string;
  chapterAvoid?: string;
  // Tokens already spoken for outside Layer 1/2/3 — i.e. the system
  // prompt's fixed instructional scaffolding, which the caller owns
  // (buildSystemPrompt in generateProse.ts) so this stays decoupled from
  // that exact wording.
  reservedTokens?: number;
}

type Layer1CodexRow = Pick<
  CodexEntry,
  | "id"
  | "user_id"
  | "book_id"
  | "name"
  | "aliases"
  | "entry_type"
  | "description"
  | "tier"
  | "personality_traits"
  | "motivations"
  | "created_at"
>;

function entryMatchesSceneBeat(entry: Layer1CodexRow, sceneBeat: string): boolean {
  return textMentionsAnyOf(sceneBeat, [entry.name, ...(entry.aliases ?? [])]);
}

// Condenses a Codex entry into a short Layer 1 block. The table can hold a
// full character sheet (physical description, background, arc, notes —
// CRUD'd via src/routes/codex.ts), but only a compact summary is injected
// here so a richly-detailed entry can't blow the ~800-token Layer 1 budget.
function formatCodexEntry(entry: Layer1CodexRow): string {
  const aliasSuffix = entry.aliases?.length ? ` (aka ${entry.aliases.join(", ")})` : "";
  const tierSuffix = entry.tier ? `, ${entry.tier}` : "";
  const lines = [`### ${entry.name}${aliasSuffix} [${entry.entry_type}${tierSuffix}]`, entry.description];

  if (entry.personality_traits?.length) {
    lines.push(`Traits: ${entry.personality_traits.join(", ")}`);
  }
  if (entry.motivations?.length) {
    lines.push(`Motivations: ${entry.motivations.slice(0, 3).join("; ")}`);
  }

  return lines.join("\n");
}

// Fresh, per-generation directives for the chapter about to be written —
// ranked above Layer 1/2/3 in both placement (first section in the
// compiled payload) and budget: its token cost is folded into usedTokens
// before any other layer is measured, so it's the last thing trimmed, not
// the first. Explicit MUST / MUST NOT lists rather than one prose block:
// an LLM is far more likely to actually enforce a negative constraint
// ("don't reveal the pregnancy yet") when it's a syntactically distinct
// rule than when it's a sentence it can read past as ambient description.
// The MUST NOT list is deliberately also echoed by the caller right
// before the scene beat in the user turn (see buildChapterReminder in
// generateProse.ts) — instructions near the end of the prompt, closest to
// where generation actually starts, get weighted more heavily than the
// same instruction stated once further back, which matters most for
// negative constraints since there's nothing later in generation that
// reinforces "don't."
function buildChapterInstructionsSection(chapterInstructions?: string, chapterAvoid?: string): string {
  const must = chapterInstructions?.trim();
  const mustNot = chapterAvoid?.trim();
  if (!must && !mustNot) return "";

  const lines = ["## Instructions For This Chapter — Mandatory, Highest Priority", ""];
  lines.push("Follow these rules above the Codex, recent history, and manuscript memory below whenever they conflict.");
  if (must) {
    lines.push("", "MUST:", must);
  }
  if (mustNot) {
    lines.push("", "MUST NOT:", mustNot);
  }

  return truncateToTokenBudget(lines.join("\n"), CHAPTER_INSTRUCTIONS_TOKEN_BUDGET);
}

// Layer 1 — Codex (Explicit Match): scans the scene beat for known
// character/location/item/lore names or aliases and injects the matched
// profiles' condensed summary, deterministically, no embedding call required.
async function buildLayer1Codex(bookId: string, sceneBeat: string): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("codex_entries")
    .select(
      "id, user_id, book_id, name, aliases, entry_type, description, tier, personality_traits, motivations, created_at"
    )
    .eq("book_id", bookId);

  if (error) {
    throw new Error(`Layer 1 (Codex) lookup failed: ${error.message}`);
  }

  const matched = ((data ?? []) as Layer1CodexRow[]).filter((entry) =>
    entryMatchesSceneBeat(entry, sceneBeat)
  );
  if (matched.length === 0) {
    return "";
  }

  const blocks: string[] = [];
  let usedTokens = 0;

  for (const entry of matched) {
    const block = formatCodexEntry(entry);
    const blockTokens = estimateTokens(block);

    if (usedTokens + blockTokens > LAYER1_TOKEN_BUDGET) {
      const remaining = LAYER1_TOKEN_BUDGET - usedTokens;
      if (remaining > 20) {
        blocks.push(truncateToTokenBudget(block, remaining));
      }
      break;
    }

    blocks.push(block);
    usedTokens += blockTokens;
  }

  return blocks.join("\n\n");
}

// Layer 2 — Recent History (Linear Slip): trailing words immediately
// preceding the cursor, capped by both word count and token budget. Purely
// positional — no embedding call required.
function buildLayer2RecentHistory(recentHistoryText: string): string {
  const words = recentHistoryText.trim().split(/\s+/).filter(Boolean);
  const trailing = words.slice(Math.max(0, words.length - LAYER2_MAX_WORDS)).join(" ");
  return truncateToTokenBudget(trailing, LAYER2_TOKEN_BUDGET);
}

// Diagnostic view of a Layer 3 candidate, surfaced by the /generate-prose/
// preview endpoint so a near-miss (fetched but below LAYER3_MATCH_THRESHOLD)
// is visible instead of just silently absent from the compiled context.
export interface Layer3Candidate {
  id: string;
  similarity: number;
  included: boolean;
  preview: string;
  concepts: string[];
}

// Which chapters actually got pulled into the compiled context, and how —
// surfaced for the same reason as Layer3Candidate: so "what did Layer 3
// actually do" is fully inspectable via /generate-prose/preview, not just
// the final blob of text.
export interface ExpandedChapterInfo {
  chapterNumber: number;
  tokens: number;
  bestSimilarity: number;
  concepts: string[];
}

const CANDIDATE_PREVIEW_CHARS = 160;

interface ConceptMatches {
  concept: string;
  matches: ManuscriptChunkMatch[];
}

// Layer 3 — Deep Past (Vector RAG): expands the scene beat into its
// distinct searchable concepts (see queryExpansion.ts — e.g. a beat about
// "the pregnancy, and the totem" becomes two concepts, not one blended
// query) and runs a separate match_manuscript_chunks search per concept,
// scoped to the current book. Each search uses match_threshold 0 so its
// nearest LAYER3_MATCH_COUNT_PER_CONCEPT chunks always come back
// regardless of relevance; the real LAYER3_MATCH_THRESHOLD is applied
// locally when selecting what actually goes into the compiled context —
// this is what lets near-misses still surface for diagnostics.
async function searchConcepts(bookId: string, concepts: { concept: string; searchText: string }[]): Promise<ConceptMatches[]> {
  const supabase = getSupabaseClient();

  return Promise.all(
    concepts.map(async ({ concept, searchText }) => {
      const embedding = await generateEmbedding(searchText);
      const { data, error } = await supabase.rpc("match_manuscript_chunks", {
        query_embedding: embedding,
        match_threshold: 0,
        match_count: LAYER3_MATCH_COUNT_PER_CONCEPT,
        target_book_id: bookId,
      });

      if (error) {
        throw new Error(`Layer 3 (Deep Past RAG) lookup failed for concept "${concept}": ${error.message}`);
      }

      return { concept, matches: (data ?? []) as ManuscriptChunkMatch[] };
    })
  );
}

// Interleaves each concept's ranked matches round-robin (concept A's best,
// concept B's best, concept C's best, then concept A's second-best, ...)
// instead of pooling everything and sorting by raw similarity — the latter
// would let one concept with generally higher-scoring matches crowd out a
// less-dominant one entirely, exactly the "only finds one of the two
// things" failure this is meant to fix. Chunks already selected under an
// earlier concept are skipped so nothing appears twice.
function selectFairlyAcrossConcepts(conceptMatches: ConceptMatches[]): ManuscriptChunkMatch[] {
  const selected: ManuscriptChunkMatch[] = [];
  const seenIds = new Set<string>();
  const maxRounds = Math.max(0, ...conceptMatches.map((c) => c.matches.length));

  for (let round = 0; round < maxRounds; round++) {
    for (const { matches } of conceptMatches) {
      const candidate = matches[round];
      if (!candidate || seenIds.has(candidate.id)) continue;
      if (candidate.similarity < LAYER3_MATCH_THRESHOLD) continue;
      seenIds.add(candidate.id);
      selected.push(candidate);
    }
  }

  return selected;
}

function buildDiagnosticCandidates(conceptMatches: ConceptMatches[]): Layer3Candidate[] {
  const byId = new Map<string, Layer3Candidate>();

  for (const { concept, matches } of conceptMatches) {
    for (const match of matches) {
      const existing = byId.get(match.id);
      if (existing) {
        if (!existing.concepts.includes(concept)) existing.concepts.push(concept);
        existing.similarity = Math.max(existing.similarity, match.similarity);
        existing.included = existing.similarity >= LAYER3_MATCH_THRESHOLD;
        continue;
      }
      byId.set(match.id, {
        id: match.id,
        similarity: match.similarity,
        included: match.similarity >= LAYER3_MATCH_THRESHOLD,
        preview:
          match.raw_text.length > CANDIDATE_PREVIEW_CHARS
            ? `${match.raw_text.slice(0, CANDIDATE_PREVIEW_CHARS).trimEnd()}…`
            : match.raw_text,
        concepts: [concept],
      });
    }
  }

  return [...byId.values()].sort((a, b) => b.similarity - a.similarity);
}

interface Layer3Gathered {
  candidates: Layer3Candidate[];
  winningMatches: ManuscriptChunkMatch[];
}

// Data-gathering phase only — no budget decisions here, since Layer 3's
// actual budget isn't known until Layer 1/2's real usage is measured (see
// assembleContextPayload). Runs concurrently with Layer 1.
async function gatherLayer3Candidates(bookId: string, sceneBeat: string): Promise<Layer3Gathered> {
  const concepts = await expandSceneBeatConcepts(sceneBeat);
  const conceptMatches = await searchConcepts(bookId, concepts);

  // selectFairlyAcrossConcepts decides WHICH matches qualify — round-robin
  // so a strongly-covered concept can't crowd a weaker one out of
  // consideration entirely. But its output order is round order (A's
  // best, B's best, A's 2nd-best, ...), not similarity order, and
  // assembleLayer3Text spends the token budget greedily in whatever order
  // it receives matches. Left as round order, a concept's weaker match
  // (e.g. an incidental background detail, similarity 0.55) could get a
  // full chapter's worth of budget before a different concept's actually-
  // central match (similarity 0.62+) ever gets a turn — confirmed against
  // real generations, where a scene's core subject was squeezed to a
  // ~300-token fragment while a barely-relevant background detail got a
  // full chapter. Re-sorting by similarity here keeps round-robin's
  // fairness at selection time while making sure budget always goes to
  // the most relevant matches first at assembly time.
  const winningMatches = selectFairlyAcrossConcepts(conceptMatches).sort((a, b) => b.similarity - a.similarity);

  return {
    candidates: buildDiagnosticCandidates(conceptMatches),
    winningMatches,
  };
}

interface ChapterChunkRow {
  scene_order: number;
  raw_text: string;
}

async function fetchChapterChunks(bookId: string, chapterNumber: number): Promise<ChapterChunkRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_chunks")
    .select("scene_order, raw_text")
    .eq("book_id", bookId)
    .eq("chapter_number", chapterNumber)
    .order("scene_order", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch chapter ${chapterNumber} for expansion: ${error.message}`);
  }
  return (data ?? []) as ChapterChunkRow[];
}

// Expands outward from the matched chunk within its chapter — alternating
// forward and backward by proximity — instead of injecting just the one
// isolated chunk a similarity search happened to rank highest. Always
// includes the actual match first, then adds whole neighboring chunks
// (never a mid-sentence truncation) until the budget runs out or the
// chapter is fully included.
function expandAroundMatch(
  chunks: ChapterChunkRow[],
  matchedSceneOrder: number,
  budgetTokens: number
): { text: string; tokens: number } {
  const matchIndex = chunks.findIndex((c) => c.scene_order === matchedSceneOrder);
  if (matchIndex === -1) return { text: "", tokens: 0 };
  const matchChunk = chunks[matchIndex];
  if (!matchChunk) return { text: "", tokens: 0 };

  const matchTokens = estimateTokens(matchChunk.raw_text);
  if (matchTokens > budgetTokens) {
    // The single matched chunk alone doesn't fit — budget is nearly
    // exhausted by earlier layers. Truncate just this one chunk rather
    // than including nothing.
    const text = truncateToTokenBudget(matchChunk.raw_text, budgetTokens);
    return { text, tokens: estimateTokens(text) };
  }

  const included = new Set<number>([matchIndex]);
  let usedTokens = matchTokens;
  let before = matchIndex - 1;
  let after = matchIndex + 1;
  let preferAfter = true;

  while (usedTokens < budgetTokens && (before >= 0 || after < chunks.length)) {
    const haveAfter = after < chunks.length;
    const haveBefore = before >= 0;
    const pickAfter = (preferAfter && haveAfter) || (!haveBefore && haveAfter);
    const index = pickAfter ? after : before;
    const chunk = chunks[index];
    if (!chunk) break;

    const tokens = estimateTokens(chunk.raw_text);
    if (usedTokens + tokens > budgetTokens) break;

    included.add(index);
    usedTokens += tokens;
    if (pickAfter) after += 1;
    else before -= 1;
    preferAfter = !preferAfter;
  }

  const text = [...included]
    .sort((a, b) => a - b)
    .map((i) => chunks[i]?.raw_text ?? "")
    .join("\n\n");
  return { text, tokens: usedTokens };
}

interface Layer3Assembled {
  text: string;
  expandedChapters: ExpandedChapterInfo[];
}

// Budget-constrained assembly phase: walks the winning matches in
// similarity order (highest first — see gatherLayer3Candidates for why
// this isn't round-robin/selection order) and expands each into its full
// surrounding chapter (deduplicated — a chapter is only expanded once
// even if multiple concepts pointed into it) until budgetTokens runs out.
// Greedy and whole-chunk-boundary-only (no mid-sentence truncation) so
// it's fine to land slightly under budget on the last candidate that
// doesn't fit, rather than cut prose off mid-thought.
async function assembleLayer3Text(bookId: string, gathered: Layer3Gathered, budgetTokens: number): Promise<Layer3Assembled> {
  const candidatesById = new Map(gathered.candidates.map((c) => [c.id, c]));
  const blocks: string[] = [];
  const expandedChapters: ExpandedChapterInfo[] = [];
  const expandedChapterNumbers = new Set<number>();
  let usedTokens = 0;
  let memoryIndex = 0;

  for (const match of gathered.winningMatches) {
    if (usedTokens >= budgetTokens) break;
    if (expandedChapterNumbers.has(match.chapter_number)) continue;

    const remainingForContent = budgetTokens - usedTokens - MEMORY_HEADER_TOKENS_ESTIMATE;
    if (remainingForContent <= 0) break;

    const chapterChunks = await fetchChapterChunks(bookId, match.chapter_number);
    const expanded = expandAroundMatch(chapterChunks, match.scene_order, remainingForContent);
    if (!expanded.text) continue;

    memoryIndex += 1;
    const block = `### Memory ${memoryIndex} — Chapter ${match.chapter_number} (best match similarity: ${match.similarity.toFixed(3)})\n${expanded.text}`;
    const blockTokens = estimateTokens(block);

    blocks.push(block);
    usedTokens += blockTokens;
    expandedChapterNumbers.add(match.chapter_number);
    expandedChapters.push({
      chapterNumber: match.chapter_number,
      tokens: blockTokens,
      bestSimilarity: match.similarity,
      concepts: candidatesById.get(match.id)?.concepts ?? [],
    });
  }

  return { text: blocks.join("\n\n"), expandedChapters };
}

export interface AssembleContextResult {
  payload: string;
  layer3Candidates: Layer3Candidate[];
  expandedChapters: ExpandedChapterInfo[];
  estimatedTotalTokens: number;
}

// Compiles the context payload for a scene beat: this chapter's
// instructions (highest priority) + Layer 1 (Codex) + Layer 2 (Recent
// History) + Layer 3 (Deep Past RAG). Layer 1's lookup and Layer 3's
// candidate-gathering run concurrently (independent round trips); Layer 2
// is a pure local slice, and the chapter instructions section is built
// synchronously from the request itself (no DB round trip — it's never
// saved). The instructions section is measured first, then Layer 1 and 2,
// so Layer 3's actual token budget reflects whatever's genuinely left —
// any budget the higher-priority sections don't use goes to Layer 3
// instead of being left on the table, see TOTAL_TOKEN_BUDGET above for why.
export async function assembleContextPayload(params: AssembleContextParams): Promise<AssembleContextResult> {
  const { bookId, userSceneBeat, recentHistoryText, chapterInstructions, chapterAvoid, reservedTokens = 0 } = params;

  const [layer1, layer3Gathered] = await Promise.all([
    buildLayer1Codex(bookId, userSceneBeat),
    gatherLayer3Candidates(bookId, userSceneBeat),
  ]);
  const layer2 = buildLayer2RecentHistory(recentHistoryText);
  const instructions = buildChapterInstructionsSection(chapterInstructions, chapterAvoid);

  const sections: string[] = [];
  let usedTokens = reservedTokens;

  if (instructions) {
    sections.push(instructions);
    usedTokens += estimateTokens(instructions) + estimateTokens(SECTION_SEPARATOR);
  }
  if (layer1) {
    const section = `## Codex — Relevant Characters, Locations & Lore\n\n${layer1}`;
    sections.push(section);
    usedTokens += estimateTokens(section) + estimateTokens(SECTION_SEPARATOR);
  }
  if (layer2) {
    const section = `## Recent Story History (Immediately Preceding Text)\n\n${layer2}`;
    sections.push(section);
    usedTokens += estimateTokens(section) + estimateTokens(SECTION_SEPARATOR);
  }

  const layer3HeaderTokens = estimateTokens("## Background Manuscript Memory (Deep Past)\n\n");
  const layer3Budget = Math.max(0, TOTAL_TOKEN_BUDGET + BUDGET_TOLERANCE_TOKENS - usedTokens - layer3HeaderTokens);
  const layer3 = await assembleLayer3Text(bookId, layer3Gathered, layer3Budget);

  if (layer3.text) {
    sections.push(`## Background Manuscript Memory (Deep Past)\n\n${layer3.text}`);
    usedTokens += layer3HeaderTokens + estimateTokens(layer3.text);
  }

  return {
    payload: sections.join(SECTION_SEPARATOR),
    layer3Candidates: layer3Gathered.candidates,
    expandedChapters: layer3.expandedChapters,
    estimatedTotalTokens: usedTokens,
  };
}
