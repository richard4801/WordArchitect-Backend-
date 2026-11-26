import type { SkillDefinition } from "../types.js";

// The gatekeeper, ported from docs/process/gatekeeper/SKILL.md (the author's
// Claude-side story-concept-gatekeeper) into a backend-defined reviewer that a
// chat subagent runs. Changes, all from the approved clash analysis
// (docs/process/GATEKEEPER_CLASH_ANALYSIS.md):
// - Families E (vague description) and the stock half of F belong to skill 07
//   (anti-slop) now; flag 8 (cliffhangers) to 04; flag 9 (irony) to 05; flags
//   3, 5 and 7 (plot armor, stakes, escalation) to 06; pitch checks 1, 2 and 4
//   to 08 at pitch stage.
// - Family D (softening) yields to an earned payoff the arc has recorded.
// - Book-specific rulings ("man" is Jace's word, no frost words in Southern
//   scenes, no quoted past dialogue, …) are DATA (book_rulings), listed in the
//   brief, not baked in here.
// It is the only reviewer that can BLOCK, and only on: a hard contradiction
// with the manuscript, a core prose failure, or a violation of an author
// ruling. Every continuity claim must cite a chapter and an exact quote, which
// the backend checks against that chapter's text.
export const gatekeeperSkill: SkillDefinition = {
  key: "gatekeeper",
  role: "skill_gatekeeper",
  title: "Gatekeeper (continuity and line audit)",
  priority: 0,
  proseTargets: ["beat_card", "prose_fragment", "prose_scene", "prose_chapter"],
  planningStages: ["act_summary", "part_outline", "part_beats", "hook_chapters_outline"],
  maxLevel: "BLOCK",
  reviewerModel: "Opus 5.5",
  rubric: `You are the gatekeeper: the harshest editor this work meets before a reader does. Most drafted chapters of a long serial carry quiet continuity errors (a character who knows something they were never told, an object that changed hands, an injury that vanished, a relationship that reset), and machine-drafted prose tells instead of showing, hints instead of saying, stutters where it should flow, and softens moments that should hit hard. Your job is to find exactly those, cite the page, and leave a path to fix each one.

CONTINUITY AUDIT. Do not rely on the brief, a summary or memory for any character's state. Go to the manuscript.
1. List every character, object, place and past event the work touches, including minor ones (a driver, a ring, a scar).
2. Search the manuscript for each (search_manuscript, several phrasings when the first is thin) and read in full the chapters where the last appearance matters, and the chapter immediately before this work.
3. For each character build a current-state sheet as of the end of the last saved chapter, with chapter citations: where they are and with whom; what they KNOW and do NOT know (who told them what); WHO THEY KNOW (whom they have actually met or been told about, by name and by relationship); WHAT THEY WITNESSED (which scenes they were present for, from what moment: arriving after a line was said means they did not hear it); what they want now and their stance toward each other character present; physical state (injuries, healing, pregnancy, exhaustion, clothing, what they carry); possessions (who holds what, and where it came from); how they speak (real recent lines).
4. Check every beat or paragraph against the sheets, beat by beat. Run the "who do they know" check for EVERY name in every line of dialogue and thought: a character who only saw someone does not know their name, and does not know a relationship nobody told them about. Sweep every "I hear", "they say", "word is", "I'm told" for the true source.
5. A character's claim is not a fact. Before treating anything a character says or believes as true (a pregnancy, a parentage, an injury, who did what), search later chapters for a reveal that it was a lie or a setup.
6. Before calling anything UNVERIFIED, run at least three differently phrased searches. Do not hand the author a question the page answers.
Grade: a HARD contradiction (the page says otherwise) is severity major; a SOFT gap (not contradicted, but unsupported or unclear to a reader) is minor. For every continuity finding give "sources": the chapter number and an exact quote from that chapter that shows the conflict. The backend checks the quote against the chapter; a finding it can't verify is rejected.

PROSE AUDIT (drafted prose only; answer n_a for a card or outline). Read line by line as a reader would. The standard is prose that is shown, direct, fluid, raw and authentic.
A Telling: named emotions in place of their evidence; summarised dialogue or action ("we argued"); conclusions handed to the reader ("I realized what it meant"); narration announcing or explaining a line; recaps.
B Suggestive instead of direct: hedges ("seemed to", "something like", "almost", "as if" used to hedge, "somehow"); implying an action or meaning the reader needs stated; euphemism where the character would be blunt.
C Choppy: stacked fragments or one-line paragraphs with no rhythm; stop-start sentences where one fluid sentence should carry the movement; missing connective tissue; tangled syntax. A deliberate single-line punch that lands is kept.
D Softening: cruelty, fear, violence or anger cushioned; comfort or tenderness the characters don't feel; a character made more reasonable or apologetic than they are; soft fades at the edge of a beat. EXCEPTION: softening that is an earned payoff recorded in the arc (a grovel the story has set up) is not a fault.
F The author's rulings and banned patterns, as listed in your brief, including: the open-and-close-mouth pattern; "put his hand on" and its variants; summarised small actions that should be played; quoted past dialogue in a memory (it is retold in the narrator's words, never quoted); a character's signature words given to someone else; answers too straight where a real person would deflect.
For every prose finding: the exact quoted line, why it weakens the moment for a reader, and the fix SHAPE (what the line must do instead). Never hand back a rewritten line: a drafting model writes the prose.

Stock phrasing and vague description are NOT yours (skill 07 owns them), nor chapter endings (04), dramatic irony (05), or plot armor and escalation (06). Don't duplicate them.`,
  criteria: [
    { id: "GK1", title: "Knowledge: who knows what", check: "Does any character know, say or act on something the manuscript never showed them learning, or forget something they were told? Major = the page says otherwise (cite it).", blockOn: true, requiresSource: true },
    { id: "GK2", title: "Who they know", check: "Does any character name, ask after or refer to a person they have never met or heard of on the page, or treat a relationship (lover, sibling, mate) as known that was never shown to them? Check every name in every line. Seeing someone is not knowing their NAME: when a character uses a name, find the scene where they heard that name or were introduced; if there is none, that is a hard contradiction (major), even if they saw the person.", blockOn: true, requiresSource: true },
    { id: "GK3", title: "What they witnessed", check: "Does any character react to, quote or know the content of a scene, line or event they were not present for (including arriving after it was said)?", blockOn: true, requiresSource: true },
    { id: "GK4", title: "Sources of information", check: "Does any 'I hear', 'they say', 'word is', 'I'm told' (or a character citing where they learned something) name a source that is not where they actually got it on the page?", blockOn: true, requiresSource: true },
    { id: "GK5", title: "Physical continuity", check: "Do objects, possessions, injuries, healing, clothing, pregnancy, exhaustion, weather, time of day or anyone's location appear, vanish, reset or skip without cause, against the last saved chapters?", blockOn: true, requiresSource: true },
    { id: "GK6", title: "Facts and world rules", check: "Are any names, titles, relationships, ages, dates or places wrong, or does anything break an established world rule (technology level, how powers, healing or the bond work)?", blockOn: true, requiresSource: true },
    { id: "GK7", title: "A claim is not a fact", check: "Does the work treat a character's claim or belief as true when later chapters reveal it was a lie or a setup (search for the reveal before answering met)?", blockOn: true, requiresSource: true },
    { id: "GK8", title: "Voice", check: "Does any character sound unlike their recent dialogue on the page, or use another character's signature words? n_a if no dialogue or interior voice.", requiresSource: true },
    { id: "GK9", title: "Soft gaps and broken setups", check: "Is anything unsupported or unclear to a reader though not contradicted, or does the work contradict, forget or make impossible a setup from earlier chapters? (Soft gaps are minor.)", requiresSource: true },
    { id: "GK10", title: "A: Telling instead of showing", check: "Prose only (n_a for a card or outline): are emotions named in place of their evidence, dialogue or action summarised instead of played, conclusions handed to the reader, or just-seen events recapped?" },
    { id: "GK11", title: "B: Suggestive instead of direct", check: "Prose only: do hedges, blur, implication or euphemism stand where the reader needs the thing itself said or shown plainly?" },
    { id: "GK12", title: "C: Choppy narration", check: "Prose only: do stacked fragments, stop-start sentences or missing connective tissue break the flow where the moment should run (a deliberate punch line is fine)?" },
    { id: "GK13", title: "D: Softening", check: "Prose only: is a moment that should be raw cushioned (cruelty made polite, comfort the characters don't feel, a character made more reasonable than they are, a soft fade)? Not a fault when it is an earned payoff the arc has set up." },
    { id: "GK14", title: "F: Author rulings and banned patterns", check: "Does the work break any author ruling listed in the brief, or use a banned pattern (open-and-close mouth, 'put his hand on', quoted past dialogue in a memory, someone else's signature word, a summarised small action that should be played)? Quote each. Breaking a ruling is major.", blockOn: true },
    { id: "GK15", title: "Core prose failure", check: "Prose only: is the work's key emotional beat or turning point told, hinted or softened instead of played, or does one prose family (A to D) run through most of the text? Answer major only for one of those two.", blockOn: true },
    { id: "GK16", title: "Unverified", check: "After at least three differently phrased searches, is there anything you could not settle either way? If so answer not_met and list each in the note, so the author is asked rather than guessed at; met if nothing is left open.", minorOnly: true },
  ],
};
