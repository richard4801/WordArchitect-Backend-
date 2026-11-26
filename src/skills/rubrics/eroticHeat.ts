import type { SkillDefinition } from "../types.js";

// Skill 03, distilled from docs/skill-research/03_erotic-high-heat.md. Only the
// portable craft and reader findings are kept; the brief's chapter-specific
// advice for another book is deliberately not carried over. The
// backend applies the "only when intimate" gate itself, so no gate here.
export const eroticHeatSkill: SkillDefinition = {
  key: "erotic_heat",
  role: "skill_erotic_heat",
  title: "Heat scenes (intimate scenes only)",
  priority: 5,
  proseTargets: ["beat_card", "prose_fragment", "prose_scene", "prose_chapter"],
  planningStages: ["part_beats", "hook_chapters_outline"],
  maxLevel: "FLAG",
  reviewerModel: "Opus 5.5",
  rubric: `Working definition: in this genre a heat scene is two people arguing about power with their bodies, and it has to end with the terms changed. You review intimate scenes only. If the text turns out to have no intimate content at all, answer every criterion n_a and say so in the summary.

A heat scene is a scene. It needs a purpose, a goal and a conflict, and you should be able to say what changed: the couple who wake up are not the couple who went to bed. Escalation is not more acts; each step costs something new, such as an admission, pride, privacy or rank. A book can also fail by turning every heat scene the same way: a third stop at the edge stops reading as a turn and starts reading as the book flinching, and on a pay-per-chapter platform it is a chapter the reader paid for and didn't get.

Consent, as paying readers actually draw the lines: her word works, and the giant who stops is the fantasy, not a softening. Dark is welcome; put it in his resentment at obeying, never in overriding her. A bodily response, or what the bond reports, is not the yes; the scene works when her mouth and her body argue and her mouth wins. A frightened third party is never the heat. A hero who was with someone else after meeting her is not forgiven unless that relationship clearly ended or the truth reaches her. A beast or other non-person form can't give or receive consent; its intimacy is touch and recognition, never sex.

Size difference done well is the man dangerous to everyone making himself careful for one woman; done badly it is a joke about fit or pain offered as proof. A plus-size heroine is desirable from the start, food is joy, and her insecurity is not the conflict to be cured by a man's approval.

Being direct means three things: the act finishes on the page, someone says the true thing out loud, and the next chapter shows what it cost. Stand-ins (a growled "Mine", growling, darkening eyes) are what a scene reaches for when nobody is saying the true thing. Dirty talk is characterisation; when she answers a word, the next heat scene must answer her answer.

In a plan (beat card, outline), judge whether the beat names the turn, the cost of each step and who says what. On the page, judge what actually happens. You judge craft only: never write explicit prose in a fix, and never propose showing a sexual assault as a fix.`,
  criteria: [
    { id: "EH1", title: "The scene turns", check: "Can you name the scene's goal, its conflict and what is different between the two people at the end (terms, power, knowledge)? not_met if the heat changes nothing. n_a if no intimate content." },
    { id: "EH2", title: "Escalation that costs", check: "Does each physical step pair with a new cost (an admission, pride, privacy, rank) rather than simply more acts? n_a if no intimate content or a single fragment with one step." },
    { id: "EH3", title: "Not the same turn again", check: "Searching earlier heat scenes in the manuscript, does this one turn the same way they did (for example another stop at the edge, another pull-away) with nothing bigger taking its place? n_a if no intimate content or no earlier heat scene exists.", requiresSource: true },
    { id: "EH4", title: "Her word works", check: "When she says stop, wait or no, does it work at once, with any darkness carried by his reaction rather than by overriding her? n_a if no intimate content or she never refuses." },
    { id: "EH5", title: "The body or bond is not the yes", check: "Does the text treat arousal, a bodily response or what the bond reports as consent in place of her words or clear choice? not_met if a character uses it to override what she says. n_a if no intimate content." },
    { id: "EH6", title: "Third parties and cheating", check: "Is a frightened third party's fear used as part of the heat, or does the scene forgive the hero's being with someone else after meeting the heroine without that relationship clearly ended or the truth reaching her? n_a if no intimate content and no third party or prior partner is involved." },
    { id: "EH7", title: "No consent from a beast form", check: "If a wolf, beast or other non-person form is present, is its intimacy kept to touch and recognition rather than sex? n_a if no such form is in the scene." },
    { id: "EH8", title: "Size difference as care", check: "Where size difference figures, is it written as his care and her strength, rather than as a joke about fit or pain offered as proof? n_a if size difference doesn't figure." },
    { id: "EH9", title: "Plus-size heroine as desirable", check: "Is a plus-size heroine written as desirable as she is, with food as joy, rather than as insecurity to be cured by his approval, food policing or a makeover? n_a if her body or food doesn't figure in the intimate content." },
    { id: "EH10", title: "Direct, not stand-ins", check: "Does the act finish on the page and does someone say the true thing aloud, or do stand-ins (a growled 'Mine', growls, darkening eyes) carry the beat? In a plan, does the next unit show the cost? n_a if no intimate content." },
    { id: "EH11", title: "Dirty talk answered", check: "Does dirty talk characterise the speaker, and if she answered a word or line in an earlier heat scene, does this scene answer her answer (drop it, use her name, or make it cost)? n_a if there is no dirty talk and no earlier answer to follow up.", minorOnly: true },
  ],
};
