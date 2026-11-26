import type { RealPlanningStage } from "../types/domain.js";
import { gatekeeperSkill } from "./rubrics/gatekeeper.js";
import { antiSlopSkill } from "./rubrics/antiSlop.js";
import { werewolfGenreSkill } from "./rubrics/werewolfGenre.js";
import { romanceCraftSkill } from "./rubrics/romanceCraft.js";
import { eroticHeatSkill } from "./rubrics/eroticHeat.js";
import { serialPlottingSkill } from "./rubrics/serialPlotting.js";
import { secretsRevealsSkill } from "./rubrics/secretsReveals.js";
import { fictionFundamentalsSkill } from "./rubrics/fictionFundamentals.js";
import { currentMarketSkill } from "./rubrics/currentMarket.js";
import type { ReviewTargetType, SkillDefinition, SkillKey } from "./types.js";

// Skill 03 runs only on intimate text. A cheap keyword gate, not a model
// call: it errs toward running (a false positive costs one subagent run in
// which every criterion is n_a; a false negative would skip a heat review).
const INTIMATE = /\b(kiss(?:ed|ing|es)?|naked|nude|undress(?:ed|ing)?|breasts?|nipples?|thighs?|hips?|moan(?:ed|ing|s)?|aroused|arousal|erection|hard against|cock|cunt|pussy|clit|orgasm|came apart|climax|sex|fuck(?:ed|ing)?|bed(?:ded)?|touch(?:ed|ing)? me|inside me|tongue|lips? on|straddl\w*|grind(?:ing)?|heat|rut|knot(?:ted)?|mate(?:d)? with|claim(?:ed|ing)? (?:me|her))\b/gi;
const MIN_INTIMATE_HITS = 3;

export function intimacyGate(text: string): string | null {
  const hits = text.match(INTIMATE)?.length ?? 0;
  return hits >= MIN_INTIMATE_HITS ? null : `No intimate content detected (${hits} intimacy keyword(s); runs at ${MIN_INTIMATE_HITS}+).`;
}

const heatWithGate: SkillDefinition = { ...eroticHeatSkill, gate: ({ text }) => intimacyGate(text) };

// Every skill the backend knows, gatekeeper first. Adding a skill is a rubric
// file plus one line here.
export const SKILLS: SkillDefinition[] = [
  gatekeeperSkill,
  antiSlopSkill,
  werewolfGenreSkill,
  romanceCraftSkill,
  heatWithGate,
  serialPlottingSkill,
  secretsRevealsSkill,
  fictionFundamentalsSkill,
  currentMarketSkill,
].sort((a, b) => a.priority - b.priority);

export function getSkill(key: SkillKey): SkillDefinition | undefined {
  return SKILLS.find((s) => s.key === key);
}

// The stage table (docs/process/GATEKEEPER_CLASH_ANALYSIS.md section 4, approved).
export function skillAppliesTo(skill: SkillDefinition, targetType: ReviewTargetType, planningStage: RealPlanningStage | null): boolean {
  if (targetType === "planning_unit") return planningStage !== null && skill.planningStages.includes(planningStage);
  return skill.proseTargets.includes(targetType);
}

// Skill 08's facts are a dated snapshot; reviews after this many days say so.
export const MARKET_STALE_AFTER_DAYS = 90;
