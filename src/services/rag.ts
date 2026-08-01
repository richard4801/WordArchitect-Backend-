import { getSupabaseClient } from "../lib/supabaseClient.js";
import { estimateTokens, truncateToTokenBudget } from "../lib/tokenBudget.js";
import { generateEmbedding } from "./embedding.js";
import type { CodexEntry, ManuscriptChunkMatch } from "../types/domain.js";

// Per-layer token budgets, per the Dual-Layer Context Engine spec in CLAUDE.md.
const LAYER1_TOKEN_BUDGET = 800;
const LAYER2_MAX_WORDS = 2000;
const LAYER2_TOKEN_BUDGET = 2000;
const LAYER3_TOKEN_BUDGET = 1000;
const LAYER3_MATCH_THRESHOLD = 0.5;
const LAYER3_MATCH_COUNT = 3;

export interface AssembleContextParams {
  userId: string;
  bookId: string;
  userSceneBeat: string;
  recentHistoryText: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const candidates = [entry.name, ...(entry.aliases ?? [])].filter(Boolean);
  return candidates.some((candidate) => {
    const pattern = new RegExp(`\\b${escapeRegExp(candidate)}\\b`, "i");
    return pattern.test(sceneBeat);
  });
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

// Layer 1 — Codex (Explicit Match): scans the scene beat for known
// character/location/item/lore names or aliases and injects the matched
// profiles' condensed summary, deterministically, no embedding call required.
async function buildLayer1Codex(bookId: string, sceneBeat: string): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("codex_entries")
    .select("id, user_id, book_id, name, aliases, entry_type, description, tier, personality_traits, motivations, created_at")
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
}

interface Layer3Result {
  text: string;
  candidates: Layer3Candidate[];
}

const CANDIDATE_PREVIEW_CHARS = 160;

// Layer 3 — Deep Past (Vector RAG): embeds the scene beat and runs the
// match_manuscript_chunks cosine-similarity RPC, scoped to the current book.
// Queries with match_threshold 0 so the top LAYER3_MATCH_COUNT nearest
// chunks always come back regardless of relevance, then applies the real
// LAYER3_MATCH_THRESHOLD locally — same end result for the compiled
// context, but it also lets us report near-misses for diagnostics.
async function buildLayer3DeepPast(bookId: string, sceneBeat: string): Promise<Layer3Result> {
  const embedding = await generateEmbedding(sceneBeat);
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc("match_manuscript_chunks", {
    query_embedding: embedding,
    match_threshold: 0,
    match_count: LAYER3_MATCH_COUNT,
    target_book_id: bookId,
  });

  if (error) {
    throw new Error(`Layer 3 (Deep Past RAG) lookup failed: ${error.message}`);
  }

  const matches = (data ?? []) as ManuscriptChunkMatch[];
  const candidates: Layer3Candidate[] = matches.map((match) => ({
    similarity: match.similarity,
    included: match.similarity >= LAYER3_MATCH_THRESHOLD,
    preview:
      match.raw_text.length > CANDIDATE_PREVIEW_CHARS
        ? `${match.raw_text.slice(0, CANDIDATE_PREVIEW_CHARS).trimEnd()}…`
        : match.raw_text,
  }));

  const included = matches.filter((match) => match.similarity >= LAYER3_MATCH_THRESHOLD);
  if (included.length === 0) {
    return { text: "", candidates };
  }

  const blocks: string[] = [];
  let usedTokens = 0;

  for (const [index, match] of included.entries()) {
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
