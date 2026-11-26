import type { AgentRole, EffortLevel, RealPlanningStage } from "../types/domain.js";

// A "skill" is a server-side reviewer: a rubric of numbered criteria, run by
// its own Claude call (never the session that drafted the text), returning a
// structured verdict the backend validates and stores. See CLAUDE.md "Skill
// Reviews" and docs/skill-research/DESIGN.md.

export type SkillKey =
  | "werewolf_genre"
  | "romance_craft"
  | "erotic_heat"
  | "serial_plotting"
  | "secrets_reveals"
  | "fiction_fundamentals"
  | "anti_slop"
  | "current_market";

export type ReviewTargetType = "prose_fragment" | "prose_scene" | "prose_chapter" | "planning_unit";

export interface SkillCriterion {
  id: string;
  title: string;
  // What the reviewer checks, written as a concrete test.
  check: string;
  // A criterion that can note a weakness but never block on its own (its
  // severity is capped at "minor" by the backend, whatever the model says).
  minorOnly?: boolean;
}

export interface SkillGateInput {
  targetType: ReviewTargetType;
  planningStage: RealPlanningStage | null;
  text: string;
}

export interface SkillDefinition {
  key: SkillKey;
  // agent_prompts role a writer can use to override this skill's rubric.
  role: AgentRole;
  title: string;
  // Lower runs first and survives the cost cap longest.
  priority: number;
  proseTargets: ReviewTargetType[];
  planningStages: RealPlanningStage[];
  criteria: SkillCriterion[];
  // The rubric text (what good looks like, what failure looks like). The
  // criteria list and the output contract are appended by the backend, so a
  // writer override of this text can't drop the contract.
  rubric: string;
  defaultModel: string;
  defaultEffort: EffortLevel;
  // Optional cheap applicability check beyond the stage/target table. Return
  // a reason when the skill should be skipped.
  gate?: (input: SkillGateInput) => Promise<string | null> | string | null;
  // Date the source research was written; reviews after STALE_AFTER_DAYS add
  // a staleness warning (skill 08).
  researchDate?: string;
}

export type CriterionResult = "met" | "not_met" | "n_a";
export type Severity = "none" | "minor" | "major";

export interface CriterionVerdict {
  id: string;
  result: CriterionResult;
  severity: Severity;
  evidence: string;
  note: string;
}

export interface MustFixItem {
  criterionId: string;
  problem: string;
  fix: string;
}

export type SkillResultStatus =
  | "passed"
  | "needs_revision"
  | "failed"
  | "reviewer_error"
  | "not_applicable"
  | "skipped_cost_cap";

export interface SkillResult {
  skill: SkillKey;
  title: string;
  status: SkillResultStatus;
  criteria?: CriterionVerdict[] | undefined;
  mustFix?: MustFixItem[] | undefined;
  summary?: string | undefined;
  // Set for reviewer_error / not_applicable / skipped_cost_cap.
  reason?: string | undefined;
  model?: string | undefined;
  promptSource?: "built_in" | "agent_prompts" | undefined;
  promptVersion?: number | undefined;
  costUsd?: number | undefined;
  usage?: { inputTokens: number | undefined; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  deterministicHits?: unknown | undefined;
  warnings?: string[] | undefined;
}

export type OverallStatus = "passed" | "needs_revision" | "incomplete";

export interface SkillReviewRow {
  id: string;
  book_id: string;
  user_id: string;
  target_type: ReviewTargetType;
  chapter_number: number | null;
  scene_draft_session_id: string | null;
  planning_run_id: string | null;
  planning_unit: string | null;
  planning_stage: string | null;
  text_hash: string;
  word_count: number;
  overall_status: OverallStatus;
  results: SkillResult[];
  cost_usd: number;
  override_reason: string | null;
  overridden_at: string | null;
  created_at: string;
}
