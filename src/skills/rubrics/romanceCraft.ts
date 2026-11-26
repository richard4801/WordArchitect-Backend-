import type { SkillDefinition } from "../types.js";

// Skill 02, distilled from docs/skill-research/02_romance-craft.md. Only the
// portable craft and reader findings are kept; the brief's diagnosis of
// another book and its chapter-specific advice for Ch 71-75 are deliberately
// not carried over. Secrets and dramatic irony belong to skill 05, heat to 03,
// genre promises (bond, alpha, rejection, claiming, the moon) to 01, chapter
// endings to 04.
export const romanceCraftSkill: SkillDefinition = {
  key: "romance_craft",
  role: "skill_romance_craft",
  title: "Romance craft (arc, tension, honest separation)",
  priority: 4,
  proseTargets: ["beat_card", "prose_chapter"],
  planningStages: ["act_summary", "part_outline", "part_beats", "hook_chapters_outline"],
  maxLevel: "FLAG",
  reviewerModel: "Opus 5.5",
  rubric: `Working definition: a romance plot is a chain of changes in what they are to each other. A good chapter leaves the couple somewhere different with each other than where it found them, and the change comes from one of them wanting something from the other and paying for it. Readers will wait through almost any delay if they believe the reason for it; they leave when they stop believing it. On a pay-per-chapter platform, leaving means not buying the next one.

What good looks like: attraction aimed at something particular about this person, shown from both sides in what each does and says. Resistance that is conflict, not trouble: his goal works against hers and hers against his, tied by one knot no single sentence can untie (the conflict box). Push and pull where each turn costs someone something, and a release that leaves them somewhere new. A midpoint that is a commitment, a step neither can take back, after which the question changes from "will they?" to "can this survive what they are?" A dark moment that comes out of a character's own choice, landing when the love is clearest. A repair that matches the offence in place, tone and size, and is change the reader can see, not a speech; a proud character declares in his own register, an order that gives something away or a plain fact that costs him.

What failure looks like: a plan written as events ("the ball", "the fight") with nothing saying what the two are to each other at the end; the same disaster or the same almost repeated; a third near miss at the edge; a separation built on information one honest question would clear, kept going with no reason on the page; both leads holding negative goals (waiting for the other to beg, to earn it), so nobody moves; the leads kept in different rooms, by distance or a third person, for chapters at a time; "they did" arriving with no new question; forgiveness before any confrontation; a grovel of repeated apology without visible change.

How to judge it. In a plan (card, outline, beats): for each chapter, can you write one line on where the couple stands at its end compared with its start? Is there a want, a resistance, a result and a decision? Is the declaration or gesture written as the actual line or act, not "he admits his feelings"? On the page: find the turn, name who paid for it, and check the state really moved. Search the manuscript for prior near misses and the offences a repair must answer before calling anything repeated or matched.`,
  criteria: [
    { id: "RC1", title: "A change, not an event", check: "Do the two leads end this chapter or unit in a different state with each other than they began it, statable in one line (closer, further, a new knowledge or term between them)? In a plan: does each chapter's line name that change rather than an event? n_a if only one lead appears and nothing between them is at stake." },
    { id: "RC2", title: "Specific, two-sided attraction", check: "Is the attraction aimed at something particular about this person, shown in what each lead does or says (in a multi-POV book, from both sides across the text or the plan), rather than generic appeal or one-sided pining? n_a if neither lead's attraction is in play in this text." },
    { id: "RC3", title: "Conflict, not trouble", check: "Is what keeps them apart a clash of goals (one lead's goal is the other's obstacle, and vice versa) rather than bickering or a misunderstanding a single conversation would clear? n_a if the text contains no resistance between the leads." },
    { id: "RC4", title: "Push and pull that costs", check: "Does each turn between them come from one lead going after something from the other, cost someone something, and end in a decision; and does any release leave them somewhere new rather than where they started? Is any disaster or turn a repeat in kind of one already used (search the manuscript)? n_a for a fragment with no exchange between them." },
    { id: "RC5", title: "Near-miss limit", check: "If intimacy or a declaration stops at the edge here, is the stop caused by something on the page, and is it not the third or later such stop in the current run (search the manuscript for prior near misses)? n_a if nothing stops at the edge." },
    { id: "RC6", title: "Honest separation", check: "Is what keeps them apart the lock (who they are, what they want, what they fear) rather than withheld information? If it is information, does it come out soon, or is there a reason on the page it can't be said yet, and is it still growing rather than stale? n_a if nothing keeps them apart in this text." },
    { id: "RC7", title: "Wants, not waits", check: "Does at least one lead pursue something from the other here, rather than both holding negative goals (waiting for the other to beg, earn it, move first) so neither moves? n_a if only one lead appears." },
    { id: "RC8", title: "Commitment and the next question", check: "Where a declaration, first kiss, first sex or other commitment lands (or the plan places the midpoint), does it change the question rather than end it, so a new question about whether this can survive replaces 'will they'? In a plan covering the middle: is there a commitment point at all, or are retreat beats firing before any commitment was made? n_a if no commitment lands and the unit doesn't span the midpoint." },
    { id: "RC9", title: "Dark moment from a choice", check: "If this is a dark moment or breakup, does it come from a character's own earlier choice or long-built fear (set up before this point), rather than an outside accident or an avoidable misunderstanding, and does it make a character choose rather than park? n_a if there is no dark moment or breakup." },
    { id: "RC10", title: "Grovel and declaration in register", check: "If a lead repairs a harm or declares a feeling: does the repair match the offence in place, tone and size (spoken offences repaired aloud, public ones at least once where others see) and show visible change rather than repeated apology, with no forgiveness before a real confrontation; and is the declaration in that character's own register (an order that gives something away, or a plain fact that costs him), not a speech? In a plan, is the actual line or act written? n_a if there is no repair or declaration." },
    { id: "RC11", title: "Same room", check: "Do the leads stay in the same room, or, where they are apart (by distance or a third person) for more than about a chapter, is there something that makes each feel the other on the far side? n_a for a single fragment or a beat card that doesn't cover more than one chapter.", minorOnly: true },
  ],
};
