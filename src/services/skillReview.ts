import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "../lib/anthropicClient.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { textMentionsAnyOf } from "../lib/textMatch.js";
import { describeNarration } from "../lib/narration.js";
import { getBookNarrationSetting } from "./narrationSetting.js";
import { getActivePrompt } from "./agentPrompts.js";
import { scanForSlop, countWords, type SlopScanResult } from "../skills/antiSlopScan.js";
import { SKILLS, skillAppliesTo } from "../skills/registry.js";
import type {
  CriterionVerdict,
  MustFixItem,
  OverallStatus,
  ReviewTargetType,
  SkillDefinition,
  SkillKey,
  SkillResult,
  SkillReviewRow,
} from "../skills/types.js";
import type { EffortLevel, RealPlanningStage } from "../types/domain.js";

// Skill reviews: independent reviewer agents, one per skill, run by the
// backend against a piece of text. See CLAUDE.md "Skill Reviews" and
// docs/skill-research/DESIGN.md. The drafting session never supplies the
// context a reviewer sees: it is fetched here, server-side, so a review
// can't be steered by what the author chose to show the grader.

// ---------------------------------------------------------------------------
// Hashing — the link between "this text was reviewed" and "this text is
// being saved". Whitespace-normalized so a trailing newline or re-wrapped
// paragraph doesn't invalidate a review of the same words.
// ---------------------------------------------------------------------------

export function normalizeForHash(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export function hashReviewedText(text: string): string {
  return createHash("sha256").update(normalizeForHash(text), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Pricing — for the cost cap and the stored cost. USD per million tokens.
// Cache writes are billed at 1.25x input (5-minute TTL), reads at the listed
// cache-read price. Unknown models fall back to the most expensive known
// rate so the cap errs on the side of stopping.
// ---------------------------------------------------------------------------

const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
const FALLBACK_PRICE = { input: 10, output: 50, cacheRead: 1 };

function priceFor(model: string) {
  return PRICES[model] ?? FALLBACK_PRICE;
}

export function costOf(model: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  const p = priceFor(model);
  const usd =
    (u.inputTokens * p.input + u.cacheWriteTokens * p.input * 1.25 + u.cacheReadTokens * p.cacheRead + u.outputTokens * p.output) / 1_000_000;
  return Math.round(usd * 10000) / 10000;
}

// Decision (c): $1.00 per review by default. Overridable without a code
// change in case real usage shows the estimate is off.
export function getReviewCostCapUsd(): number {
  const raw = Number(process.env.SKILL_REVIEW_COST_CAP_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 1.0;
}

// Rough pre-call estimate used only for the cap: ~3.5 chars per token, and
// a generous allowance for thinking + output.
const ESTIMATED_OUTPUT_TOKENS = 5000;
function estimateCost(model: string, promptChars: number, cachedChars: number, firstCall: boolean): number {
  const p = priceFor(model);
  const cachedTokens = cachedChars / 3.5;
  const freshTokens = (promptChars - cachedChars) / 3.5;
  const cachedRate = firstCall ? p.input * 1.25 : p.cacheRead;
  return (cachedTokens * cachedRate + freshTokens * p.input + ESTIMATED_OUTPUT_TOKENS * p.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Context gathering (prose). Server-side, deterministic, no LLM calls.
// ---------------------------------------------------------------------------

const PREVIOUS_CHAPTER_TAIL_WORDS = 1200;
const MAX_CODEX_ENTRIES = 10;

function tailWords(text: string, n: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= n) return text.trim();
  return "…" + words.slice(-n).join(" ");
}

interface ParagraphLike {
  text?: unknown;
}

async function chapterPlainText(bookId: string, chapterNumber: number): Promise<string | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("manuscript_chapters")
    .select("paragraphs")
    .eq("book_id", bookId)
    .eq("number", chapterNumber)
    .maybeSingle();
  if (error) throw new Error(`Failed to read chapter ${chapterNumber}: ${error.message}`);
  const paragraphs = (data?.paragraphs ?? []) as ParagraphLike[];
  const text = paragraphs
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter((t) => t.trim())
    .join("\n\n");
  if (text.trim()) return text;

  // Fall back to the RAG index for chapters ingested without an editor row.
  const chunks = await supabase
    .from("manuscript_chunks")
    .select("raw_text, scene_order")
    .eq("book_id", bookId)
    .eq("chapter_number", chapterNumber)
    .order("scene_order", { ascending: true });
  if (chunks.error) throw new Error(`Failed to read chapter ${chapterNumber} chunks: ${chunks.error.message}`);
  const joined = (chunks.data ?? []).map((r) => r.raw_text as string).join("\n\n");
  return joined.trim() ? joined : null;
}

async function chapterBeatsText(bookId: string, chapterNumber: number): Promise<string> {
  const supabase = getSupabaseClient();
  const { data: chapter, error } = await supabase
    .from("manuscript_chapters")
    .select("id")
    .eq("book_id", bookId)
    .eq("number", chapterNumber)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up chapter ${chapterNumber}: ${error.message}`);
  if (!chapter) return "";
  const beats = await supabase
    .from("chapter_beats")
    .select("title, outline_text, order_index")
    .eq("chapter_id", chapter.id)
    .order("order_index", { ascending: true });
  if (beats.error) throw new Error(`Failed to read beats for chapter ${chapterNumber}: ${beats.error.message}`);
  return (beats.data ?? [])
    .map((b, i) => `${i + 1}. ${b.title}${b.outline_text ? ` — ${b.outline_text}` : ""}`)
    .join("\n");
}

async function matchedCodex(bookId: string, text: string): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("codex_entries")
    .select("name, aliases, entry_type, tier, description, personality_traits")
    .eq("book_id", bookId);
  if (error) throw new Error(`Failed to read Codex: ${error.message}`);
  const matched = (data ?? []).filter((e) => textMentionsAnyOf(text, [e.name as string, ...((e.aliases as string[] | null) ?? [])]));
  return matched
    .slice(0, MAX_CODEX_ENTRIES)
    .map((e) => {
      const aliases = (e.aliases as string[] | null)?.length ? ` (aka ${(e.aliases as string[]).join(", ")})` : "";
      const traits = (e.personality_traits as string[] | null)?.length ? `\nTraits: ${(e.personality_traits as string[]).join(", ")}` : "";
      return `### ${e.name}${aliases} [${e.entry_type}${e.tier ? `, ${e.tier}` : ""}]\n${e.description}${traits}`;
    })
    .join("\n\n");
}

export interface ProseContext {
  narration: string | null;
  codex: string;
  previousChapterTail: string | null;
  chapterBeats: string;
}

export async function gatherProseContext(bookId: string, text: string, chapterNumber: number | null): Promise<ProseContext> {
  const [narrationSetting, codex, previous, beats] = await Promise.all([
    getBookNarrationSetting(bookId),
    matchedCodex(bookId, text),
    chapterNumber && chapterNumber > 1 ? chapterPlainText(bookId, chapterNumber - 1) : Promise.resolve(null),
    chapterNumber ? chapterBeatsText(bookId, chapterNumber) : Promise.resolve(""),
  ]);
  return {
    narration: narrationSetting ? describeNarration(narrationSetting) : null,
    codex,
    previousChapterTail: previous ? tailWords(previous, PREVIOUS_CHAPTER_TAIL_WORDS) : null,
    chapterBeats: beats,
  };
}

// ---------------------------------------------------------------------------
// Prompt assembly. The shared block (preamble + context + text under review)
// is byte-identical for every skill in one review, so it is cached once and
// read at the cache price by every later skill.
// ---------------------------------------------------------------------------

const TARGET_LABEL: Record<ReviewTargetType, string> = {
  prose_fragment: "a fragment of manuscript prose (one or a few paragraphs from a draft)",
  prose_scene: "one scene of manuscript prose",
  prose_chapter: "one full chapter of manuscript prose",
  planning_unit: "a planning document (summary, outline or chapter beats), not prose",
};

const REVIEWER_PREAMBLE = `You are an independent editor reviewing work for a serialized adult dark werewolf romance published chapter by chapter on pay-per-chapter platforms. You did not write this text and you are not its author's assistant: you judge it against one craft rubric and report honestly, including when it is good.

The book contains violence and sexual content. That is ordinary for this genre and is not itself a fault; review it the way a professional editor reviews any manuscript. Judge craft only. Quote evidence as short fragments of at most 20 words, choosing neutral wording where the passage is explicit. Never write new prose, never rewrite the passage, never continue the story.`;

export function buildSharedBlock(params: {
  targetType: ReviewTargetType;
  chapterNumber: number | null;
  context: ProseContext | null;
  extraContext?: string | undefined;
  text: string;
}): string {
  const parts = [REVIEWER_PREAMBLE, "", `# What you are reviewing`, `This is ${TARGET_LABEL[params.targetType]}${params.chapterNumber ? `, chapter ${params.chapterNumber}` : ""}.`];
  const c = params.context;
  if (c?.narration) parts.push(`The book's narration setting is ${c.narration}.`);
  if (c?.codex) parts.push("", "# Codex entries for characters, places and things named in the text", c.codex);
  if (c?.chapterBeats) parts.push("", "# The writer's planned beats for this chapter", c.chapterBeats);
  if (c?.previousChapterTail) parts.push("", "# End of the previous chapter (context only — not under review)", c.previousChapterTail);
  if (params.extraContext) parts.push("", params.extraContext);
  parts.push("", "# TEXT UNDER REVIEW", "<text>", params.text, "</text>");
  return parts.join("\n");
}

export function buildSkillBlock(skill: SkillDefinition, rubricText: string, deterministic: SlopScanResult | null): string {
  const criteria = skill.criteria.map((c) => `- ${c.id} — ${c.title}: ${c.check}`).join("\n");
  const parts = [`# Your rubric: ${skill.title}`, rubricText, "", "# Criteria — answer every one", criteria];
  if (deterministic) {
    const hits = deterministic.hits.length
      ? deterministic.hits.map((h) => `- ${h.label} ×${h.count}: ${h.examples.join(" | ")}`).join("\n")
      : "(no hits)";
    parts.push(
      "",
      "# Deterministic phrase scan of the text (regex, not a verdict — decide whether each hit is clustered or replacing a specific detail)",
      `${deterministic.totalHits} hit(s), ${deterministic.proseHitsPer1000} stock-prose hits per 1,000 words.`,
      hits
    );
  }
  parts.push(
    "",
    "# How to answer",
    `For each criterion give result "met", "not_met" or "n_a" (n_a only when the criterion genuinely cannot apply to this text). For not_met, give severity "minor" (a blemish a reader would forgive) or "major" (a reader would notice it and it weakens the chapter); for met or n_a, severity is "none". Evidence is a short quote from the text (max 20 words) or "" when there is nothing to quote. The note is one plain sentence.`,
    `mustFix lists only the major problems, each with a concrete fix a writer could act on (name the object, line or act that is missing) — not a rewrite. summary is two sentences: what works, what most needs fixing. Return only the JSON.`
  );
  return parts.join("\n");
}

export function outputSchema(skill: SkillDefinition): Record<string, unknown> {
  const ids = skill.criteria.map((c) => c.id);
  return {
    type: "object",
    additionalProperties: false,
    required: ["criteria", "mustFix", "summary"],
    properties: {
      criteria: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "result", "severity", "evidence", "note"],
          properties: {
            id: { type: "string", enum: ids },
            result: { type: "string", enum: ["met", "not_met", "n_a"] },
            severity: { type: "string", enum: ["none", "minor", "major"] },
            evidence: { type: "string" },
            note: { type: "string" },
          },
        },
      },
      mustFix: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterionId", "problem", "fix"],
          properties: {
            criterionId: { type: "string", enum: ids },
            problem: { type: "string" },
            fix: { type: "string" },
          },
        },
      },
      summary: { type: "string" },
    },
  };
}

// ---------------------------------------------------------------------------
// The model call, behind an injectable interface so the validation/gating
// logic can be tested without an API key (scripts/test-skill-review.ts).
// ---------------------------------------------------------------------------

export interface ReviewerRequest {
  model: string;
  effort: EffortLevel;
  sharedBlock: string;
  skillBlock: string;
  schema: Record<string, unknown>;
}

export interface ReviewerResponse {
  text: string;
  stopReason: string | null;
  refusalCategory?: string | null;
  servedModel: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

export type ReviewerCaller = (req: ReviewerRequest) => Promise<ReviewerResponse>;

export const anthropicReviewerCaller: ReviewerCaller = async (req) => {
  const client = getAnthropicClient();
  // Server-side refusal fallback: this content will sometimes trip a
  // classifier on the primary model. With "default" routing the API retries
  // the same request on a fallback model inside the same call; the model that
  // actually served it is recorded (servedModel). If the whole chain refuses,
  // stop_reason is still "refusal" and the skill is reported as
  // reviewer_error — never as a pass.
  const response = (await client.beta.messages.create({
    model: req.model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: req.effort, format: { type: "json_schema", schema: req.schema } },
    system: [
      { type: "text", text: req.sharedBlock, cache_control: { type: "ephemeral" } },
      { type: "text", text: req.skillBlock },
    ],
    messages: [{ role: "user", content: "Review the text under review against your rubric now. Answer every criterion." }],
  } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming)) as Anthropic.Beta.BetaMessage;

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const u = response.usage;
  const details = (response as unknown as { stop_details?: { category?: string | null } | null }).stop_details;
  return {
    text,
    stopReason: response.stop_reason,
    refusalCategory: details?.category ?? null,
    servedModel: response.model,
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
  };
};

// ---------------------------------------------------------------------------
// Validation: the backend, not the model, decides the stored status.
// ---------------------------------------------------------------------------

const EVIDENCE_MAX_WORDS = 25;

function clampWords(s: string, n: number): string {
  const words = s.trim().split(/\s+/).filter(Boolean);
  return words.length <= n ? words.join(" ") : words.slice(0, n).join(" ") + " …";
}

function parseJsonLoose(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    try {
      return JSON.parse(m[0]);
    } catch {
      return undefined;
    }
  }
}

// Thresholds: any major problem means the text needs revision; three or more
// means it fails. Minor problems are reported but never block on their own.
export const FAIL_MAJOR_THRESHOLD = 3;

export function validateReviewerOutput(
  skill: SkillDefinition,
  response: ReviewerResponse
): Pick<SkillResult, "status" | "criteria" | "mustFix" | "summary" | "reason"> {
  if (response.stopReason === "refusal") {
    return {
      status: "reviewer_error",
      reason: `The reviewer model declined to review this text (refusal${response.refusalCategory ? `, category: ${response.refusalCategory}` : ""}). This skill did NOT pass; it was not run.`,
    };
  }
  if (!response.text) {
    return { status: "reviewer_error", reason: `The reviewer returned no output (stop_reason: ${response.stopReason ?? "unknown"}).` };
  }
  if (response.stopReason === "max_tokens") {
    return { status: "reviewer_error", reason: "The reviewer's output was cut off at max_tokens; the verdict is incomplete." };
  }
  const parsed = parseJsonLoose(response.text) as { criteria?: unknown; mustFix?: unknown; summary?: unknown } | undefined;
  if (!parsed || !Array.isArray(parsed.criteria)) {
    return { status: "reviewer_error", reason: "The reviewer's output was not the required JSON verdict." };
  }

  const byId = new Map<string, CriterionVerdict>();
  for (const raw of parsed.criteria as Record<string, unknown>[]) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    const def = skill.criteria.find((c) => c.id === id);
    if (!def || byId.has(id)) continue;
    const result = raw.result === "met" || raw.result === "not_met" || raw.result === "n_a" ? raw.result : null;
    if (!result) continue;
    let severity: CriterionVerdict["severity"] = raw.severity === "minor" || raw.severity === "major" ? raw.severity : "none";
    if (result !== "not_met") severity = "none";
    else if (severity === "none") severity = "minor";
    if (def.minorOnly && severity === "major") severity = "minor";
    byId.set(id, {
      id,
      result,
      severity,
      evidence: clampWords(typeof raw.evidence === "string" ? raw.evidence : "", EVIDENCE_MAX_WORDS),
      note: typeof raw.note === "string" ? raw.note.trim() : "",
    });
  }

  const missing = skill.criteria.filter((c) => !byId.has(c.id)).map((c) => c.id);
  if (missing.length > 0) {
    return {
      status: "reviewer_error",
      reason: `The reviewer did not answer every criterion (missing: ${missing.join(", ")}). A partial verdict is not treated as a pass.`,
    };
  }

  const criteria = skill.criteria.map((c) => byId.get(c.id)!);
  const majors = criteria.filter((c) => c.severity === "major");
  const rawMustFix = Array.isArray(parsed.mustFix) ? (parsed.mustFix as Record<string, unknown>[]) : [];
  const mustFix: MustFixItem[] = [];
  for (const m of rawMustFix) {
    const id = typeof m?.criterionId === "string" ? m.criterionId : "";
    if (!majors.some((c) => c.id === id)) continue;
    mustFix.push({ criterionId: id, problem: String(m.problem ?? "").trim(), fix: String(m.fix ?? "").trim() });
  }
  // Every major problem must have a fix line, even if the model forgot one.
  for (const c of majors) {
    if (!mustFix.some((m) => m.criterionId === c.id)) mustFix.push({ criterionId: c.id, problem: c.note, fix: "(reviewer gave no fix — see the note)" });
  }

  const status = majors.length >= FAIL_MAJOR_THRESHOLD ? "failed" : majors.length > 0 ? "needs_revision" : "passed";
  return { status, criteria, mustFix, summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "" };
}

export function overallStatusOf(results: SkillResult[]): OverallStatus {
  if (results.some((r) => r.status === "reviewer_error" || r.status === "skipped_cost_cap")) return "incomplete";
  if (results.some((r) => r.status === "needs_revision" || r.status === "failed")) return "needs_revision";
  return "passed";
}

// ---------------------------------------------------------------------------
// Running a review.
// ---------------------------------------------------------------------------

export interface RunSkillReviewParams {
  bookId: string;
  userId: string;
  text: string;
  targetType: ReviewTargetType;
  chapterNumber?: number | null;
  sceneDraftSessionId?: string | null;
  planningRunId?: string | null;
  planningUnit?: string | null;
  planningStage?: RealPlanningStage | null;
  // Planning reviews supply their own context (vision, parent, ledger).
  extraContext?: string | undefined;
  // Restrict to some skills (e.g. a re-review of just anti_slop).
  onlySkills?: SkillKey[];
}

export interface SkillReviewDeps {
  caller?: ReviewerCaller;
  // Test hook: skip Supabase for context/persistence.
  contextOverride?: ProseContext | null;
  persist?: (row: Omit<SkillReviewRow, "id" | "created_at" | "override_reason" | "overridden_at">) => Promise<SkillReviewRow>;
  resolvePrompt?: (skill: SkillDefinition, bookId: string, stage: RealPlanningStage | "prose") => Promise<ResolvedPrompt>;
}

interface ResolvedPrompt {
  rubric: string;
  model: string;
  effort: EffortLevel;
  source: "built_in" | "agent_prompts";
  version?: number;
}

async function resolvePromptDefault(skill: SkillDefinition, bookId: string, stage: RealPlanningStage | "prose"): Promise<ResolvedPrompt> {
  try {
    const row = await getActivePrompt(bookId, skill.role, stage);
    return { rubric: row.system_prompt, model: row.model, effort: row.effort, source: "agent_prompts", version: row.version };
  } catch (err) {
    // "No active prompt configured" is the normal case: the built-in rubric
    // applies. Any other failure (database down) is surfaced, not swallowed.
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("No active prompt configured")) throw err;
    return { rubric: skill.rubric, model: skill.defaultModel, effort: skill.defaultEffort, source: "built_in" };
  }
}

async function persistDefault(row: Omit<SkillReviewRow, "id" | "created_at" | "override_reason" | "overridden_at">): Promise<SkillReviewRow> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("skill_reviews").insert(row).select("*").single();
  if (error) throw new Error(`Failed to store skill review: ${error.message}`);
  return data as SkillReviewRow;
}

export async function runSkillReview(params: RunSkillReviewParams, deps: SkillReviewDeps = {}): Promise<SkillReviewRow> {
  const text = params.text ?? "";
  if (!text.trim()) throw new Error("text is required and must not be empty.");
  const caller = deps.caller ?? anthropicReviewerCaller;
  const resolvePrompt = deps.resolvePrompt ?? resolvePromptDefault;
  const persist = deps.persist ?? persistDefault;
  const stage = params.planningStage ?? null;
  const chapterNumber = params.chapterNumber ?? null;

  const context =
    deps.contextOverride !== undefined
      ? deps.contextOverride
      : params.targetType === "planning_unit"
        ? null
        : await gatherProseContext(params.bookId, text, chapterNumber);

  const sharedBlock = buildSharedBlock({ targetType: params.targetType, chapterNumber, context, extraContext: params.extraContext, text });
  const slopScan = scanForSlop(text);

  const results: SkillResult[] = [];
  const toRun: { skill: SkillDefinition; prompt: ResolvedPrompt; skillBlock: string }[] = [];

  for (const skill of SKILLS) {
    if (params.onlySkills && !params.onlySkills.includes(skill.key)) continue;
    if (!skillAppliesTo(skill, params.targetType, stage)) {
      results.push({ skill: skill.key, title: skill.title, status: "not_applicable", reason: `Does not apply to ${params.targetType}${stage ? ` at ${stage}` : ""}.` });
      continue;
    }
    const gateReason = skill.gate ? await skill.gate({ targetType: params.targetType, planningStage: stage, text }) : null;
    if (gateReason) {
      results.push({ skill: skill.key, title: skill.title, status: "not_applicable", reason: gateReason });
      continue;
    }
    const prompt = await resolvePrompt(skill, params.bookId, stage ?? "prose");
    const skillBlock = buildSkillBlock(skill, prompt.rubric, skill.key === "anti_slop" ? slopScan : null);
    toRun.push({ skill, prompt, skillBlock });
  }

  // Cost cap: estimate in priority order and skip what doesn't fit. A skipped
  // skill makes the review "incomplete" — it is never silently dropped.
  const cap = getReviewCostCapUsd();
  let estimated = 0;
  const admitted: typeof toRun = [];
  toRun.forEach((item, i) => {
    const est = estimateCost(item.prompt.model, sharedBlock.length + item.skillBlock.length, sharedBlock.length, i === 0);
    if (estimated + est > cap) {
      results.push({
        skill: item.skill.key,
        title: item.skill.title,
        status: "skipped_cost_cap",
        reason: `Skipped: estimated cost would pass the $${cap.toFixed(2)} cap for one review (SKILL_REVIEW_COST_CAP_USD).`,
      });
    } else {
      estimated += est;
      admitted.push(item);
    }
  });

  const runOne = async (item: (typeof toRun)[number]): Promise<SkillResult> => {
    const base: SkillResult = {
      skill: item.skill.key,
      title: item.skill.title,
      status: "reviewer_error",
      model: item.prompt.model,
      promptSource: item.prompt.source,
      promptVersion: item.prompt.version,
    };
    if (item.skill.key === "anti_slop") base.deterministicHits = slopScan;
    try {
      const response = await caller({
        model: item.prompt.model,
        effort: item.prompt.effort,
        sharedBlock,
        skillBlock: item.skillBlock,
        schema: outputSchema(item.skill),
      });
      const verdict = validateReviewerOutput(item.skill, response);
      const warnings: string[] = [];
      if (response.servedModel && response.servedModel !== item.prompt.model) {
        warnings.push(`Served by fallback model ${response.servedModel} after ${item.prompt.model} declined.`);
      }
      return {
        ...base,
        ...verdict,
        model: response.servedModel || item.prompt.model,
        usage: response.usage,
        costUsd: costOf(response.servedModel || item.prompt.model, response.usage),
        warnings: warnings.length ? warnings : undefined,
      };
    } catch (err) {
      return { ...base, reason: `Reviewer call failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  // First skill alone (writes the shared-context cache), the rest in parallel
  // (they read it). Anthropic calls only — Hanami's 1-parallel limit doesn't
  // apply here.
  if (admitted.length > 0) {
    results.push(await runOne(admitted[0]!));
    results.push(...(await Promise.all(admitted.slice(1).map(runOne))));
  }

  const order = new Map(SKILLS.map((s, i) => [s.key, i]));
  results.sort((a, b) => (order.get(a.skill) ?? 0) - (order.get(b.skill) ?? 0));
  const cost = Math.round(results.reduce((s, r) => s + (r.costUsd ?? 0), 0) * 10000) / 10000;

  return persist({
    book_id: params.bookId,
    user_id: params.userId,
    target_type: params.targetType,
    chapter_number: chapterNumber,
    scene_draft_session_id: params.sceneDraftSessionId ?? null,
    planning_run_id: params.planningRunId ?? null,
    planning_unit: params.planningUnit ?? null,
    planning_stage: stage,
    text_hash: hashReviewedText(text),
    word_count: countWords(text),
    overall_status: overallStatusOf(results),
    results,
    cost_usd: cost,
  });
}

// ---------------------------------------------------------------------------
// Reading reviews.
// ---------------------------------------------------------------------------

export async function getSkillReview(id: string): Promise<SkillReviewRow> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("skill_reviews").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Failed to load skill review: ${error.message}`);
  if (!data) throw new Error(`No skill review found with id ${id}.`);
  return data as SkillReviewRow;
}

export async function listSkillReviews(params: { bookId: string; chapterNumber?: number; planningRunId?: string; limit?: number }): Promise<SkillReviewRow[]> {
  const supabase = getSupabaseClient();
  let q = supabase.from("skill_reviews").select("*").eq("book_id", params.bookId).order("created_at", { ascending: false }).limit(params.limit ?? 50);
  if (params.chapterNumber !== undefined) q = q.eq("chapter_number", params.chapterNumber);
  if (params.planningRunId) q = q.eq("planning_run_id", params.planningRunId);
  const { data, error } = await q;
  if (error) throw new Error(`Failed to list skill reviews: ${error.message}`);
  return (data ?? []) as SkillReviewRow[];
}

// ---------------------------------------------------------------------------
// The acceptance gate (decision (a)): reviewing is mandatory, passing is
// not — but accepting text over an unpassed review requires a stated writer
// decision, which is stored on the review and shown back.
// ---------------------------------------------------------------------------

export class SkillReviewGateError extends Error {}

export interface GateOutcome {
  review: SkillReviewRow;
  overridden: boolean;
  note: string;
}

export function describeReview(review: SkillReviewRow): string {
  const lines = [`Skill review ${review.id}: ${review.overall_status.toUpperCase()} (${review.word_count} words, $${Number(review.cost_usd).toFixed(4)}).`];
  for (const r of review.results) {
    if (r.status === "not_applicable") continue;
    let line = `- ${r.title}: ${r.status}`;
    if (r.reason) line += ` — ${r.reason}`;
    else if (r.summary) line += ` — ${r.summary}`;
    lines.push(line);
    for (const m of r.mustFix ?? []) lines.push(`    MUST FIX [${m.criterionId}] ${m.problem} → ${m.fix}`);
    for (const w of r.warnings ?? []) lines.push(`    note: ${w}`);
  }
  return lines.join("\n");
}

export async function checkReviewForAcceptance(
  params: { bookId: string; text: string; skillReviewId: string; writerOverride?: string | null },
  deps: { load?: (id: string) => Promise<SkillReviewRow>; recordOverride?: (id: string, reason: string) => Promise<void> } = {}
): Promise<GateOutcome> {
  const load = deps.load ?? getSkillReview;
  const recordOverride = deps.recordOverride ?? recordOverrideDefault;

  let review: SkillReviewRow;
  try {
    review = await load(params.skillReviewId);
  } catch (err) {
    throw new SkillReviewGateError(
      `Not saved: ${err instanceof Error ? err.message : String(err)} Run run_skill_review on the exact text you want to save, then pass the returned reviewId as skillReviewId.`
    );
  }
  if (review.book_id !== params.bookId) {
    throw new SkillReviewGateError("Not saved: that skill review belongs to a different book.");
  }
  if (review.text_hash !== hashReviewedText(params.text)) {
    throw new SkillReviewGateError(
      "Not saved: the text you are saving is not the text that was reviewed (the content hash differs). Any edit after a review needs a fresh run_skill_review on the final text."
    );
  }
  if (review.overall_status === "passed") {
    return { review, overridden: false, note: `Skill review ${review.id} passed.` };
  }
  const reason = params.writerOverride?.trim();
  if (!reason) {
    throw new SkillReviewGateError(
      `Not saved: the skill review did not pass.\n${describeReview(review)}\n\nShow these findings to the writer. Either revise the text and run run_skill_review again, or — only if the writer decides to keep it as is — call this again with writerOverride set to the writer's reason in their own words. The override is stored and shown to the writer.`
    );
  }
  await recordOverride(review.id, reason);
  return {
    review,
    overridden: true,
    note: `Saved OVER an unpassed skill review (${review.overall_status}); writer override recorded: "${reason}".`,
  };
}

async function recordOverrideDefault(id: string, reason: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("skill_reviews").update({ override_reason: reason, overridden_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(`Failed to record writer override on skill review: ${error.message}`);
}
