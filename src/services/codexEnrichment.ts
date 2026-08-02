import { getOpenAIClient } from "../lib/openaiClient.js";
import { VALID_CODEX_ENTRY_TYPES, type CodexEntryType } from "../types/domain.js";

const ENRICHMENT_MODEL = "gpt-4o-mini";

export interface ExistingEntryForEnrichment {
  name: string;
  currentUnderstanding: string;
}

export interface EntryUpdate {
  name: string;
  summary: string;
}

export interface ProposedEntry {
  name: string;
  entryType: CodexEntryType;
  description: string;
}

export interface EnrichmentResult {
  updates: EntryUpdate[];
  newEntries: ProposedEntry[];
}

// One LLM call does two things at once against a single manuscript chunk:
// (1) for Codex entries already known to appear in this passage, decide
// whether it reveals anything new worth folding into their running
// understanding; (2) spot other named characters/places/objects mentioned
// prominently that aren't in the Codex yet, and propose them. This is what
// lets the Codex sync job both enrich what's already tracked and discover
// what isn't, in one pass per chunk instead of two separate pipelines.
//
// Returns empty arrays (not an error) if the model call fails or returns
// something unusable — a sync step should skip a chunk it couldn't
// process, not abort the whole job over one bad response.
export async function enrichFromChunk(
  chunkText: string,
  matchedEntries: ExistingEntryForEnrichment[],
  allExistingNames: string[]
): Promise<EnrichmentResult> {
  try {
    const openai = getOpenAIClient();
    const response = await openai.chat.completions.create({
      model: ENRICHMENT_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You maintain a running knowledge base (a 'Codex') for a novel manuscript, one passage at a time.",
            "You will be given a passage, a list of Codex entries already known to appear in it (with their current understanding), and the full list of every name already in the Codex.",
            "Task 1 — for each already-known entry given, decide if this passage reveals anything new or important about them (facts, relationships, events, traits). If yes, write an updated summary (max 100 words) that merges their existing understanding with what's new. If nothing new, omit that entry entirely from your response — do not restate unchanged information.",
            `Task 2 — identify any OTHER named characters, locations, items, or lore elements mentioned prominently in this passage that are NOT in the full existing-names list. For each, propose entryType from exactly this list: ${VALID_CODEX_ENTRY_TYPES.join(", ")}. Write a brief description (max 60 words) based only on this passage. Skip incidental mentions — a name said once in passing with no real characterization isn't worth tracking.`,
            'Respond with JSON: {"updates": [{"name": "...", "summary": "..."}], "newEntries": [{"name": "...", "entryType": "...", "description": "..."}]}.',
            "Return empty arrays for either if there's nothing to report. Never invent facts not present in the passage.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `PASSAGE:\n${chunkText}`,
            matchedEntries.length > 0
              ? `\nALREADY-KNOWN ENTRIES MENTIONED HERE:\n${matchedEntries
                  .map((e) => `- ${e.name}: ${e.currentUnderstanding || "(no summary yet)"}`)
                  .join("\n")}`
              : "\nALREADY-KNOWN ENTRIES MENTIONED HERE: none",
            `\nFULL LIST OF EXISTING CODEX NAMES (do not re-propose these): ${allExistingNames.join(", ") || "(none yet)"}`,
          ].join("\n"),
        },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error("empty response from enrichment model");

    const parsed = JSON.parse(raw) as { updates?: unknown; newEntries?: unknown };

    const updates = (Array.isArray(parsed.updates) ? parsed.updates : []).filter(
      (u): u is EntryUpdate =>
        typeof u === "object" &&
        u !== null &&
        typeof (u as EntryUpdate).name === "string" &&
        typeof (u as EntryUpdate).summary === "string" &&
        (u as EntryUpdate).summary.trim() !== ""
    );

    const newEntries = (Array.isArray(parsed.newEntries) ? parsed.newEntries : []).filter(
      (e): e is ProposedEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as ProposedEntry).name === "string" &&
        typeof (e as ProposedEntry).description === "string" &&
        (e as ProposedEntry).description.trim() !== "" &&
        VALID_CODEX_ENTRY_TYPES.includes((e as ProposedEntry).entryType)
    );

    return { updates, newEntries };
  } catch (err) {
    console.error("Codex chunk enrichment failed, skipping this chunk:", err);
    return { updates: [], newEntries: [] };
  }
}
