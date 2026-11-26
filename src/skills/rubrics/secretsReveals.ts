import type { SkillDefinition } from "../types.js";

// Skill 05, distilled from docs/skill-research/05_secrets-and-reveals.md. Only
// the portable craft and market findings are kept; the brief's chapter-specific
// advice for another book's Ch 71-75 is deliberately not carried over. This
// skill owns dramatic irony both when it is ABSENT and when it has gone STALE
// (it replaces the gatekeeper's old flag 9).
export const secretsRevealsSkill: SkillDefinition = {
  key: "secrets_reveals",
  role: "skill_secrets_reveals",
  title: "Secrets and reveals (threads, irony)",
  priority: 7,
  proseTargets: ["beat_card", "prose_chapter"],
  planningStages: ["act_summary", "part_outline", "part_beats", "hook_chapters_outline"],
  maxLevel: "FLAG",
  reviewerModel: "Opus 5.5",
  rubric: `Working definition: in a romance a secret pays its way only when telling it would cost one lover the other, and a reveal pays only when it leaves the two of them somewhere harder than where they started. Everything else is homework: a fact held by a third party, about something neither lover cares about, that has to be worked out before the story can move. In a romance homework takes the couple out of the room, and a reader paying by the chapter reads a thread that doesn't move as padding she is being charged for.

What good looks like: the reader is given the facts and made to wait for the outcome (Hitchcock's bomb under the table: shown first, it holds a dull conversation for fifteen minutes). Irony is kept alive by an object on the page, not a reminder in narration. The person with the wrong idea acts on it and the cost falls on the one who knows. A reveal lands on a hinge, right after a rupture or at a choice, and lands on the couple face to face: the one it hurts most learns it in front of whoever kept it. The answer is a worse fact planted earlier, so the reader flips back and finds it waiting; never a mystery answered with another mystery, and never a retcon that makes published pages wrong instead of making them mean more.

What failure looks like: a point-of-view character who knows the answer and won't think it (that is the author hiding the bomb, and romance readers feel cheated, not curious). A misunderstanding kept shut by silence the author is holding rather than a reason the character has, or by last chapter's reason again, so every fight ends where the last one did. Irony held so long the reader starts blaming the one who doesn't know. More threads opened than closed, and upkeep scenes pointing at small guns that will never fire. Every secret coming out the same way.

This book's own ruling outranks the craft: a secret shows as shape (behaviour, an object, a gap) until another character's mouth lands it, and the narrator never concludes a reveal for the reader.

In a plan, judge what the card or outline commits to: who holds each secret, who it is aimed at, the sentence that would end a misunderstanding and today's reason it can't be said, where and in front of whom a reveal lands, and the thread count in and out. On the page, judge whether the irony is visible, whether the reveal is spoken by a character rather than concluded by the narrator, and whether the POV mind is honest about what it knows.`,
  criteria: [
    { id: "SR1", title: "Tension, not homework", check: "Is each secret or open question in focus held by a lead or aimed straight at one, would telling it cost the holder something with the other lover, and does the other lover's reaction matter more than the fact? Flag third-party facts nobody in the couple cares about that take scene time. n_a if no secret or open question is in play." },
    { id: "SR2", title: "Facts given, outcome withheld", check: "Where the text withholds something, is it withholding an outcome (what will happen, what someone will do) with the facts in the reader's view, rather than hiding a fact purely to stage a surprise? n_a if nothing is withheld." },
    { id: "SR3", title: "The POV deal", check: "Does any point-of-view character know the answer to a secret the scene turns on and conspicuously avoid thinking it, so the author rather than the character is hiding it? Quote the passage where the thought is skipped. n_a if no POV character holds a secret here." },
    { id: "SR4", title: "One-sentence test", check: "For any misunderstanding in play: can you name the sentence that would end it, who could say it, and a reason on the page they can't say it today that is new, not the same reason as last time? Does the pressure on it rise rather than repeat? n_a if no misunderstanding is in play." },
    { id: "SR5", title: "Reveal on a hinge, on the couple", check: "Does each reveal land at a hinge (after a rupture or at a choice) and on the couple face to face, with the one it hurts most learning it in front of whoever kept it, rather than alone, in a corridor, or with a third party? n_a if nothing is revealed." },
    { id: "SR6", title: "Worse fact, set up earlier", check: "Is each reveal answered with a concrete fact planted earlier that makes things harder, not a new mystery behind the old one, and does it add meaning to published pages rather than contradict them (no retcon)? n_a if nothing is revealed." },
    { id: "SR7", title: "Irony present and carried by an object", check: "Where the reader knows something a lead doesn't, is the irony visible in the scene through an object, an act or a line said over the bomb, rather than a narrated reminder or not at all? Flag a scene where a held secret sits right under the couple and the text never lets the reader feel it. n_a if no dramatic irony is set up." },
    { id: "SR8", title: "Irony gone stale", check: "Has a piece of irony been held so long, or upkept so often without rising pressure, that the reader is likely blaming the character who doesn't know? Search the manuscript for how long it has been running. If so, does this text cash it or escalate it? n_a if no irony is running." },
    { id: "SR9", title: "Thread count", check: "Does this unit close or detonate more threads than it opens; does any new question name the one it replaces; are threads simplified by one answer serving several questions rather than new characters; and does it stop pointing at small guns that won't fire? n_a for a text too short to open or close a thread." },
    { id: "SR10", title: "Shape until a mouth lands it", check: "Is every secret shown only as shape (behaviour, an object, a gap) until another character says it aloud, with the narrator never concluding or explaining the reveal for the reader? Quote any narrator line that does the concluding. n_a if no secret or reveal is in play." },
    { id: "SR11", title: "Varied ways out", check: "Do secrets come out in varied ways (a deduction, a confession forced by circumstance, a truth told by choice at a cost, irony kept on purpose) rather than every reveal or ending having the same someone-finds-something-out shape? n_a for a single reveal.", minorOnly: true },
  ],
};
