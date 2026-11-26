import type { AgentRole, RealPlanningStage } from "../types/domain.js";

// A "skill" is a reviewer the backend defines and a subagent in the author's
// chat runs (author's decision, 26 Nov): the backend owns the rubric, builds
// the brief, and validates and stores the verdict; an independent subagent,
// not the session that drafted the text, does the judging. See CLAUDE.md
// "Skill Reviews" and docs/process/SYSTEM_DESIGN.md section 4b.

export type SkillKey =
  | "werewolf_genre"
  | "romance_craft"
  | "erotic_heat"
  | "serial_plotting"
  | "secrets_reveals"
  | "fiction_fundamentals"
  | "anti_slop"
  | "current_market"
  | "gatekeeper";

export type ReviewTargetType = "prose_fragment" | "prose_scene" | "prose_chapter" | "planning_unit";

export interface SkillCriterion {
  id: string;
  title: string;
  // What the reviewer checks, written as a concrete test.
  check: string;
  // A criterion that can note a weakness but never rise above NOTE on its own
  // (its severity is capped at "minor" by the backend, whatever is submitted).
  minorOnly?: boolean;
}

export interface SkillGateInput {
  targetType: ReviewTargetType;
  planningStage: RealPlanningStage | null;
  text: string;
}

// The verdict ladder (approved 26 Nov, GATEKEEPER_CLASH_ANALYSIS.md section 3):
// BLOCK stops the next step until fixed or overridden by the author; FLAG is a
// weakness with a fix shape, shown and stored, never blocking; NOTE is advisory.
// Craft skills can emit nothing stronger than FLAG.
export type FindingLevel = "BLOCK" | "FLAG" | "NOTE";

export interface SkillDefinition {
  key: SkillKey;
  // agent_prompts role a writer can use to override this skill's rubric text.
  role: AgentRole;
  title: string;
  // Lower is listed first.
  priority: number;
  proseTargets: ReviewTargetType[];
  planningStages: RealPlanningStage[];
  criteria: SkillCriterion[];
  // The rubric text (what good looks like, what failure looks like). The
  // criteria list and the output contract are appended by the backend, so a
  // writer override of this text can't drop the contract.
  rubric: string;
  // Highest level this skill's findings can reach on the ladder.
  maxLevel: FindingLevel;
  // Named in the launch prompt; the subagent reports the model it ran on.
  reviewerModel: string;
  // Optional applicability check beyond the stage/target table. Return a
  // reason when the skill should be skipped.
  gate?: (input: SkillGateInput) => Promise<string | null> | string | null;
  // Date the source research was written (skill 08 warns when stale).
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

export interface Finding {
  level: FindingLevel;
  criterionId: string;
  evidence: string;
  problem: string;
  fix: string;
}

export interface SubmittedVerdict {
  criteria: CriterionVerdict[];
  findings: Finding[];
  summary: string;
}

export type ReviewItemStatus = "pending" | "passed" | "flagged" | "blocked" | "reviewer_error" | "not_applicable";

export interface ReviewItemRow {
  id: string;
  review_id: string;
  skill: SkillKey;
  status: ReviewItemStatus;
  brief: { title: string; skillBlock: string; criterionIds: string[]; promptSource: "built_in" | "agent_prompts"; promptVersion?: number | undefined };
  verdict: SubmittedVerdict | null;
  reason: string | null;
  reviewer_model: string | null;
  submit_attempts: number;
  submitted_at: string | null;
  created_at: string;
}

export type OverallStatus = "pending" | "passed" | "flagged" | "blocked" | "incomplete";

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
  // Kept for compatibility with migration 034; the per-skill truth lives in
  // skill_review_items (migration 035). Holds a summary snapshot.
  results: unknown;
  cost_usd: number;
  override_reason: string | null;
  overridden_at: string | null;
  reviewed_text: string | null;
  context_pack: unknown;
  created_at: string;
}
