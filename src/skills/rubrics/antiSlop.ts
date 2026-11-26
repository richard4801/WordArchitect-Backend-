import type { SkillDefinition } from "../types.js";

// Skill 07, distilled from docs/skill-research/07_anti-slop.md. Only the
// portable craft findings are kept; the brief's chapter-specific advice for
// another book's Ch 71-75 is deliberately not carried over.
export const antiSlopSkill: SkillDefinition = {
  key: "anti_slop",
  role: "skill_anti_slop",
  title: "Anti-slop (formula and machine-made writing)",
  priority: 1,
  proseTargets: ["beat_card", "prose_fragment", "prose_scene", "prose_chapter"],
  planningStages: ["stage_1_summary", "act_summary", "part_outline", "part_beats", "codex_documentation", "hook_chapters_outline"],
  maxLevel: "FLAG",
  reviewerModel: "Opus 5.5",
  rubric: `Working definition: slop is what you get when every choice is the likeliest one — the likeliest word, image, next event, chapter ending. Any single likely choice is fine. A passage built mostly of them reads as if nobody made it, and paying readers of serial romance can tell and punish it. Your job is to find where the likeliest choice was taken in place of a specific one, and say what specific thing is missing.

What specificity looks like: an object, a physical act, a line someone actually says, a detail only this world could produce. "He tears the heel off the loaf, puts it in her hand and doesn't let go of her wrist until she bites. 'Eat.'" is specific. "A tender moment over food reveals his softer side, highlighting their evolving dynamic" is slop: no object, no act, no line, and analysis words where events should be.

Known signals (signs, not proof — people wrote these first; judge clustering and substitution, not single honest uses):
- Over-used phrases measured across dozens of language models: flickered, a voice barely above a whisper, took a deep breath, eyes never leaving, every fibre of my being, pulse roared in my ears, eyes that seemed to see right through me, after an eternity, eyes darkening, the sentence shape "it's not X, it's Y".
- Inflated analysis words: pivotal, palpable, visceral, electric, crackles, tapestry, testament, underscores, sets the stage, deepens their bond, evolving dynamic, tension rises, everything changes; trailing "-ing" clauses pretending to analyse ("highlighting her resilience"); lists of three used to look thorough.
- Where stock phrasing gathers: moments where two people look at each other and the writer has to say what a look is like. Lines readers remember gather where someone does something with an object or a body.

Genre furniture that reads as copied from the factory template of werewolf serials: the growled "Mine", darkening eyes, snarling at another man as a stand-in for a romantic beat; the agonising bone-cracking shift used by default; a cursed king, scheming beta, prophecy, cold mother or cruel sister used in the expected way. The test: could this beat sit in any werewolf book with the names changed?

Plot-level slop: events that happen because they're next rather than because someone wanted something; rescue by coincidence or perfect timing (an overheard conversation, a bond that summons him exactly when she's hurt, a guard walking in at the right second); a power, prophecy or bond solving what a choice should; a misunderstanding one honest sentence would end with no reason on the page why it can't be said; characters explaining their feelings or a villain explaining his plan in a full speech; endings that summarise their own meaning ("nothing would ever be the same"); every antagonist insulting the heroine in the same way at the same volume.

Outlines and plans are prose too: in a plan, bold labels doing the work ("Romance beat:"), analysis words and checklist shape are the outline-level version of the same failure. A beat is ready only when it names the object, the line and the physical act; a vague word usually sits where the specific thing hasn't been found yet.

Close first-person narration may name a feeling now and then; flag labelled emotion only where it replaces the physical evidence at a beat that matters.`,
  criteria: [
    { id: "AS1", title: "Stock phrasing", check: "Are machine-overused phrases or stock figures (see the list and the deterministic scan hits) clustered, or used where a specific detail should be? Single honest uses are fine." },
    { id: "AS2", title: "Looks instead of acts", check: "Are emotionally important beats carried by gazes, eyes and looks described with stock figures, rather than by an act, an object or a spoken line?" },
    { id: "AS3", title: "Labelled emotion and thought verbs", check: "Does the text name feelings or realisations (realised, knew, felt a surge of) where the physical evidence should be, at beats that matter?" },
    { id: "AS4", title: "Restated meaning and summary endings", check: "Do paragraphs, scenes or the chapter close by restating what was already shown, or end on a summary of their own meaning?" },
    { id: "AS5", title: "Explained feelings or plans", check: "Does anyone explain their feelings, or a villain his plan, in a full speech beyond what that person would say to that listener for that purpose?" },
    { id: "AS6", title: "Vague abstraction", check: "Are there abstract or inflated words (tension rises, stakes deepen, pivotal, highlighting…) where an object, a line or a physical act should be? In outlines: can each beat's object, line and act be named?" },
    { id: "AS7", title: "Genre furniture (name-swap test)", check: "Would beats or images fit any werewolf book with the names swapped (growled 'Mine', darkening eyes, default agonising shift, template villains used the expected way), instead of using what only this book's world has?" },
    { id: "AS8", title: "Convenient causation", check: "Does anything happen by coincidence, timing or overhearing; does a power, prophecy or the bond solve what a choice should; is there a misunderstanding one sentence would end with no reason given? Mark n_a if the text is too short to have plot." },
    { id: "AS9", title: "One-voice chorus", check: "Do antagonists or insults sound interchangeable, without their own reason, target and cost? Mark n_a if there are none." },
    { id: "AS10", title: "Repeated shapes", check: "Do sentence shapes, paragraph openings, beats or endings repeat in kind within this text?" },
    { id: "AS11", title: "Signs of a maker", check: "Is there at least one detail, choice or line that only this book could produce, or anything genuinely funny? (Absence alone is minor, never major.)", minorOnly: true },
  ],
};
