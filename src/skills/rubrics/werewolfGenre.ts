import type { SkillDefinition } from "../types.js";

// Skill 01, distilled from docs/skill-research/01_werewolf-shifter-romance.md.
// Only the portable genre and market findings are kept; the brief's
// chapter-specific advice for another book's Ch 71-75 is deliberately not
// carried over. Heat belongs to skill 03, romance arc mechanics (tension,
// black moment, the full grovel arc) to skill 02.
export const werewolfGenreSkill: SkillDefinition = {
  key: "werewolf_genre",
  role: "skill_werewolf_genre",
  title: "Werewolf genre promises",
  priority: 3,
  proseTargets: ["beat_card"],
  planningStages: ["stage_1_summary", "act_summary", "part_outline", "part_beats", "hook_chapters_outline"],
  maxLevel: "FLAG",
  reviewerModel: "Opus 5.5",
  rubric: `Working definition: werewolf readers aren't paying for wolves. They pay to watch the most dangerous man in their world find out he can't do without one woman, and then pay for finding it out in front of people. Every convention (the bond, the alpha, rejection, the mark, the moon) is a way to make that discovery happen to his body before his mind agrees, and then make him admit it. Forget the body and readers call it instalove. Forget the admission and they call it a cheat. Check that each genre beat delivers one half or the other, in this book's own terms.

What good looks like: the bond hands two people a question, not an answer; because he can feel her, every silence of his is a choice made with full knowledge. The alpha is rank, a class fantasy: the man at the top of a visible ladder needing the person at the bottom, and her low status turns out, concretely, to be what the top needs, without a prophecy doing the work. A public wound is reversed in the same coin and before the same witnesses; a private apology for a public rejection reads as unpaid. Claiming turns a private bond into a public fact others must respect, and feeding is the genre's oldest claim: care you can see, in ordinary time, that the one eating has to accept. On the full moon, readers who want the creature and readers who don't agree on one thing: the beast recognising her. A beast that narrates as a second voice is a tic; a beast that does one thing the man won't is a payoff.

What failure looks like: the bond doing the romance's work; cruelty from bad judgement (readers forgive a dangerous hero and punish a stupid one); the hero sleeping with someone else while the bond hurts her, with no answer; a fuller-figured heroine whose body is the conflict and a conventionally attractive hero the cure, with insults repeated at no cost to whoever says them; a run with no humour to carry the reader through the cruelty; genre shapes readers have already seen in ninety-second micro-dramas, with nothing new added.

How to judge: in a plan or beat card, ask whether the beat names who witnesses, what is paid, and what the body does before the mind admits it; a label like "bond moment" or "he claims her" is not yet a beat. Check the manuscript for what has already been established (the bond's mechanics, where the mark sits, who has seen what) before calling a beat new or missing. Judge only genre promises; heat and arc mechanics belong to other reviewers.`,
  criteria: [
    { id: "WG1", title: "Body first, then the admission", check: "Does the bond or attraction register in a body (his or hers) before it is admitted, and does the plan move toward someone saying it aloud rather than leaving it permanently internal? n_a if no bond or romantic beat is in scope." },
    { id: "WG2", title: "The bond poses a question", check: "Does the bond create a choice the characters must act on (what he does or withholds knowing what he feels of her), rather than settling the romance, resolving conflict, or summoning him on cue? n_a if the bond does not appear." },
    { id: "WG3", title: "Alpha as rank", check: "Is the hero's power shown as concrete rank in a visible hierarchy with rules that cost something (who may sit, eat, speak, be chosen), rather than generic dominance, growling or size? n_a if the hero's rank is not in play." },
    { id: "WG4", title: "Reversal in the same coin", check: "Where a rejection or public wound is reversed or answered, is it paid in the same kind of act and before the same witnesses (public wound, public reversal), rather than a private apology? n_a if no rejection or reversal is in scope." },
    { id: "WG5", title: "Claiming made public", check: "Does a claim (mark, bite, feeding, provision) change what other people see and must respect, with the claimed person accepting or refusing something, rather than ownership taken with no choice or a claim nobody witnesses? n_a if no claiming beat." },
    { id: "WG6", title: "The beast recognises her", check: "On a moon or shift beat, does the beast recognise her and do one thing the man won't, rather than spectacle, a default agonising shift, or a beast narrating as a second voice in his head? n_a if no shift or moon beat." },
    { id: "WG7", title: "Low status that the top needs", check: "Is the heroine's low status concrete on the page, and does it become (or move toward becoming) exactly what the top of the hierarchy needs, seen by someone with power, rather than resolved by a prophecy, a hidden bloodline or a makeover? n_a for a unit where her status is not in play." },
    { id: "WG8", title: "Cruelty with a reason", check: "Is every cruel act by the hero driven by a cause established on the page (fear, law, a wound), rather than by obtuse decisions a reader would call stupid; and does his softness show somewhere the reader can see it? n_a if the hero is not cruel in this unit." },
    { id: "WG9", title: "Other beds answered", check: "If the hero is or was with someone else while the bond hurts her, does the plan make that cost him and move toward the truth about it being told, rather than letting it pass unanswered? n_a if this has not happened in the book." },
    { id: "WG10", title: "Her body is not the problem", check: "If the heroine is fat or plus-size, is her conflict something other than insecurity about her body, is she free to eat without counting or apologising, is any praise free of 'despite', and does each insult about her body cost the one who says it? n_a if her body is not in play." },
    { id: "WG11", title: "Humour", check: "Is there at least one genuinely funny moment, line or character (banter, a comic wolf, absurdity) to carry the reader through the cruelty? (Absence alone is minor, never major.)", minorOnly: true },
  ],
};
