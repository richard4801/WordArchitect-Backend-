import type { SkillDefinition } from "../types.js";

// Skill 06, distilled from docs/skill-research/06_fiction-fundamentals.md.
// Only the portable craft findings are kept; the brief's chapter-specific
// advice for another book's Ch 71-75 is deliberately not carried over. This
// skill owns plot armor and escalation (the gatekeeper's old flags 3, 5, 7).
export const fictionFundamentalsSkill: SkillDefinition = {
  key: "fiction_fundamentals",
  role: "skill_fiction_fundamentals",
  title: "Fiction fundamentals (desire, cause, payoff, cast)",
  priority: 8,
  proseTargets: ["beat_card", "prose_chapter"],
  planningStages: ["act_summary", "part_outline", "part_beats", "hook_chapters_outline"],
  maxLevel: "FLAG",
  reviewerModel: "Opus 5.5",
  rubric: `Working definition: the next thing that happens should come out of what somebody wants. When a long serial goes stiff, the next event came from the calendar, a moon count or a piece of furniture. When it's alive, it came from a person. Check the machinery under the romance: why each event follows the last and whether the cast keeps moving.

Desire: someone in the scene wants something specific, reachable and aimed at a person. "Survive the night" isn't a scene goal; "get her out of that room before he turns" is. Refusing isn't wanting: a character who only turns down what others offer is reactive, and readers side with whoever is at least trying. A trapped or captive lead can still carry chapters if she is seeking rather than only suffering; in a cage, agency means choosing inside it and paying for the choice.

Cause and effect: between any two beats the honest word should be "therefore" or "but", never "and then". Coincidence may drop characters into trouble; it may never get them out. A power the reader understands well (a bond with stated rules) may settle a conflict; a vaguely stated prophecy or power may only create problems. Luck or an ill-defined power rescuing someone is plot armor.

Set-up and payoff: every promise needs felt progress. The best payoff fires something the reader half forgot and recognizes the moment it lands. Escalation means harder to undo, not louder: each complication ties back to the original trouble, uses up the lead's usual tactics, and turning points alternate between someone acting and new information landing. A beat repeated at the same strength lands at half strength.

Each scene should answer its goal with yes-but or no-and; a clean yes ends the drama. The reaction that follows ends in a choice that becomes the next goal. A surprise should live in a fact the reader already holds; a recognition that turns nothing is a failure. This book's rule stands: the narrator shows a secret's shape and never concludes a reveal for the reader, so never ask for an explaining paragraph as a fix.

Cast: flat characters with a tag are fine and help a returning reader; don't hand them a round character's secret. The leads never leave for long, secondary characters want something that touches the couple, and the cast comes to the couple rather than the couple touring the world.

In a plan (card, outline, beats), test the links: can you join every beat with "so" or "but", and name who wants what from whom? On the page, test that the want, the choice and its cost are visible in acts and lines, not explained.`,
  criteria: [
    { id: "FF1", title: "A want aimed at a person", check: "Does at least one character in each scene or chapter go after something specific and reachable from a named person, beyond refusing, enduring or obeying? Name the want and its target, or say which scene has none." },
    { id: "FF2", title: "Therefore or but, never and then", check: "Can every adjacent pair of beats or events be joined by 'so/therefore' or 'but'? Flag any event that arrives from the calendar, a schedule, a prop or an outside force rather than from someone's want or the previous beat's consequence." },
    { id: "FF3", title: "Plot armor", check: "Does any coincidence, lucky timing, overheard line, convenient arrival or unexplained ability get a character OUT of trouble (coincidence into trouble is fine)? If the rescue was caused, is that earlier choice on the page or in the manuscript? n_a if no one is in danger or difficulty." },
    { id: "FF4", title: "Hard magic settles, soft magic only troubles", check: "Is a conflict resolved by a power, bond, prophecy or curse whose rules the reader has NOT been clearly shown (search the manuscript for its stated rules)? A well-understood power may settle things; a vaguely stated one may only create problems. n_a if no supernatural force decides an outcome." },
    { id: "FF5", title: "Promise, progress, payoff", check: "Does the text give the reader felt progress on at least one open promise, and does any payoff here fire something already set up in the manuscript rather than something introduced just in time to work? Cite the set-up chapter. n_a for a single scene with no open thread in play." },
    { id: "FF6", title: "Escalation that is harder to undo", check: "Does each complication tie back to the original trouble and leave the situation harder to undo (not just louder or more violent), using up the lead's usual tactics; and do turning points mix actions with revelations rather than running several of one kind in a row? n_a for a single beat card with one turn." },
    { id: "FF7", title: "No beat at the same strength twice", check: "Does a beat, obstacle, insult, emotional turn or intimate scene repeat one already used here or in recent chapters (search the manuscript) without changing where it leaves the characters?" },
    { id: "FF8", title: "Yes-but, no-and, then a choice", check: "Does each scene's goal end in yes-but or no-and rather than a clean yes, and does the reaction that follows end in a visible choice (shown by an act or a line, not an explaining paragraph) that becomes the next goal? n_a for a fragment with no complete scene." },
    { id: "FF9", title: "Surprise that feels inevitable", check: "Where a turn or recognition happens, does it rest on facts the reader already holds, and does it reverse something for a character rather than only opening another question? Never ask for the narrator to spell the reveal out. n_a if there is no surprise or recognition." },
    { id: "FF10", title: "The leads stay in it; the cast comes to them", check: "Does every scene land on at least one of the leads, does each secondary character on the page want something that touches the couple, and are people brought to the couple rather than the couple sent touring? Flag a new viewpoint or a side plot with no line back to the couple." },
    { id: "FF11", title: "Flat characters stay flat", check: "Is a minor, tagged character handed a secret, a loaded glance or an arc of their own that the story can't pay off, adding a thread instead of wiring into a shared secret that pays several people at once? (Advisory.)", minorOnly: true },
  ],
};
