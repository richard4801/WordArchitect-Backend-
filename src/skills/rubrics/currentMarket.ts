import type { SkillDefinition } from "../types.js";

// Skill 08, distilled from docs/skill-research/08_current-market.md. Only the
// portable market findings are kept; the brief's closing advice for another
// book's chapters is deliberately not carried over. View counts and
// ratings are left out of the criteria on purpose: they go stale in weeks.
export const currentMarketSkill: SkillDefinition = {
  key: "current_market",
  role: "skill_current_market",
  title: "Market positioning (as of Nov 2026)",
  priority: 9,
  proseTargets: [],
  planningStages: ["stage_1_summary", "act_summary"],
  maxLevel: "FLAG",
  reviewerModel: "Opus 5.5",
  researchDate: "2026-11-06",
  rubric: `Working definition: in werewolf romance the premise gets the click and the payment keeps the reader. Judge where this plan sits in the field and whether it sells what readers here keep paying for. The market facts below are a dated snapshot, read on 6 November 2026. When a finding rests on a time-sensitive fact (what is trending, which lane is crowded or empty), say so in the note.

Three markets share the word "werewolf": the pay-per-chapter apps (a single dominant Alpha or Lycan King, a low-ranked heroine, volume), the bookshop and BookTok, where every big wolf book is sold as romantasy, and microdramas filming the app stories. The premise words of this book (Alpha, King, rejection, fated bond) are the shelf readers go looking for. They bring readers in and set nothing apart; specifics keep them: a world, a rule, a danger, an object no neighbouring book has.

What the winners share: the hook is an injury (a public rejection, a humiliation, a debt run up by the hero) and the engine is that debt paid back on the page, where she can see it; "the grovel was non-existent" is the review that sinks a regret book. She is low and he is the top of the chain, so every kindness costs him in front of people, and the best of them give the low girl one thing nobody above her has. The bond is a fact, not a question: readers pay to watch what acting on it costs, not to learn whether two people are mates. Finished shapes beat fresh ones; readers who have been left hanging trust a book that visibly goes somewhere. Where the heroine's body is part of the premise, the good word about it is the payoff, said to her face by the hero in his own voice.

What readers are tired of: sameness (the same tropes with different names), the misunderstanding one sentence would end, cruelty the book treats as charm and never bills, a heroine carried by the plot, heat with no yearning before it or nothing changed after it, and stretches where nothing happens; on a coin paywall, drag shows up on the invoice. Good premises slid when the hero hurt her without paying, when the couple went flat in a middle book, and when nothing happened.

At stage_1_summary also run three pitch checks: one logline, a hook in the opening beat, a nameable emotional engine. At act_summary those three are n_a; judge whether the act keeps the premise's promise.

Do not quote view counts, ratings or rankings as a reason; cite the pattern. Chapter length is the author's call; never penalise short chapters against platform word counts.`,
  criteria: [
    { id: "CM1", title: "Shelf words versus specifics", check: "Take the premise apart word by word: which words are crowded shelf words (Alpha, Lycan King, rejected, fated mate, Luna), and does the plan name at least one concrete specific (a world, a rule, a danger, an object) that no neighbouring werewolf book has? not_met if every element would fit a dozen app titles." },
    { id: "CM2", title: "Injury hook, debt engine", check: "Does the plan name the injury or debt the reader is buying (a rejection, humiliation or cruelty by the hero) and does it put the repayment on the page, in front of her, rather than in his head or offstage? n_a if the premise carries no debt." },
    { id: "CM3", title: "Rank gap and the one thing", check: "Is there a real rank gap that makes his kindness cost him in public, and does the low-ranked heroine have one specific thing nobody above her has? n_a if the premise has no rank gap by design." },
    { id: "CM4", title: "Bond as a fact", check: "Does the plan treat the bond as settled and sell what acting on it costs, rather than spending its tension on whether the two are mates at all? n_a if there is no bond in the premise." },
    { id: "CM5", title: "The body, said out loud", check: "Where the heroine's body or looks are part of the premise, does the plan give the hero a moment of saying what he wants to her face, in his own voice, rather than only in his head or through other characters? n_a if her body is not part of the premise." },
    { id: "CM6", title: "Heroine drives", check: "Does the heroine make at least one consequential choice in this unit for a reason she could say aloud, with the result landing on her, rather than being carried by the plot or rescued?" },
    { id: "CM7", title: "Known fatigue patterns", check: "Does the plan lean on a pattern readers of this field are tired of: cruelty the story treats as charm and never bills, a misunderstanding one honest sentence would end, heat with no yearning before it or nothing changed after it, or a stretch where nothing happens? Name which one." },
    { id: "CM8", title: "Visibly going somewhere", check: "Does the unit read as heading toward an ending (threads close, the shape is visible) rather than circling? n_a for a stage_1 summary that already names its ending shape.", minorOnly: true },
    { id: "CM9", title: "Pitch: one logline", check: "At stage_1_summary: does the premise compress to one logline with a concrete protagonist, a want and an obstacle? n_a at act_summary." },
    { id: "CM10", title: "Pitch: opening hook", check: "At stage_1_summary: does the opening beat hook with conflict, a reveal or a question rather than setup, backstory or world description? n_a at act_summary." },
    { id: "CM11", title: "Pitch: nameable engine", check: "At stage_1_summary: can the emotional engine be named in a word or two (love, betrayal, secrets, power, revenge, injustice) from what the summary actually says? n_a at act_summary." },
  ],
};
