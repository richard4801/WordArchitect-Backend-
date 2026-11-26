// Offline tests for the narration switch (src/lib/narration.ts and the
// detector in src/services/narrationEditor.ts). No network, no database.
// Run with: npm run test:narration
//
// The fixtures are deliberately neutral invented prose, not manuscript text.
import assert from "node:assert/strict";
import { normalizePov, normalizeTense, resolveNarrationSetting, buildNarrationSection } from "../src/lib/narration.js";
import { analyzeParagraph, isPovMissing, stripDialogue, countTenseClauses } from "../src/services/narrationEditor.js";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n     ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

const firstPast = { pov: "first", tense: "past" } as const;
const firstPresent = { pov: "first", tense: "present" } as const;
const thirdPast = { pov: "third", tense: "past" } as const;

// ---- normalizers ----
test("normalizePov understands common spellings", () => {
  assert.equal(normalizePov("First Person"), "first");
  assert.equal(normalizePov("first-person"), "first");
  assert.equal(normalizePov("1st"), "first");
  assert.equal(normalizePov("Third person limited"), "third");
  assert.equal(normalizePov("3rd"), "third");
  assert.equal(normalizePov("Third Person Omniscient"), "third");
});
test("normalizePov returns null for unknown or empty values", () => {
  assert.equal(normalizePov(""), null);
  assert.equal(normalizePov("   "), null);
  assert.equal(normalizePov(null), null);
  assert.equal(normalizePov(undefined), null);
  assert.equal(normalizePov("second person"), null);
  assert.equal(normalizePov(42), null);
});
test("normalizeTense understands common spellings", () => {
  assert.equal(normalizeTense("Past"), "past");
  assert.equal(normalizeTense("past tense"), "past");
  assert.equal(normalizeTense("Present Tense"), "present");
  assert.equal(normalizeTense("present"), "present");
  assert.equal(normalizeTense("future"), null);
  assert.equal(normalizeTense(null), null);
});
test("the switch is on only when BOTH halves are understood", () => {
  assert.deepEqual(resolveNarrationSetting("First Person", "Past"), { pov: "first", tense: "past" });
  assert.equal(resolveNarrationSetting("First Person", null), null);
  assert.equal(resolveNarrationSetting(null, "Past"), null);
  assert.equal(resolveNarrationSetting("", ""), null);
  assert.equal(resolveNarrationSetting("omniscient-ish", "past"), null);
});
test("the injected wording names both person and tense", () => {
  const text = buildNarrationSection(firstPast);
  assert.match(text, /first person/);
  assert.match(text, /past tense/);
  const third = buildNarrationSection({ pov: "third", tense: "present" });
  assert.match(third, /third person/);
  assert.match(third, /present tense/);
});

// ---- dialogue handling ----
test("dialogue is stripped before analysis, including unterminated quotes", () => {
  assert.equal(stripDialogue('She said "I am here" and left.').includes("I am"), false);
  assert.equal(stripDialogue("She said “I am here” and left.").includes("I am"), false);
  assert.equal(stripDialogue('He started to say "I do not').includes("I do not"), false);
});

// ---- tense detection ----
const PAST_FIRST_OK =
  "I waited on the platform until the lights flickered. The clock above me ticked toward midnight, and I counted the seconds under my breath. A man in a coat walked past without looking at me. I pulled my collar up and watched the tracks.";
const PRESENT_THIRD_BAD =
  "She waits on the platform until the lights flicker. The clock above her ticks toward midnight, and she counts the seconds under her breath. A man in a coat walks past without looking at her. She pulls her collar up and watches the tracks.";
const PRESENT_FIRST =
  "I wait on the platform until the lights flicker. The clock above me ticks toward midnight, and I count the seconds under my breath. A man in a coat walks past without looking at me. I pull my collar up and watch the tracks.";

test("first-person past narration passes a first/past setting", () => {
  assert.deepEqual(analyzeParagraph(PAST_FIRST_OK, firstPast).problems, []);
});
test("present-tense narration is flagged against a past setting", () => {
  assert.deepEqual(analyzeParagraph(PRESENT_THIRD_BAD, firstPast).problems, ["tense"]);
  assert.deepEqual(analyzeParagraph(PRESENT_FIRST, firstPast).problems, ["tense"]);
});
test("past narration is flagged against a present setting, and present passes", () => {
  assert.deepEqual(analyzeParagraph(PAST_FIRST_OK, firstPresent).problems, ["tense"]);
  assert.deepEqual(analyzeParagraph(PRESENT_FIRST, firstPresent).problems, []);
});
test("present-tense dialogue inside past narration is not a violation", () => {
  const para =
    'I turned to her and waited for her to speak. "I don\'t know what you want from me, and I never will," she said. "Go home. I am tired and I know you are too."';
  assert.deepEqual(analyzeParagraph(para, firstPast).problems, []);
});
test("inverted questions and conditionals are not counted as present-tense clauses", () => {
  const counts = countTenseClauses("Where would they start? Would they start with the man holding the knife? If he knew, did he care?");
  assert.equal(counts.present, 0);
});
test("one stray present-tense clause does not trigger a rewrite", () => {
  const para =
    "I waited on the platform until the lights flickered and the clock ticked past midnight. I watched the tracks for a long while. I know that sounds strange, but I stayed anyway and kept my eyes on the dark.";
  assert.deepEqual(analyzeParagraph(para, firstPast).problems, []);
});
test("paragraphs too short to judge are never flagged", () => {
  assert.deepEqual(analyzeParagraph("She waits. She watches.", firstPast).problems, []);
});

// ---- point of view ----
test("first-person pronouns in third-person narration are flagged", () => {
  const para =
    "I stood by the door while he waited for the signal to change. I watched him check his watch, and I wondered what he was thinking about as the minutes went by.";
  assert.ok(analyzeParagraph(para, thirdPast).problems.includes("pov"));
});
test("third-person narration passes a third-person setting", () => {
  const para =
    "She stood by the door while he waited for the signal to change. She watched him check his watch and wondered what he was thinking about as the minutes went by.";
  assert.deepEqual(analyzeParagraph(para, thirdPast).problems, []);
});
test("a long first-person text with no 'I' anywhere is flagged as missing its narrator", () => {
  const longThirdPerson = Array(12).fill("The woman waited on the platform and watched the clock tick toward midnight.").join(" ");
  assert.equal(isPovMissing(longThirdPerson, firstPast), true);
  assert.equal(isPovMissing(longThirdPerson, thirdPast), false);
});
test("a short first-person paragraph with no 'I' is NOT flagged (one-paragraph drafting)", () => {
  const shortScene = "The clock above the platform ticked toward midnight. A man in a coat walked past the bench without looking up, and the lights flickered twice.";
  assert.equal(isPovMissing(shortScene, firstPast), false);
});

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
