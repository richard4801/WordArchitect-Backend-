import type { SkillDefinition } from "../types.js";

// Skill 04, distilled from docs/skill-research/04_serial-platform-plotting.md.
// Only the portable craft and market findings are kept; the brief's closing
// advice for another book's chapters is deliberately not carried over. This
// skill replaces the gatekeeper's old "every break must be a cliffhanger" flag:
// every chapter needs pull, not every chapter needs a cliffhanger.
export const serialPlottingSkill: SkillDefinition = {
  key: "serial_plotting",
  role: "skill_serial_plotting",
  title: "Serial pull (chapter as unit of sale, endings, arcs, sag)",
  priority: 6,
  proseTargets: ["beat_card", "prose_chapter"],
  planningStages: ["part_outline", "part_beats", "hook_chapters_outline"],
  maxLevel: "FLAG",
  reviewerModel: "Opus 5.5",
  rubric: `On a pay-per-chapter platform the chapter is the unit of sale. The reader decides again at every break whether the book is still worth her coins, and what she pays for is change. A chapter that is half a scene, with the turn saved for next time, feels to her like a charge with nothing delivered. Late in a long run she is invested but not loyal: she knows exactly what the book has cost her, and she forgives a slow or repeated chapter less than a new reader would. Judge whether each chapter earns its price and makes the next hard to put down.

The core test: finish the sentence "After this chapter, ___" with something that is now different. "After this chapter, she knows he didn't take it" passes. "After this chapter, they're further down the road" fails. Progress need not be action; in a romance it can be two people moving toward understanding. This author's chapters run about 800 to 1,300 words by ruling and splits are welcome, so never judge length against platform word counts. Judge whether the cut falls where something turns, not mid-scene.

Every chapter needs pull; not every chapter needs a cliffhanger. Pull means ending where the reader can't comfortably leave: a decision, danger, a revelation, the arrival of someone who matters, an emotional turn, sexual tension, a puzzle, or a confrontation that shows only one person's reaction. Endings of one kind every time read as a toll gate. The ending is built in the middle: a plain practical last line pulls hard when everything above it loaded the situation, and a loud last line can't rescue a chapter that wandered. A fake-out, a threat that is nothing when the next chapter opens, teaches readers to stop trusting every break. Each chapter should answer the question the last one asked and ask a new one.

Long serials sag in the middle in two ways: the lead stops driving and only reacts (or runs on one motive past its shelf life until she looks stupid rather than strong), and the stakes stop climbing because they are pinned to a date instead of to what someone decides. Selling the reader the same beat twice is the other sag; a third interrupted near-miss is a repeat she has already paid for.

At the arc level, readers stay for arcs they can see close, with threads staggered so that something is ending, something peaking and something starting. Time skips belong at arc boundaries, never mid-arc where they throw away tension she paid for. In a plan, check each chapter's change, ending kind and seam; on the page, check what actually turned and what the ending stands on.`,
  criteria: [
    { id: "SP1", title: "The chapter changes something", check: "Can you finish 'After this chapter, ___' with a concrete change a reader could name (a fact learned, a decision made, a relationship moved, a situation altered), not just movement or time passing? In a plan, answer per chapter. n_a for a fragment that is not a whole chapter or card." },
    { id: "SP2", title: "Pull at the ending", check: "Does the chapter end at a point the reader can't comfortably leave (an open question, decision, danger, arrival, turn or tension), rather than resolving into rest or trailing off? A non-cliffhanger ending is fine if it pulls. n_a if the text has no chapter ending." },
    { id: "SP3", title: "Ending built in the middle", check: "Is the ending's pull earned by a situation the chapter loaded beforehand, rather than a loud last line tacked onto a chapter that wandered? A plain final line passes when the situation above it is loaded. n_a if there is no chapter ending." },
    { id: "SP4", title: "Ending kinds vary", check: "Compared with the endings of the preceding few chapters (search the manuscript, or the other chapters in the plan), is this ending a different kind (decision, danger, revelation, arrival, emotional turn, sexual tension, puzzle, one-sided confrontation), rather than the same kind again? n_a if no preceding chapter endings are available." },
    { id: "SP5", title: "No fake-outs", check: "Is the threat or question at the previous chapter's end real when this chapter opens, and is this chapter's own ending set up to be real in the next (not a danger that turns into nothing at once)? n_a if neither a previous ending nor a following opening can be checked." },
    { id: "SP6", title: "Answer one, ask one", check: "Does the chapter answer (or materially advance) the question the previous chapter ended on, and raise a new one? n_a for the first chapter of the book or a fragment." },
    { id: "SP7", title: "The lead drives", check: "Does the POV lead want something on the page early and act on it in this chapter, rather than only reacting, crying or flinching, or running on one stale motive with no reason shown? n_a if the chapter is deliberately an interlude from a side character." },
    { id: "SP8", title: "Stakes climb from choices", check: "Does this chapter cost someone more, or risk more, than the comparable recent chapters, and do the stakes come from a decision someone makes rather than only from a date or deadline approaching? n_a for a fragment." },
    { id: "SP9", title: "No repeat beat sold twice", check: "Does the chapter re-run a beat the reader has already paid for (the same interrupted near-miss, the same argument, the same question asked again) without going further or leaving the characters changed? Search the recent manuscript for the same beat." },
    { id: "SP10", title: "Cut at a turn, not for length", check: "Does the chapter break fall where something turns, rather than splitting a scene midway so the midpoint has to be dressed up as a hook? Never penalise a short chapter for its length. n_a for a fragment." },
    { id: "SP11", title: "Arc shape and skips", check: "In a plan or at an arc boundary: does the arc visibly close, with threads staggered so something ends, something peaks and something starts, and is any time skip placed at the arc boundary rather than mid-arc? n_a for a mid-arc chapter with no time skip.", minorOnly: true },
  ],
};
