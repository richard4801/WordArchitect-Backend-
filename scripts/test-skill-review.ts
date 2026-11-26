// Offline tests for skill reviews: verdict validation, refusal/empty/partial
// handling, cost cap, the acceptance gate, and the deterministic anti-slop
// scan. Uses a stub reviewer — no API key, no database.
// Run: npm run test:skills
import assert from "node:assert/strict";
import {
  runSkillReview,
  validateReviewerOutput,
  checkReviewForAcceptance,
  hashReviewedText,
  SkillReviewGateError,
  type ReviewerCaller,
  type ReviewerResponse,
} from "../src/services/skillReview.js";
import { antiSlopSkill } from "../src/skills/rubrics/antiSlop.js";
import { scanForSlop } from "../src/skills/antiSlopScan.js";
import type { SkillReviewRow } from "../src/skills/types.js";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`ok  ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

const usage = { inputTokens: 9000, outputTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0 };
function verdict(overrides: Record<string, { result: string; severity: string }> = {}, drop: string[] = []): string {
  return JSON.stringify({
    criteria: antiSlopSkill.criteria
      .filter((c) => !drop.includes(c.id))
      .map((c) => ({ id: c.id, result: overrides[c.id]?.result ?? "met", severity: overrides[c.id]?.severity ?? "none", evidence: "", note: `note ${c.id}` })),
    mustFix: Object.entries(overrides)
      .filter(([, v]) => v.severity === "major")
      .map(([id]) => ({ criterionId: id, problem: `problem ${id}`, fix: `fix ${id}` })),
    summary: "Two sentences.",
  });
}
function resp(text: string, stopReason = "end_turn", extra: Partial<ReviewerResponse> = {}): ReviewerResponse {
  return { text, stopReason, servedModel: "claude-opus-5-5", usage, ...extra };
}

const memory = new Map<string, SkillReviewRow>();
const persist = async (row: Omit<SkillReviewRow, "id" | "created_at" | "override_reason" | "overridden_at">) => {
  const full: SkillReviewRow = { ...row, id: `rev-${memory.size + 1}`, created_at: new Date().toISOString(), override_reason: null, overridden_at: null };
  memory.set(full.id, full);
  return full;
};
const builtIn = async () => ({ rubric: antiSlopSkill.rubric, model: "claude-opus-5-5", effort: "medium" as const, source: "built_in" as const });
const TEXT = "I set the pie on her knee and didn't take my hand back.\n\nShe ate it anyway, glaring.";

await test("all criteria met → passed", () => {
  const v = validateReviewerOutput(antiSlopSkill, resp(verdict()));
  assert.equal(v.status, "passed");
});
await test("one major → needs_revision, with its must-fix", () => {
  const v = validateReviewerOutput(antiSlopSkill, resp(verdict({ AS2: { result: "not_met", severity: "major" } })));
  assert.equal(v.status, "needs_revision");
  assert.equal(v.mustFix?.length, 1);
});
await test("three majors → failed", () => {
  const major = { result: "not_met", severity: "major" };
  const v = validateReviewerOutput(antiSlopSkill, resp(verdict({ AS1: major, AS2: major, AS6: major })));
  assert.equal(v.status, "failed");
});
await test("minors never block", () => {
  const minor = { result: "not_met", severity: "minor" };
  const v = validateReviewerOutput(antiSlopSkill, resp(verdict({ AS1: minor, AS3: minor, AS4: minor, AS10: minor })));
  assert.equal(v.status, "passed");
});
await test("minorOnly criterion (AS11) is capped at minor", () => {
  const v = validateReviewerOutput(antiSlopSkill, resp(verdict({ AS11: { result: "not_met", severity: "major" } })));
  assert.equal(v.status, "passed");
  assert.equal(v.criteria?.find((c) => c.id === "AS11")?.severity, "minor");
});
await test("major with no must-fix line gets one synthesized", () => {
  const raw = JSON.parse(verdict({ AS5: { result: "not_met", severity: "major" } }));
  raw.mustFix = [];
  const v = validateReviewerOutput(antiSlopSkill, resp(JSON.stringify(raw)));
  assert.equal(v.mustFix?.[0]?.criterionId, "AS5");
});
await test("refusal → reviewer_error, never a pass", () => {
  const v = validateReviewerOutput(antiSlopSkill, resp("", "refusal", { refusalCategory: "general_harms" }));
  assert.equal(v.status, "reviewer_error");
  assert.match(v.reason ?? "", /declined/);
});
await test("empty output → reviewer_error", () => {
  assert.equal(validateReviewerOutput(antiSlopSkill, resp("")).status, "reviewer_error");
});
await test("truncated at max_tokens → reviewer_error", () => {
  assert.equal(validateReviewerOutput(antiSlopSkill, resp(verdict(), "max_tokens")).status, "reviewer_error");
});
await test("prose instead of JSON → reviewer_error", () => {
  assert.equal(validateReviewerOutput(antiSlopSkill, resp("This chapter is mostly fine.")).status, "reviewer_error");
});
await test("missing criteria → reviewer_error naming them", () => {
  const v = validateReviewerOutput(antiSlopSkill, resp(verdict({}, ["AS7", "AS9"])));
  assert.equal(v.status, "reviewer_error");
  assert.match(v.reason ?? "", /AS7, AS9/);
});
await test("evidence is clamped to 25 words", () => {
  const raw = JSON.parse(verdict());
  raw.criteria[0].evidence = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  const v = validateReviewerOutput(antiSlopSkill, resp(JSON.stringify(raw)));
  assert.ok((v.criteria?.[0]?.evidence.split(" ").length ?? 99) <= 26);
});

await test("runSkillReview: stores hash, cost, overall passed", async () => {
  const caller: ReviewerCaller = async () => resp(verdict());
  const row = await runSkillReview(
    { bookId: "b1", userId: "u1", text: TEXT, targetType: "prose_scene", chapterNumber: 3 },
    { caller, persist, contextOverride: null, resolvePrompt: builtIn }
  );
  assert.equal(row.overall_status, "passed");
  assert.equal(row.text_hash, hashReviewedText(TEXT));
  assert.ok(row.cost_usd > 0);
  const slop = row.results.find((r) => r.skill === "anti_slop");
  assert.ok(slop?.deterministicHits);
});
await test("runSkillReview: a thrown API error becomes reviewer_error → incomplete", async () => {
  const caller: ReviewerCaller = async () => {
    throw new Error("529 overloaded");
  };
  const row = await runSkillReview(
    { bookId: "b1", userId: "u1", text: TEXT, targetType: "prose_scene" },
    { caller, persist, contextOverride: null, resolvePrompt: builtIn }
  );
  assert.equal(row.overall_status, "incomplete");
  assert.match(row.results[0]?.reason ?? "", /529/);
});
await test("runSkillReview: cost cap skips and marks incomplete", async () => {
  process.env.SKILL_REVIEW_COST_CAP_USD = "0.0001";
  let called = false;
  const caller: ReviewerCaller = async () => {
    called = true;
    return resp(verdict());
  };
  const row = await runSkillReview(
    { bookId: "b1", userId: "u1", text: TEXT, targetType: "prose_scene" },
    { caller, persist, contextOverride: null, resolvePrompt: builtIn }
  );
  delete process.env.SKILL_REVIEW_COST_CAP_USD;
  assert.equal(called, false);
  assert.equal(row.results[0]?.status, "skipped_cost_cap");
  assert.equal(row.overall_status, "incomplete");
});

const load = async (id: string) => {
  const r = memory.get(id);
  if (!r) throw new Error(`No skill review found with id ${id}.`);
  return r;
};
const overrides: string[] = [];
const recordOverride = async (_id: string, reason: string) => {
  overrides.push(reason);
};

await test("gate: passed review + same text (whitespace differences ok) → allowed", async () => {
  const out = await checkReviewForAcceptance({ bookId: "b1", text: `  ${TEXT}\n\n`, skillReviewId: "rev-1" }, { load, recordOverride });
  assert.equal(out.overridden, false);
});
await test("gate: edited text → refused", async () => {
  await assert.rejects(
    checkReviewForAcceptance({ bookId: "b1", text: TEXT + " Then she left.", skillReviewId: "rev-1" }, { load, recordOverride }),
    (e: unknown) => e instanceof SkillReviewGateError && /hash/.test((e as Error).message)
  );
});
await test("gate: wrong book → refused", async () => {
  await assert.rejects(checkReviewForAcceptance({ bookId: "b2", text: TEXT, skillReviewId: "rev-1" }, { load, recordOverride }), SkillReviewGateError);
});
await test("gate: unknown review id → refused", async () => {
  await assert.rejects(checkReviewForAcceptance({ bookId: "b1", text: TEXT, skillReviewId: "nope" }, { load, recordOverride }), SkillReviewGateError);
});
await test("gate: unpassed review without override → refused, findings listed", async () => {
  await assert.rejects(
    checkReviewForAcceptance({ bookId: "b1", text: TEXT, skillReviewId: "rev-2" }, { load, recordOverride }),
    (e: unknown) => e instanceof SkillReviewGateError && /did not pass/.test((e as Error).message)
  );
});
await test("gate: unpassed review with blank override → refused", async () => {
  await assert.rejects(checkReviewForAcceptance({ bookId: "b1", text: TEXT, skillReviewId: "rev-2", writerOverride: "   " }, { load, recordOverride }), SkillReviewGateError);
});
await test("gate: unpassed review with writer override → allowed and recorded", async () => {
  const out = await checkReviewForAcceptance({ bookId: "b1", text: TEXT, skillReviewId: "rev-2", writerOverride: "Keeping it; the API was down." }, { load, recordOverride });
  assert.equal(out.overridden, true);
  assert.deepEqual(overrides, ["Keeping it; the API was down."]);
});

await test("scan: catches stock phrases, ignores clean prose", () => {
  const sloppy =
    "Something flickered across his face. Her voice was barely above a whisper as she took a deep breath, his eyes never leaving hers. It was a pivotal moment, highlighting their evolving dynamic. Nothing would ever be the same.";
  const scan = scanForSlop(sloppy);
  const ids = scan.hits.map((h) => h.id);
  for (const id of ["flicker", "barely_whisper", "deep_breath", "eyes_never_leaving", "pivotal", "highlighting", "evolving", "never_the_same"]) {
    assert.ok(ids.includes(id), `expected ${id}`);
  }
  assert.equal(scanForSlop(TEXT).totalHits, 0);
});

console.log(`\n${passed} passed`);
