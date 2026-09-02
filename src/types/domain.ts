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

// ============================================================================
// Planning Engine — pre-writing pipeline (Summary -> Acts -> Beats), a
// 3-agent Scrutiny Panel, and a human review gate at every stage. Never
// writes manuscript prose itself — that stays Hanami's job. Approved
// artifacts feed the existing Outliner (chapter_beats) and Codex/World
// Categories tables.
// ============================================================================

export type AgentRole =
  | "generator"
  | "continuity_critic"
  | "pacing_critic"
  | "craft_critic"
  | "arbitrator_panel"
  | "arbitrator_chat"
  | "arbitrator_directive"
  | "entity_extractor"
  | "ledger_extractor"
  | "platform_researcher";

export const VALID_AGENT_ROLES: AgentRole[] = [
  "generator",
  "continuity_critic",
  "pacing_critic",
  "craft_critic",
  "arbitrator_panel",
  "arbitrator_chat",
  "arbitrator_directive",
  "entity_extractor",
  "ledger_extractor",
  "platform_researcher",
];

// The critics that make up the Scrutiny Panel, run in parallel by
// runCritique — a plain array, not hardcoded call sites, so adding or
// removing a critic later is a one-line change plus a prompt row, not a
// code change. Was logic_critic/suspense_critic (2); split into 3 after a
// real case where pacing-specific issues (chapter economy, cliffhanger
// cadence, decompression) went uncaught because "emotional pacing" was
// buried as one bullet inside a critic mostly focused on subtext/hooks —
// narrow, specialized critics catch more than fewer generalist ones.
export const CRITIC_ROLES: AgentRole[] = ["continuity_critic", "pacing_critic", "craft_critic"];

// 'intake' is a valid stage for prompt lookup only (never a run's
// current_stage) — it's where arbitrator_chat/arbitrator_directive get a
// distinct prompt for the pre-Stage-1 intake conversation, separate from
// the same roles' prompt for a mid-pipeline rejection interview.
//
// Replaced 'stage_2_acts'/'stage_3_beats' — a single call that outlined
// (or beat-mapped) the ENTIRE book at once, confirmed live to produce
// real internal contradictions (a heist book's own stated numbers
// disagreeing with each other by the time the model reached arc 4-5,
// caught by the Continuity Critic) — with a strict, incremental
// hierarchy: 3 fixed Acts, each with 3 fixed Parts, each Part planned in
// two passes (outline, then beats) before the next Part unlocks. Nothing
// plans more of the book than the writer has actually approved so far.
// See PlanningRun.current_act/current_part/current_beat_chunk for how a
// run's exact position in that hierarchy is tracked.
// codex_documentation/hook_chapters_outline are the Contract Pipeline's own
// two units (see PipelineType below) — a flatter, separate track sharing
// only stage_1_summary with the main Act/Part/Beats hierarchy.
export type PlanningStage =
  | "stage_1_summary"
  | "act_summary"
  | "part_outline"
  | "part_beats"
  | "codex_documentation"
  | "hook_chapters_outline"
  | "all"
  | "intake";

// The subset of PlanningStage a run's current_stage or a stage_artifacts
// key's phase can actually be — excludes "all" and "intake", which only
// ever appear as a prompt-lookup stage, never a run's real position.
export type RealPlanningStage =
  | "stage_1_summary"
  | "act_summary"
  | "part_outline"
  | "part_beats"
  | "codex_documentation"
  | "hook_chapters_outline";

export const VALID_PLANNING_STAGES: PlanningStage[] = [
  "stage_1_summary",
  "act_summary",
  "part_outline",
  "part_beats",
  "codex_documentation",
  "hook_chapters_outline",
  "all",
  "intake",
];

// Fixed, not model-decided — "the AI can never go against it." A 600-
// chapter serial and a 90k-word single-POV romance both get exactly 3
// Acts and 9 Parts; only PART_BEATS_CHAPTER_WINDOW (planningEngine.ts)
// varies how many chapters worth of beats one Part gets planned in.
export const ACTS_PER_BOOK = 3;
export const PARTS_PER_ACT = 3;

// "full" is the Act/Part/Beats hierarchy described above. "contract" is a
// separate, much shorter track — a summary, then a Codex documentation
// pass, then a fixed 5-chapter hook outline — built to mirror how
// serialized-fiction platforms (GoodNovel-style) decide whether a book
// gets picked up: on roughly its first five chapters, judged on hook
// strength and early pacing, not the whole book. Both tracks share the
// same stage_1_summary unit and the same generate->critique->arbitrate->
// approve machinery; only the stage sequence after Stage 1 differs (see
// nextPosition in planningEngine.ts). A completed contract run can be
// promoted into a fresh full-pipeline run (promoteContractRunToFull) that
// starts already past Part 1 of Act 1, since those first five chapters
// are already planned and approved.
export type PipelineType = "full" | "contract";
export const VALID_PIPELINE_TYPES: PipelineType[] = ["full", "contract"];

// A Part's own stated chapter range, recorded once its outline is
// approved (the outline is the first point in the hierarchy concrete
// enough to commit to real chapter numbers) — what lets part_beats know
// how many beat-generation chunks a Part needs, and what
// materializeBeatsChunk uses to place beats at the right chapter numbers.
export interface PartChapterRange {
  startChapter: number;
  endChapter: number;
}

// One fact worth remembering across the rest of the book — a number, a
// rule, an established state ("Sabine's compulsion visibly used in front
// of a full room in Ch. 12" / "bearer cores are 400g each") — extracted
// after each Part's beats are approved (see ledgerExtractor in
// planningEngine.ts) and fed into every later generation/critique call as
// {{CONTINUITY_LEDGER}}, so a later Act/Part can't contradict something
// already true of the book. `sourcedFrom: "manuscript"` means this fact
// was pulled from chapters actually drafted and accepted by the time it
// was extracted (ground truth); "plan" means those chapters weren't
// written yet and this is only what the outline/beats claimed — both are
// worth keeping, but "manuscript" facts are the ones that can never be
// wrong.
export interface ContinuityLedgerEntry {
  fact: string;
  sourcedFrom: "plan" | "manuscript";
  unit: string; // e.g. "act_1_part_2" — where this fact was extracted from
}

export const VALID_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof VALID_EFFORT_LEVELS)[number];

// Every field here is authored and owned by the writer, never generated by
// this backend — this row is the entire behavior of one agent at one stage.
export type PromptAuthor = "writer" | "claude";

export interface AgentPrompt {
  id: string;
  book_id: string;
  agent_role: AgentRole;
  stage: PlanningStage;
  version: number;
  is_active: boolean;
  system_prompt: string;
  user_prompt_template: string;
  model: string;
  effort: EffortLevel;
  // Lets the Prompt Editor warn before the writer edits over a
  // Claude-authored version rather than one they wrote themselves.
  authored_by: PromptAuthor;
  created_at: string;
}

export type PlanningRunStatus =
  | "intake_active"
  | "generating"
  | "critiquing"
  | "awaiting_arbitration"
  | "awaiting_user_review"
  | "user_chat_active"
  | "awaiting_entity_review"
  | "done"
  | "failed";

export interface PlanningChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ExtractedEntityCandidate {
  type: "codex_entry" | "world_category";
  name: string;
  entryType?: string;
  description?: string;
}

export interface PlanningRun {
  id: string;
  book_id: string;
  user_id: string;
  // "full" (default) or "contract" — see PipelineType. Fixed for the life
  // of a run; a promoted contract run creates a brand new "full" row
  // rather than converting itself in place, so the contract run stays as
  // an intact historical record of what actually got the contract.
  pipeline_type: PipelineType;
  current_stage: PlanningStage;
  status: PlanningRunStatus;
  // A run's exact position once it's past stage_1_summary — null/null/null
  // while current_stage is 'stage_1_summary' or during intake. current_part
  // is also null while current_stage is 'act_summary' (an Act's summary
  // isn't scoped to one Part). current_beat_chunk is only meaningful during
  // 'part_beats' — which chunk of that Part's chapter range is being
  // generated right now (see PART_BEATS_CHAPTER_WINDOW in planningEngine.ts).
  current_act: number | null;
  current_part: number | null;
  current_beat_chunk: number | null;
  // Keyed "act-part" (e.g. "1-2") — recorded once that Part's outline is
  // approved. See PartChapterRange.
  part_chapter_ranges: Record<string, PartChapterRange>;
  // Accumulates one entry per approved Part's beats — see
  // ContinuityLedgerEntry. Never pruned within a run; each entry is small
  // (one fact), so this stays compact even across a full 9-Part book.
  continuity_ledger: ContinuityLedgerEntry[];
  // Keyed by unit, not by stage type — 'stage_1_summary', 'act_1_summary',
  // 'act_1_part_2_outline', 'act_1_part_2_beats', etc. (see unitKey() in
  // planningEngine.ts). Open rather than a fixed shape since the number of
  // units is fixed (1 + 3 + 9 + 9 = 22) but which ones exist yet depends on
  // how far the run has progressed. part_beats artifacts accumulate JSON
  // across that Part's beat-generation chunks rather than being overwritten
  // per chunk, so the Part's full chapters/beats are always in one place
  // once done.
  stage_artifacts: Record<string, string>;
  // Keyed by critic role (see CRITIC_ROLES) — open rather than a fixed
  // set of named keys, since the panel's composition isn't hardcoded.
  panel_reviews: Partial<Record<AgentRole, unknown>> | null;
  arbitrator_synthesis: unknown | null;
  // Snapshot of a unit's panel_reviews/arbitrator_synthesis, keyed by the
  // same unit key as stage_artifacts, taken right before approveStage
  // clears them on advancing to the next unit — what unapproveStage
  // restores from so reopening a unit's rejection interview has real
  // critique content instead of coming back empty.
  stage_panel_history: Record<string, { panel_reviews: PlanningRun["panel_reviews"]; arbitrator_synthesis: unknown }>;
  // Rejection interviews, across the WHOLE run — not reset per unit or per
  // rejection cycle (see the Arbitrator's continuous-memory design).
  // Separate thread from intake_chat_history since intake is a distinct
  // moment with its own job.
  chat_history: PlanningChatMessage[];
  // The one-time pre-Stage-1 conversation where the writer describes what
  // they want in plain language, pastes a reference link, or attaches a
  // document — compiled into the same final_delta_directive field a
  // rejection's directive would use, since mechanically it's the same
  // thing: extra direction for the Generator's next call.
  intake_chat_history: PlanningChatMessage[];
  final_delta_directive: string | null;
  extracted_entities: ExtractedEntityCandidate[] | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// A per-book reference doc for the Contract Pipeline's hook-focused
// generator/critics — see PLATFORM_TRENDS in planningEngine.ts. Refreshed
// on demand via researchPlatformCraftNotes (Claude + web_search/web_fetch),
// but only ever saved when the writer explicitly reviews and confirms the
// draft — never written automatically.
export interface PlatformCraftNotes {
  bookId: string;
  content: string;
  updatedAt: string | null;
}
