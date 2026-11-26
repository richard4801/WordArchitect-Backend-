// Offline tests for skill reviews run by chat subagents: request → brief →
// submit (criteria complete, quotes verbatim, ladder) → the save gate. Uses
// an in-memory store: no API key, no database. Run: npm run test:skills
import assert from "node:assert/strict";
import {
  requestReviews,
  getReviewBrief,
  submitReviewVerdict,
  validateSubmission,
  checkReviewForAcceptance,
  findMissingQuotePieces,
  overallFromItems,
  SkillReviewGateError,
  MAX_SUBMIT_ATTEMPTS,
  type ReviewStore,
} from "../src/services/skillReview.js";
import { antiSlopSkill } from "../src/skills/rubrics/antiSlop.js";
import { scanForSlop } from "../src/skills/antiSlopScan.js";
import type { ReviewItemRow, SkillReviewRow } from "../src/skills/types.js";

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

function memoryStore(): ReviewStore {
  const reviews = new Map<string, SkillReviewRow>();
  const items = new Map<string, ReviewItemRow>();
  let n = 0;
  return {
    async insertReview(row) {
      const r = { ...row, id: `rev-${++n}`, created_at: "", override_reason: null, overridden_at: null } as SkillReviewRow;
      reviews.set(r.id, r);
      return r;
    },
    async insertItems(rows) {
      return rows.map((row) => {
        const i = { verdict: null, reason: null, reviewer_model: null, submit_attempts: 0, submitted_at: null, ...row, id: `item-${++n}`, created_at: "" } as ReviewItemRow;
        items.set(i.id, i);
        return i;
      });
    },
    async getReview(id) {
      const r = reviews.get(id);
      if (!r) throw new Error(`No skill review found with id ${id}.`);
      return r;
    },
    async getItem(id) {
      const i = items.get(id);
      if (!i) throw new Error(`No review brief found with id ${id}.`);
      return i;
    },
    async listItems(reviewId) {
      return [...items.values()].filter((i) => i.review_id === reviewId);
    },
    async updateItem(id, patch) {
      const i = { ...items.get(id)!, ...patch };
      items.set(id, i);
      return i;
    },
    async updateReview(id, patch) {
      reviews.set(id, { ...reviews.get(id)!, ...patch });
    },
    async listReviews() {
      return [...reviews.values()];
    },
  };
}

const TEXT =
  "I set the pie on her knee and didn't take my hand back.\n\nShe ate it anyway, glaring at me over the crust, and when she was done she balled up the paper and shoved it at my chest.";
const builtIn = async () => ({ rubric: antiSlopSkill.rubric, source: "built_in" as const });

function verdict(over: Record<string, { result: string; severity: string; evidence?: string }> = {}, drop: string[] = []) {
  return {
    criteria: antiSlopSkill.criteria
      .filter((c) => !drop.includes(c.id))
      .map((c) => ({ id: c.id, result: over[c.id]?.result ?? "met", severity: over[c.id]?.severity ?? "none", evidence: over[c.id]?.evidence ?? "", note: `note ${c.id}` })),
    mustFix: Object.entries(over)
      .filter(([, v]) => v.severity === "major")
      .map(([id]) => ({ criterionId: id, problem: `problem ${id}`, fix: `fix ${id}` })),
    summary: "Two sentences.",
  };
}

// --- validation -------------------------------------------------------------

await test("all met → passed", () => {
  const r = validateSubmission(antiSlopSkill, verdict(), TEXT);
  assert.ok(r.ok && r.status === "passed");
});
await test("a major from a craft skill is a FLAG, never a BLOCK (approved ladder)", () => {
  const r = validateSubmission(antiSlopSkill, verdict({ AS4: { result: "not_met", severity: "major", evidence: "balled up the paper" } }), TEXT);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.status, "flagged");
    assert.equal(r.verdict.findings[0]?.level, "FLAG");
  }
});
await test("minors become NOTEs and the item passes", () => {
  const r = validateSubmission(antiSlopSkill, verdict({ AS1: { result: "not_met", severity: "minor" }, AS3: { result: "not_met", severity: "minor" } }), TEXT);
  assert.ok(r.ok && r.status === "passed" && r.verdict.findings.every((f) => f.level === "NOTE"));
});
await test("minorOnly criterion can't be raised to FLAG", () => {
  const r = validateSubmission(antiSlopSkill, verdict({ AS11: { result: "not_met", severity: "major", evidence: "glaring at me" } }), TEXT);
  assert.ok(r.ok && r.status === "passed");
});
await test("a quote not in the text is rejected", () => {
  const r = validateSubmission(antiSlopSkill, verdict({ AS2: { result: "not_met", severity: "major", evidence: "his emerald eyes darkened" } }), TEXT);
  assert.ok(!r.ok && /not found verbatim/.test(r.errors.join(" ")));
});
await test("quotes match across curly quotes, case, whitespace and ellipsis elisions", () => {
  assert.deepEqual(findMissingQuotePieces("I set the pie … didn’t take my hand", TEXT.replace("didn't", "didn’t")), []);
  assert.deepEqual(findMissingQuotePieces("SHE ATE IT   anyway", TEXT), []);
});
await test("a major with no quote is rejected", () => {
  const r = validateSubmission(antiSlopSkill, verdict({ AS5: { result: "not_met", severity: "major" } }), TEXT);
  assert.ok(!r.ok && /needs an exact quote/.test(r.errors.join(" ")));
});
await test("missing criteria are rejected, naming them", () => {
  const r = validateSubmission(antiSlopSkill, verdict({}, ["AS7", "AS9"]), TEXT);
  assert.ok(!r.ok && /AS7, AS9/.test(r.errors.join(" ")));
});
await test("prose instead of JSON is rejected", () => {
  assert.ok(!validateSubmission(antiSlopSkill, "Looks fine to me.", TEXT).ok);
});

// --- the flow ---------------------------------------------------------------

await test("request → launch prompts that tell the subagent to fetch its own brief", async () => {
  const store = memoryStore();
  const { review, launches } = await requestReviews(
    { bookId: "b1", userId: "u1", text: TEXT, targetType: "prose_scene", chapterNumber: 3 },
    { store, pack: null, resolveRubric: builtIn }
  );
  assert.equal(review.overall_status, "pending");
  assert.equal(launches.length, 1);
  assert.match(launches[0]!.prompt, new RegExp(`get_review_brief with briefId "${launches[0]!.briefId}"`));
  const brief = await getReviewBrief(launches[0]!.briefId, { store });
  assert.match(brief, /TEXT UNDER REVIEW/);
  assert.match(brief, /I set the pie on her knee/);
  assert.match(brief, /submit_review_verdict/);
});

await test("full flow: pending blocks save → submit → flagged saves with FLAGs listed", async () => {
  const store = memoryStore();
  const { review, launches } = await requestReviews({ bookId: "b1", userId: "u1", text: TEXT, targetType: "prose_scene" }, { store, pack: null, resolveRubric: builtIn });
  await assert.rejects(
    checkReviewForAcceptance({ bookId: "b1", text: TEXT, skillReviewId: review.id }, { store }),
    (e: unknown) => e instanceof SkillReviewGateError && /no verdict yet/.test((e as Error).message)
  );
  const out = await submitReviewVerdict(
    { briefId: launches[0]!.briefId, verdict: JSON.stringify(verdict({ AS10: { result: "not_met", severity: "major", evidence: "shoved it at my chest" } })), reviewerModel: "Opus 5.5" },
    { store }
  );
  assert.ok(out.accepted);
  assert.equal(out.overall, "flagged");
  const gate = await checkReviewForAcceptance({ bookId: "b1", text: TEXT, skillReviewId: review.id }, { store });
  assert.equal(gate.overridden, false);
  assert.match(gate.note, /FLAGs to show the author/);
});

await test("an accepted verdict is final: a second submission is refused", async () => {
  const store = memoryStore();
  const { launches } = await requestReviews({ bookId: "b1", userId: "u1", text: TEXT, targetType: "prose_scene" }, { store, pack: null, resolveRubric: builtIn });
  await submitReviewVerdict({ briefId: launches[0]!.briefId, verdict: verdict() }, { store });
  await assert.rejects(submitReviewVerdict({ briefId: launches[0]!.briefId, verdict: verdict() }, { store }), /final verdict/);
  await assert.rejects(getReviewBrief(launches[0]!.briefId, { store }), /final verdict/);
});

await test("invalid submissions get retries, then become reviewer_error → incomplete → override needed", async () => {
  const store = memoryStore();
  const { review, launches } = await requestReviews({ bookId: "b1", userId: "u1", text: TEXT, targetType: "prose_scene" }, { store, pack: null, resolveRubric: builtIn });
  const bad = verdict({ AS2: { result: "not_met", severity: "major", evidence: "a quote that is not there" } });
  for (let i = 1; i < MAX_SUBMIT_ATTEMPTS; i++) {
    const out = await submitReviewVerdict({ briefId: launches[0]!.briefId, verdict: bad }, { store });
    assert.equal(out.accepted, false);
    assert.equal(out.attemptsLeft, MAX_SUBMIT_ATTEMPTS - i);
  }
  const last = await submitReviewVerdict({ briefId: launches[0]!.briefId, verdict: bad }, { store });
  assert.equal(last.item.status, "reviewer_error");
  assert.equal(last.overall, "incomplete");
  await assert.rejects(checkReviewForAcceptance({ bookId: "b1", text: TEXT, skillReviewId: review.id }, { store }), /INCOMPLETE/);
  const ok = await checkReviewForAcceptance({ bookId: "b1", text: TEXT, skillReviewId: review.id, writerOverride: "Reviewer kept misquoting; I read it myself." }, { store });
  assert.equal(ok.overridden, true);
  assert.equal((await store.getReview(review.id)).override_reason, "Reviewer kept misquoting; I read it myself.");
});

await test("a refusal is recorded as reviewer_error, never a pass", async () => {
  const store = memoryStore();
  const { launches } = await requestReviews({ bookId: "b1", userId: "u1", text: TEXT, targetType: "prose_scene" }, { store, pack: null, resolveRubric: builtIn });
  const out = await submitReviewVerdict({ briefId: launches[0]!.briefId, verdict: JSON.stringify({ refused: true, reason: "content" }) }, { store });
  assert.equal(out.item.status, "reviewer_error");
  assert.equal(out.overall, "incomplete");
});

await test("gate: edited text, wrong book, unknown review are all refused", async () => {
  const store = memoryStore();
  const { review, launches } = await requestReviews({ bookId: "b1", userId: "u1", text: TEXT, targetType: "prose_scene" }, { store, pack: null, resolveRubric: builtIn });
  await submitReviewVerdict({ briefId: launches[0]!.briefId, verdict: verdict() }, { store });
  await checkReviewForAcceptance({ bookId: "b1", text: `  ${TEXT}\n`, skillReviewId: review.id }, { store });
  await assert.rejects(checkReviewForAcceptance({ bookId: "b1", text: TEXT + " Then she left.", skillReviewId: review.id }, { store }), /hash/);
  await assert.rejects(checkReviewForAcceptance({ bookId: "b2", text: TEXT, skillReviewId: review.id }, { store }), /different book/);
  await assert.rejects(checkReviewForAcceptance({ bookId: "b1", text: TEXT, skillReviewId: "nope" }, { store }), SkillReviewGateError);
});

await test("overall status order: pending > blocked > incomplete > flagged > passed", () => {
  assert.equal(overallFromItems([{ status: "flagged" }, { status: "pending" }]), "pending");
  assert.equal(overallFromItems([{ status: "flagged" }, { status: "blocked" }, { status: "reviewer_error" }]), "blocked");
  assert.equal(overallFromItems([{ status: "flagged" }, { status: "reviewer_error" }]), "incomplete");
  assert.equal(overallFromItems([{ status: "passed" }, { status: "not_applicable" }, { status: "flagged" }]), "flagged");
  assert.equal(overallFromItems([{ status: "passed" }, { status: "not_applicable" }]), "passed");
});

await test("scan: catches stock phrases, ignores clean prose", () => {
  const sloppy =
    "Something flickered across his face. Her voice was barely above a whisper as she took a deep breath, his eyes never leaving hers. It was a pivotal moment, highlighting their evolving dynamic. Nothing would ever be the same.";
  const ids = scanForSlop(sloppy).hits.map((h) => h.id);
  for (const id of ["flicker", "barely_whisper", "deep_breath", "eyes_never_leaving", "pivotal", "highlighting", "evolving", "never_the_same"]) {
    assert.ok(ids.includes(id), `expected ${id}`);
  }
  assert.equal(scanForSlop(TEXT).totalHits, 0);
});

console.log(`\n${passed} passed`);
