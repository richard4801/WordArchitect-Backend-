import type { RealPlanningStage } from "../types/domain.js";
import { antiSlopSkill } from "./rubrics/antiSlop.js";
import type { ReviewTargetType, SkillDefinition, SkillKey } from "./types.js";

// Every skill the backend knows, in priority order. Adding a skill is a
// rubric file plus one line here; nothing else in the review pipeline is
// skill-specific except skill 07's deterministic pre-pass.
export const SKILLS: SkillDefinition[] = [antiSlopSkill].sort((a, b) => a.priority - b.priority);

export function getSkill(key: SkillKey): SkillDefinition | undefined {
  return SKILLS.find((s) => s.key === key);
}

// The stage/target table (decision (b) in docs/skill-research/DESIGN.md).
export function skillAppliesTo(skill: SkillDefinition, targetType: ReviewTargetType, planningStage: RealPlanningStage | null): boolean {
  if (targetType === "planning_unit") return planningStage !== null && skill.planningStages.includes(planningStage);
  return skill.proseTargets.includes(targetType);
}
