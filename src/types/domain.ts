// entry_type used to be a fixed CHECK-constrained enum (see migration
// 002_expand_codex_schema.sql). Migration 016_world_categories.sql drops
// that constraint: entry_type is now an open-ended worldbuilding category
// key, matching the frontend's user-creatable WorldCategoryKey, validated
// at the application layer as "any non-empty string" (src/routes/codex.ts)
// rather than a closed list. 'character' remains a plain value with no
// special DB-level treatment — nothing branches on it structurally, since
// Layer 1 (rag.ts) matches by name/alias for every entry_type equally.
export type CodexEntryType = string;

// The original fixed set, kept only as a reference list for UI defaults/
// suggestions (e.g. a test harness dropdown) — no longer enforced
// anywhere. See world_categories (src/routes/worldCategories.ts) for the
// real per-book category metadata (display name, color, icon).
export const KNOWN_CODEX_ENTRY_TYPES = [
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
] as const;

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
  updated_at: string;
}

export interface WorldCategory {
  id: string;
  book_id: string;
  key: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  created_at: string;
  // true when this row wasn't found in world_categories and was
  // synthesized from a distinct entry_type already in use (see
  // src/routes/worldCategories.ts) — no id/created_at in that case.
  is_derived?: boolean;
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

export interface ManuscriptPart {
  id: string;
  book_id: string;
  title: string;
  order_index: number;
  created_at: string;
}

// Loosely typed on purpose — matches the frontend's ChapterParagraph
// shape ({ id, text, emphasis?, break?, comments?, ... }) but isn't
// validated field-by-field server-side since that shape isn't fully
// settled yet (see manuscriptChapters.ts's isParagraphsArray).
export interface ChapterParagraph {
  id: string;
  text: string;
  [key: string]: unknown;
}

export interface ManuscriptChapter {
  id: string;
  user_id: string;
  book_id: string;
  part_id: string | null;
  number: number;
  title: string | null;
  heading: string | null;
  complete: boolean;
  paragraphs: ChapterParagraph[];
  synced_to_memory_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ManuscriptScene {
  id: string;
  chapter_id: string;
  title: string;
  order_index: number;
  created_at: string;
}

export type NoteCategory =
  | "World Building"
  | "Character"
  | "Plot"
  | "Research"
  | "Inspiration"
  | "Magic System";

export const VALID_NOTE_CATEGORIES: NoteCategory[] = [
  "World Building",
  "Character",
  "Plot",
  "Research",
  "Inspiration",
  "Magic System",
];

export interface Note {
  id: string;
  user_id: string;
  book_id: string;
  title: string;
  excerpt: string;
  category: NoteCategory;
  pinned: boolean;
  comments: number;
  created_at: string;
  updated_at: string;
}

export type ChatPersona =
  | "general"
  | "story_assistant"
  | "character_coach"
  | "worldbuilding_guide"
  | "writing_editor"
  | "brainstormer";

export const VALID_CHAT_PERSONAS: ChatPersona[] = [
  "general",
  "story_assistant",
  "character_coach",
  "worldbuilding_guide",
  "writing_editor",
  "brainstormer",
];

export interface ChatSession {
  id: string;
  user_id: string;
  book_id: string;
  persona: ChatPersona;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatToolCallLogEntry {
  tool: string;
  input: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls: ChatToolCallLogEntry[] | null;
  created_at: string;
}

export type BeatStatus = "not_started" | "planned" | "in_progress" | "completed";

export const VALID_BEAT_STATUSES: BeatStatus[] = ["not_started", "planned", "in_progress", "completed"];

// Outliner: a per-chapter outline card (Acts -> Chapters -> Beats). Its
// outline_text is what /generate-prose pulls as the sceneBeat when
// generating via beatId, instead of the writer retyping/pasting a scene
// beat by hand each time. linked_to_manuscript flips true once the beat's
// generated prose has been accepted into the chapter's paragraphs — a
// simple flag, not a tracked paragraph range.
export interface ChapterBeat {
  id: string;
  chapter_id: string;
  order_index: number;
  title: string;
  outline_text: string;
  status: BeatStatus;
  linked_to_manuscript: boolean;
  created_at: string;
  updated_at: string;
}
