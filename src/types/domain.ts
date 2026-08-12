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

export type CodexTier = "main" | "supporting" | "minor" | "extra";

export interface CharacterArcStage {
  stage: string;
  description: string;
}

export interface CodexNote {
  title: string;
  body: string;
  date?: string | null;
  pinned?: boolean;
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
  background: string[] | null;
  character_arc: CharacterArcStage[] | null;
  notes: CodexNote[] | null;
  event_year: string | null;
  nickname: string | null;
  epithet: string | null;
  status: string | null;
  alignment: string | null;
  pov_character: boolean;
  archetype: string | null;
  favorites: number;
  motivation: string | null;
  goal: string | null;
  fear: string | null;
  secret: string | null;
  life_events: Record<string, unknown>[] | null;
  cultural_background: Record<string, unknown> | null;
  strengths: string[] | null;
  weaknesses: string[] | null;
  internal_conflict: string | null;
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
  chapter_number: number;
  scene_order: number;
  similarity: number;
}

export interface Book {
  id: string;
  user_id: string;
  title: string;
  tagline: string | null;
  genre: string | null;
  subgenres: string[] | null;
  pov: string | null;
  tense: string | null;
  target_words: number | null;
  status: string;
  cover_url: string | null;
  created_at: string;
  updated_at: string;
}
