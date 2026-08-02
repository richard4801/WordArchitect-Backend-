export type CodexEntryType =
  | "character"
  | "location"
  | "item"
  | "lore"
  | "nation"
  | "culture"
  | "magic"
  | "faction"
  | "religion"
  | "history";

export const VALID_CODEX_ENTRY_TYPES: CodexEntryType[] = [
  "character",
  "location",
  "item",
  "lore",
  "nation",
  "culture",
  "magic",
  "faction",
  "religion",
  "history",
];

export type CodexTier = "main" | "supporting" | "minor";

export interface CharacterArcStage {
  stage: string;
  description: string;
}

export interface CodexEntry {
  id: string;
  user_id: string;
  book_id: string;
  name: string;
  aliases: string[] | null;
  entry_type: CodexEntryType;
  description: string;
  tier: CodexTier | null;
  quote: string | null;
  image_url: string | null;
  age: string | null;
  gender: string | null;
  role_in_story: string | null;
  occupation: string | null;
  location_name: string | null;
  physical_description: string[] | null;
  personality_traits: string[] | null;
  motivations: string[] | null;
  background: string | null;
  character_arc: CharacterArcStage[] | null;
  notes: string | null;
  event_year: string | null;
  // System-maintained synthesis of every manuscript mention of this entry,
  // built incrementally by the Codex sync job — distinct from the
  // writer's own hand-authored `description`. See CLAUDE.md's Codex
  // Enrichment section.
  auto_summary: string | null;
  // True if this entry was proposed by the sync job (found mentioned in
  // the manuscript but not yet in the Codex) rather than created by hand.
  auto_generated: boolean;
  created_at: string;
}

export type CodexRelationshipStrength = "strong" | "moderate" | "tense" | "weak";

export interface CodexRelationship {
  id: string;
  book_id: string;
  from_entry_id: string;
  to_entry_id: string;
  bond_type: string;
  description: string | null;
  strength: CodexRelationshipStrength | null;
  created_at: string;
}

export interface ManuscriptChunkMatch {
  id: string;
  raw_text: string;
  similarity: number;
}
