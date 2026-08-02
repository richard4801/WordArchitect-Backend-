import { getSupabaseClient } from "../lib/supabaseClient.js";
import { estimateTokens, truncateToTokenBudget } from "../lib/tokenBudget.js";
import { textMentionsAnyOf } from "../lib/textMatch.js";
import { generateEmbedding } from "./embedding.js";
import { expandSceneBeatConcepts } from "./queryExpansion.js";
import type { CodexEntry, ManuscriptChunkMatch } from "../types/domain.js";

// Per-layer token budgets, per the Dual-Layer Context Engine spec in CLAUDE.md.
const LAYER1_TOKEN_BUDGET = 800;
const LAYER2_MAX_WORDS = 2000;
const LAYER2_TOKEN_BUDGET = 2000;
const LAYER3_TOKEN_BUDGET = 1000;
const LAYER3_MATCH_THRESHOLD = 0.5;
// Each extracted concept gets its own search for this many nearest chunks —
// not one shared top-N across the whole beat, which would let one concept
// (e.g. "pregnancy") crowd out another (e.g. "totem") in a single search.
const LAYER3_MATCH_COUNT_PER_CONCEPT = 3;

export interface AssembleContextParams {
  userId: string;
  bookId: string;
  userSceneBeat: string;
  recentHistoryText: string;
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
  | "auto_summary"
  | "created_at"
>;

function entryMatchesSceneBeat(entry: Layer1CodexRow, sceneBeat: string): boolean {
  return textMentionsAnyOf(sceneBeat, [entry.name, ...(entry.aliases ?? [])]);
}

// Condenses a Codex entry into a short Layer 1 block. The table can hold a
// full character sheet (physical description, background, arc, notes —
// CRUD'd via src/routes/codex.ts), but only a compact summary is injected
// here so a richly-detailed entry can't blow the ~800-token Layer 1 budget.
// auto_summary — the Codex sync job's incrementally-built synthesis of
// every manuscript mention (see codexSync.ts) — is included alongside the
// writer's own description, not instead of it.
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
  if (entry.auto_summary) {
    lines.push(`Established in manuscript so far: ${entry.auto_summary}`);
  }

  return lines.join("\n");
}

// Layer 1 — Codex (Explicit Match): scans the scene beat for known
// character/location/item/lore names or aliases and injects the matched
// profiles' condensed summary, deterministically, no embedding call required.
async function buildLayer1Codex(bookId: string, sceneBeat: string): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("codex_entries")
    .select(
      "id, user_id, book_id, name, aliases, entry_type, description, tier, personality_traits, motivations, auto_summary, created_at"
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
  similarity: number;
  included: boolean;
  preview: string;
  concepts: string[];
}

interface Layer3Result {
  text: string;
  candidates: Layer3Candidate[];
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

async function buildLayer3DeepPast(bookId: string, sceneBeat: string): Promise<Layer3Result> {
  const concepts = await expandSceneBeatConcepts(sceneBeat);
  const conceptMatches = await searchConcepts(bookId, concepts);

  const candidates = buildDiagnosticCandidates(conceptMatches);
  const selected = selectFairlyAcrossConcepts(conceptMatches);

  if (selected.length === 0) {
    return { text: "", candidates };
  }

  const blocks: string[] = [];
  let usedTokens = 0;

  for (const [index, match] of selected.entries()) {
    const block = `### Memory ${index + 1} (similarity: ${match.similarity.toFixed(3)})\n${match.raw_text}`;
    const blockTokens = estimateTokens(block);

    if (usedTokens + blockTokens > LAYER3_TOKEN_BUDGET) {
      const remaining = LAYER3_TOKEN_BUDGET - usedTokens;
      if (remaining > 20) {
        blocks.push(truncateToTokenBudget(block, remaining));
      }
      break;
    }

    blocks.push(block);
    usedTokens += blockTokens;
  }

  return { text: blocks.join("\n\n"), candidates };
}

export interface AssembleContextResult {
  payload: string;
  layer3Candidates: Layer3Candidate[];
}

// Compiles the three-layer context payload for a scene beat. Layers 1 and 3
// are independent round trips and run concurrently; Layer 2 is a pure local
// slice. Empty layers are omitted from the final payload. Also returns the
// raw Layer 3 candidates (including near-misses below the match threshold)
// for diagnostic use by /generate-prose/preview — the compiled `payload`
// itself only ever contains chunks that cleared the real threshold.
export async function assembleContextPayload(params: AssembleContextParams): Promise<AssembleContextResult> {
  const { bookId, userSceneBeat, recentHistoryText } = params;

  const [layer1, layer3Result] = await Promise.all([
    buildLayer1Codex(bookId, userSceneBeat),
    buildLayer3DeepPast(bookId, userSceneBeat),
  ]);
  const layer2 = buildLayer2RecentHistory(recentHistoryText);
  const layer3 = layer3Result.text;

  const sections: string[] = [];

  if (layer1) {
    sections.push(`## Codex — Relevant Characters, Locations & Lore\n\n${layer1}`);
  }
  if (layer2) {
    sections.push(`## Recent Story History (Immediately Preceding Text)\n\n${layer2}`);
  }
  if (layer3) {
    sections.push(`## Background Manuscript Memory (Deep Past)\n\n${layer3}`);
  }

  return { payload: sections.join("\n\n---\n\n"), layer3Candidates: layer3Result.candidates };
}
