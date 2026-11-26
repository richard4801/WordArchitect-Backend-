// Offline tests for the Ghost Editor's mark-and-recheck loop, with stub
// rewriters (no API calls). Run: npm run test:ghost
import assert from "node:assert/strict";
import { enforceBannedTerms, findAllBannedSpans, guardProblems, MAX_SPOT_ATTEMPTS, type Rewriter } from "../src/services/ghostEditor.js";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`ok  ${name}`); } catch (e) { console.error(`FAIL ${name}`); throw e; }
}
const BANS = ["I made myself", "was out of me before I could stop it", "forced myself", "compelled myself"];
const PARA = "Fenris did not look up when I came in. Mina stood at his shoulder with her arms folded. When nobody spoke I made myself step forward into the light. The map was of the southern ridge.";

function scripted(replies: (string | { refused: true })[]): Rewriter & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (_s: string, user: string) => {
    calls.push(user);
    const r = replies.shift();
    if (r === undefined) throw new Error("no scripted reply left");
    return typeof r === "string" ? { text: r } : { refused: true as const, reason: "test refusal" };
  }) as Rewriter & { calls: string[] };
  fn.calls = calls;
  return fn;
}

await test("finds every occurrence, case-insensitive", () => {
  assert.equal(findAllBannedSpans("I made myself go. Then i MADE MYSELF stay.", BANS).length, 2);
});

await test("clean rewrite: only the marked sentence changes, the rest is byte-for-byte", async () => {
  const primary = scripted(["When nobody spoke I stepped forward into the light."]);
  const r = await enforceBannedTerms({ text: PARA, bannedTerms: BANS, systemPrompt: "", primary, fallback: null });
  assert.equal(r.finalText, PARA.replace("I made myself step", "I stepped"));
  assert.equal(r.corrections[0]?.resolved, true);
  assert.match(primary.calls[0]!, /\[\[I made myself\]\]/);
  assert.match(primary.calls[0]!, /CONTEXT BEFORE[\s\S]*Mina stood at his shoulder/);
});

await test("a rewrite that lands on another banned term is flagged again until clean", async () => {
  const primary = scripted([
    "When nobody spoke I forced myself into the light.",
    "When nobody spoke I compelled myself to step forward into the light.",
    "When nobody spoke I stepped forward into the light.",
  ]);
  const r = await enforceBannedTerms({ text: PARA, bannedTerms: BANS, systemPrompt: "", primary, fallback: null });
  const spot = r.corrections[0]!.spots![0]!;
  assert.equal(spot.resolved, true);
  assert.equal(spot.attempts, 3);
  assert.match(primary.calls[1]!, /\[\[forced myself\]\]/);
  assert.match(primary.calls[2]!, /must not contain any of: .*"compelled myself"/);
});

await test("guard: a rewrite that drops or adds a name, adds a dash, or adds stock phrasing is rejected", async () => {
  assert.match(guardProblems("Kane watched while I made myself stay.", "I stayed.").join(" "), /dropped the name\(s\) Kane/);
  assert.match(guardProblems("When nobody spoke I made myself step forward.", "When Samuel spoke I stepped forward.").join(" "), /added the name/);
  assert.match(guardProblems("I made myself step forward.", "I stepped forward — slowly.").join(" "), /dash/);
  assert.match(guardProblems("I made myself step forward.", "I took a deep breath and stepped forward.").join(" "), /stock phrasing/);
  assert.match(guardProblems("I couldn't look away from that knife.", "The knife drew me in like a moth to flame.").join(" "), /comparison/);
  // Live-test false positives (26 Nov): ALL CAPS emphasis and sentence-opening verb forms are not names.
  assert.deepEqual(guardProblems("I MADE MYSELF count the strokes.", "I counted the strokes."), []);
  assert.deepEqual(guardProblems("I took a deep breath, trying to steady my pulse.", "Trying to steady my pulse, I breathed in."), []);
  assert.deepEqual(guardProblems("I swallowed hard, unable to find a lie that sounded convincing.", "Unable to find a lie that sounded convincing, I stayed quiet."), []);
  const primary = scripted(["When Samuel spoke I stepped forward into the light.", "When nobody spoke I stepped forward into the light."]);
  const r = await enforceBannedTerms({ text: PARA, bannedTerms: BANS, systemPrompt: "", primary, fallback: null });
  assert.equal(r.corrections[0]!.spots![0]!.attempts, 2);
  assert.match(primary.calls[1]!, /rejected because it added the name\(s\) Samuel/);
});

await test("Sonnet declines → that spot falls back to Hanami, and the report says so", async () => {
  const primary = scripted([{ refused: true }]);
  const fallback = scripted(["When nobody spoke I stepped forward into the light."]);
  const r = await enforceBannedTerms({ text: PARA, bannedTerms: BANS, systemPrompt: "", primary, fallback });
  const spot = r.corrections[0]!.spots![0]!;
  assert.equal(spot.resolved, true);
  assert.equal(spot.engine, "hanami");
});

await test("both decline → unresolved, and the author's sentence is kept, never half-fixed", async () => {
  const r = await enforceBannedTerms({ text: PARA, bannedTerms: BANS, systemPrompt: "", primary: scripted([{ refused: true }]), fallback: scripted([{ refused: true }]) });
  assert.equal(r.corrections[0]!.resolved, false);
  assert.equal(r.finalText, PARA);
});

await test(`cap: always lands on a banned term → unresolved after ${MAX_SPOT_ATTEMPTS}, original kept`, async () => {
  const primary = scripted(Array(MAX_SPOT_ATTEMPTS).fill("When nobody spoke I forced myself into the light."));
  const r = await enforceBannedTerms({ text: PARA, bannedTerms: BANS, systemPrompt: "", primary, fallback: null });
  const spot = r.corrections[0]!.spots![0]!;
  assert.equal(spot.resolved, false);
  assert.equal(spot.attempts, MAX_SPOT_ATTEMPTS);
  assert.equal(r.finalText, PARA);
});

await test("several spots across sentences and paragraphs are each fixed on their own", async () => {
  const text = "I made myself look at the knife. My hands shook.\n\nThe laugh was out of me before I could stop it, sharp in the quiet yard.";
  const primary = scripted(["I looked at the knife.", "I laughed before I could stop, sharp in the quiet yard."]);
  const r = await enforceBannedTerms({ text, bannedTerms: BANS, systemPrompt: "", primary, fallback: null });
  assert.equal(r.finalText, "I looked at the knife. My hands shook.\n\nI laughed before I could stop, sharp in the quiet yard.");
  assert.equal(r.corrections.length, 2);
});

await test("no banned terms → no calls, text untouched", async () => {
  const primary = scripted([]);
  const r = await enforceBannedTerms({ text: "Clean text.", bannedTerms: BANS, systemPrompt: "", primary, fallback: null });
  assert.equal(r.finalText, "Clean text.");
  assert.equal(primary.calls.length, 0);
});

console.log(`\n${passed} passed`);
