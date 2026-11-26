// Offline tests for the recorded Go, the per-chapter workflow and the process
// module. In-memory stores: no API key, no database. Run: npm run test:workflow
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  recordPromptApproval,
  checkCallIsApproved,
  PromptApprovalError,
  type ApprovalStore,
  type PromptApprovalRow,
  type ApprovalCallRow,
} from "../src/services/promptApproval.js";
import { computeWorkflow, type WorkflowFacts } from "../src/services/chapterWorkflow.js";
import type { ReviewStore } from "../src/services/skillReview.js";
import { STEPS, PROCESS_VERSION } from "../src/process/drafting.js";
import { renderInstructions, renderProcessMarkdown, SKILL_FILES } from "../src/process/render.js";
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

const BOOK = "book-1";

function approvalStore(): ApprovalStore & { calls: ApprovalCallRow[] } {
  const approvals = new Map<string, PromptApprovalRow>();
  const calls: ApprovalCallRow[] = [];
  let n = 0;
  return {
    calls,
    async insertApproval(row) {
      const a = { ...row, id: `appr-${++n}`, created_at: new Date().toISOString() };
      approvals.set(a.id, a);
      return a;
    },
    async getApproval(id) {
      return approvals.get(id) ?? null;
    },
    async listApprovals(bookId, ch) {
      return [...approvals.values()].filter((a) => a.book_id === bookId && a.chapter_number === ch);
    },
    async insertCall(row) {
      const c = { ...row, id: `call-${++n}`, created_at: "" };
      calls.push(c);
      return c;
    },
    async listCalls(ids) {
      return calls.filter((c) => ids.includes(c.approval_id));
    },
  };
}

// A review store holding one card review with items of the given statuses.
function cardReviewStore(statuses: ReviewItemRow["status"][], opts: { targetType?: string; chapter?: number | null; book?: string } = {}): ReviewStore & { review: SkillReviewRow } {
  const review = {
    id: "card-rev",
    book_id: opts.book ?? BOOK,
    target_type: opts.targetType ?? "beat_card",
    chapter_number: opts.chapter === undefined ? 594 : opts.chapter,
    overall_status: "pending",
    override_reason: null,
    overridden_at: null,
  } as unknown as SkillReviewRow;
  const items = statuses.map((status, i) => ({ id: `it-${i}`, review_id: review.id, status, brief: { title: `s${i}` } }) as unknown as ReviewItemRow);
  return {
    review,
    async insertReview() { throw new Error("unused"); },
    async insertItems() { throw new Error("unused"); },
    async getReview(id) { if (id !== review.id) throw new Error(`No skill review found with id ${id}.`); return review; },
    async getItem() { throw new Error("unused"); },
    async listItems() { return items; },
    async updateItem() { throw new Error("unused"); },
    async updateReview(_id, patch) { Object.assign(review, patch); },
    async listReviews() { return [review]; },
  };
}

const BEATS = [
  { label: "M1 The hall empties", sceneBeat: "Continue, past tense, first person, two paragraphs. The hall empties. STOP at the doors.", compiledContext: "Narrator: Jace..." },
  { label: "M2 The yard", sceneBeat: "Continue. He reaches the yard. STOP on him knowing her.", compiledContext: "Narrator: Jace... Story so far: ..." },
];

async function main() {
  // ---------------- record_prompt_approval ----------------
  await test("Go: refused without the author's words", async () => {
    await assert.rejects(
      recordPromptApproval({ userId: "u", bookId: BOOK, chapterNumber: 594, cardReviewId: "card-rev", beats: BEATS, writerApproval: "  " }, { store: approvalStore(), reviews: cardReviewStore(["passed"]) }),
      PromptApprovalError
    );
  });

  await test("Go: refused without a card review when the gate is on", async () => {
    await assert.rejects(
      recordPromptApproval({ userId: "u", bookId: BOOK, chapterNumber: 594, beats: BEATS, writerApproval: "Go" }, { store: approvalStore(), reviews: cardReviewStore(["passed"]), cardGate: true }),
      /hasn't been reviewed/
    );
  });

  await test("Go: refused while a card reviewer is pending", async () => {
    await assert.rejects(
      recordPromptApproval({ userId: "u", bookId: BOOK, chapterNumber: 594, cardReviewId: "card-rev", beats: BEATS, writerApproval: "Go" }, { store: approvalStore(), reviews: cardReviewStore(["passed", "pending"]), cardGate: true }),
      /without a verdict/
    );
  });

  await test("Go: a prose review, another book or another chapter is refused", async () => {
    const base = { userId: "u", bookId: BOOK, chapterNumber: 594, cardReviewId: "card-rev", beats: BEATS, writerApproval: "Go" };
    await assert.rejects(recordPromptApproval(base, { store: approvalStore(), reviews: cardReviewStore(["passed"], { targetType: "prose_chapter" }), cardGate: true }), /not a beat_card review/);
    await assert.rejects(recordPromptApproval(base, { store: approvalStore(), reviews: cardReviewStore(["passed"], { book: "other" }), cardGate: true }), /different book/);
    await assert.rejects(recordPromptApproval(base, { store: approvalStore(), reviews: cardReviewStore(["passed"], { chapter: 12 }), cardGate: true }), /chapter 12/);
  });

  await test("Go: a BLOCKED card needs the author's override, which is stored", async () => {
    const reviews = cardReviewStore(["blocked", "passed"]);
    const base = { userId: "u", bookId: BOOK, chapterNumber: 594, cardReviewId: "card-rev", beats: BEATS, writerApproval: "Go" };
    await assert.rejects(recordPromptApproval(base, { store: approvalStore(), reviews, cardGate: true }), /BLOCKED/);
    const { note } = await recordPromptApproval({ ...base, writerOverride: "He can know her name, she told him in 560" }, { store: approvalStore(), reviews, cardGate: true });
    assert.match(note, /OVER a blocked card review/);
    assert.equal(reviews.review.override_reason, "He can know her name, she told him in 560");
  });

  // ---------------- checkCallIsApproved ----------------
  const store = approvalStore();
  const { approval } = await recordPromptApproval(
    { userId: "u", bookId: BOOK, chapterNumber: 594, cardReviewId: "card-rev", beats: BEATS, writerApproval: "Go, send them" },
    { store, reviews: cardReviewStore(["passed", "flagged"]), cardGate: true }
  );

  await test("Go: an approved beat is sent (whitespace-insensitive) and logged", async () => {
    const rewrapped = BEATS[1]!.sceneBeat.replace(/ /g, "\n ");
    const covered = await checkCallIsApproved({ bookId: BOOK, approvalId: approval.id, sceneBeat: rewrapped, compiledContext: "new anchor" }, { store });
    assert.equal(covered.beat.index, 1);
    assert.equal(covered.kind, "approved");
    assert.equal(store.calls.at(-1)!.compiled_context, "new anchor");
  });

  await test("Go: an unapproved beat is refused, naming the approved ones", async () => {
    await assert.rejects(
      checkCallIsApproved({ bookId: BOOK, approvalId: approval.id, sceneBeat: "Write the whole chapter.", compiledContext: "" }, { store }),
      (err: Error) => err instanceof PromptApprovalError && /M1 The hall empties/.test(err.message) && /new Go/.test(err.message)
    );
  });

  await test("Go: a rerun needs a real beat index and a reason, and is logged as a rerun", async () => {
    await assert.rejects(checkCallIsApproved({ bookId: BOOK, approvalId: approval.id, sceneBeat: "fix para 2", compiledContext: "", rerunOfBeat: 7, rerunReason: "x" }, { store }), /no beat 7/);
    await assert.rejects(checkCallIsApproved({ bookId: BOOK, approvalId: approval.id, sceneBeat: "fix para 2", compiledContext: "", rerunOfBeat: 0 }, { store }), /rerunReason/);
    const covered = await checkCallIsApproved({ bookId: BOOK, approvalId: approval.id, sceneBeat: "Rewrite only paragraph 2 from his angle.", compiledContext: "...", rerunOfBeat: 0, rerunReason: "author comment: his perception should differ" }, { store });
    assert.equal(covered.kind, "rerun");
    assert.equal(store.calls.at(-1)!.rerun_reason, "author comment: his perception should differ");
  });

  await test("Go: unknown approval or another book's approval is refused", async () => {
    await assert.rejects(checkCallIsApproved({ bookId: BOOK, approvalId: "nope", sceneBeat: BEATS[0]!.sceneBeat, compiledContext: "" }, { store }), /no approval/);
    await assert.rejects(checkCallIsApproved({ bookId: "other", approvalId: approval.id, sceneBeat: BEATS[0]!.sceneBeat, compiledContext: "" }, { store }), /different book/);
  });

  // ---------------- computeWorkflow ----------------
  const empty: WorkflowFacts = { chapterNumber: 594, recentReads: 0, cardReviews: [], approvals: [], calls: [], draftSessions: [], proseReviews: [], savedWordCount: 0 };
  const at = (f: Partial<WorkflowFacts>) => computeWorkflow({ ...empty, ...f });

  await test("Workflow: walks the steps in order and names the next one", () => {
    assert.match(at({}).nextStep, /Read the manuscript first/);
    assert.match(at({ recentReads: 4 }).nextStep, /beat card .* request_reviews .* beat_card/);
    const card = { id: "c", overall_status: "pending" as const, override_reason: null, created_at: "" };
    assert.match(at({ recentReads: 4, cardReviews: [card] }).nextStep, /Wait for every card reviewer/);
    assert.match(at({ recentReads: 4, cardReviews: [{ ...card, overall_status: "blocked" }] }).nextStep, /BLOCKED/);
    const passedCard = { ...card, overall_status: "flagged" as const };
    assert.match(at({ recentReads: 4, cardReviews: [passedCard] }).nextStep, /record_prompt_approval/);
    const go = { id: "a", writer_approval: "Go", beats: approval.beats, created_at: "", card_review_id: "c" };
    assert.match(at({ recentReads: 4, cardReviews: [passedCard], approvals: [go] }).nextStep, /one at a time/);
    const calls = [0, 1].map((i) => ({ approval_id: "a", beat_index: i, kind: "approved" as const, rerun_reason: null, created_at: "" }));
    assert.match(at({ recentReads: 4, cardReviews: [passedCard], approvals: [go], calls }).nextStep, /prose_chapter/);
    const prose = { id: "p", overall_status: "passed" as const, override_reason: null, target_type: "prose_chapter" as const, created_at: "" };
    assert.match(at({ recentReads: 4, cardReviews: [passedCard], approvals: [go], calls, proseReviews: [prose] }).nextStep, /Save only when they say so/);
    const done = at({ savedWordCount: 1100, draftSessions: [{ id: "s", status: "in_progress", iteration_count: 3, label: null }] });
    assert.match(done.nextStep, /ledger note .* finish_scene_draft_session/);
    assert.ok(done.steps.every((s) => s.status === "done"));
  });

  await test("Workflow: half the approved beats sent is in progress, not done", () => {
    const passedCard = { id: "c", overall_status: "passed" as const, override_reason: null, created_at: "" };
    const go = { id: "a", writer_approval: "Go", beats: approval.beats, created_at: "", card_review_id: "c" };
    const w = at({ recentReads: 1, cardReviews: [passedCard], approvals: [go], calls: [{ approval_id: "a", beat_index: 0, kind: "approved", rerun_reason: null, created_at: "" }] });
    assert.equal(w.steps.find((s) => s.id === "drafting")!.status, "in_progress");
  });

  // ---------------- process module ----------------
  const toolsSource = readFileSync(new URL("../src/mcp/tools.ts", import.meta.url), "utf8");
  const registered = new Set([...toolsSource.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!));

  await test("Process: 12 steps, unique ids, every named tool really exists", () => {
    assert.equal(STEPS.length, 12);
    assert.equal(new Set(STEPS.map((s) => s.id)).size, 12);
    for (const s of STEPS) for (const t of s.tools) assert.ok(registered.has(t), `step ${s.n} names a tool that doesn't exist: ${t}`);
    for (const t of ["get_drafting_process", "get_chapter_workflow", "record_prompt_approval"]) assert.ok(registered.has(t), t);
  });

  await test("Process: connect instructions are short and carry the hard rules", () => {
    const i = renderInstructions();
    assert.ok(i.length < 3500, `instructions are ${i.length} chars`);
    assert.match(i, new RegExp(PROCESS_VERSION.replace(/\./g, "\\.")));
    for (const must of ["record_prompt_approval", "request_reviews", "source of truth", "get_chapter_workflow"]) assert.ok(i.includes(must), must);
  });

  await test("Process: the document carries the corrected facts, not the stale ones", () => {
    const md = renderProcessMarkdown();
    assert.match(md, /Sao10K-L3\.1-70B-Hanami-x1/);
    assert.match(md, /figures of speech only if fresh/i);
    assert.match(md, /requires bookId/);
    assert.doesNotMatch(md, /No similes\./);
    for (const s of STEPS) assert.ok(md.includes(s.title), s.title);
  });

  await test("Process: every skill file has valid front matter and names real tools", () => {
    for (const f of SKILL_FILES) {
      const text = f.render();
      assert.match(text, new RegExp(`^---\\nname: ${f.name}\\ndescription: ".+"\\n---\\n`));
      for (const m of text.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
        const name = m[1]!;
        if (["beat_card", "prose_scene", "prose_chapter", "prose_fragment", "writer_override"].includes(name)) continue;
        assert.ok(registered.has(name), `${f.name} names ${name}, which is not a registered tool`);
      }
    }
  });

  await test("Process: nothing from the other book leaks in", () => {
    const all = [renderProcessMarkdown(), ...SKILL_FILES.map((f) => f.render())].join("\n");
    assert.doesNotMatch(all, /Lycan King|Plump Obsession/);
  });

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
