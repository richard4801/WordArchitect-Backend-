---
name: "story-concept-gatekeeper"
description: "Run every story pitch, outline, beat card, chapter synopsis or drafted chapter prose through a separate Opus 5.5 gatekeeper agent (quality gate, manuscript continuity audit, and line-level prose audit) before presenting it to the user."
---

# Story Concept Gatekeeper

## Purpose

Most story concepts that get pitched are mediocre: vague premises, contrived
plotting, boring stakes, or tropes executed with zero freshness. Most drafted
chapters of a long serial also carry quiet continuity errors: a character who
knows something they were never told, an object that changed hands, an injury
that vanished, a relationship that reset. And machine-drafted prose has its own
habits: it tells instead of showing, hints instead of saying, stutters where it
should flow, and softens moments that should hit hard. This skill stops Claude
from handing the user any of these dressed up as finished work.

Every pitch, outline, beat card and drafted chapter gets run through the
Quality Gate AND the Continuity Audit below BEFORE it is presented as a
finished deliverable. Drafted prose also gets the Prose Audit. Weak work gets
killed or flagged, with reasons, in front of the user: not silently upgraded and
not silently passed through.

This is tuned for two overlapping markets:
- **Hook-heavy binge format** (Goodnovel serials, ReelShort/DramaBox-style
  vertical drama adapted to prose): every chapter must earn the next tap.
- **Web-novel slow-burn standards**: character depth, earned payoffs, and
  world coherence still matter. This isn't just "add more cliffhangers."

The bar: would this make a reader who has 500 other options keep scrolling
at midnight, without tripping over anything that contradicts what they
already read, and without feeling the prose go soft or vague under them? If the
honest answer is no, it does not pass.

## When this fires

Fire this BEFORE presenting, in the same turn, every time:
- A story/plot outline (full or partial)
- A chapter beat card or chapter-by-chapter synopsis
- A "here's a concept for your novel" pitch
- A logline or premise being proposed as viable
- A revision of any of the above
- Drafted chapter prose, and any substantial revision of drafted prose
  (this is when the Prose Audit runs)
- An evaluation the user explicitly requested of their own idea

Do not fire it for: casual worldbuilding chat with no concept being
finalized, unrelated writing questions (grammar, formatting), or when the
user has already been given a verdict on this exact version and is now asking
an unrelated follow-up.

## WHO runs the gate: a separate agent, on Opus 5.5

The gate is NEVER run by the same agent that wrote the work. The work must not
grade itself.

1. The main session writes the work under review to a file (the card, the
   outline, or the drafted chapter).
2. The main session spawns a SEPARATE agent with the Agent tool to run the
   gate, with the model explicitly set to Opus 5.5 (`model: "opus"`). Do not
   let it fall back to a default or smaller model. If Opus 5.5 is unavailable,
   say so to the user instead of silently using another model.
3. For follow-up passes on the same chapter (re-gates after fixes), the main
   session may resume that same gate agent rather than spawning a new one, so
   it keeps its continuity findings. A new chapter gets a fresh agent.
4. The gate agent is read-only: it never edits the work, the manuscript, the
   docs or any file. It reports; the main session fixes.

The brief the main session gives the gate agent must include:
- The path to the work under review, and to this SKILL.md.
- The book and user IDs (or other handles) needed to search the manuscript.
- What the work follows: the last saved chapter(s) and where they live.
- Author rulings already made that must NOT be reflagged (decisions the user
  has explicitly approved), and lines the author wrote themselves.
- The house rules for the book.
- Any specific focus the main session wants checked.

## Workflow

1. **Draft.** Build the concept, card or chapter as usual.
2. **Hand off.** Spawn the Opus 5.5 gate agent as above.
3. **The gate agent runs the Continuity Audit first**, then (for drafted prose)
   the Prose Audit, then the Quality Gate, checkpoint by checkpoint.
4. **Score severity.** Any AUTO-REJECT trigger kills the work outright,
   regardless of how many other checkpoints it passes. A hard continuity
   contradiction (see below) is an auto-reject.
5. **Always show the verdict to the user**, never silently filter:
   - If it fails: state clearly it's being rejected, name the specific
     checkpoint(s) that failed, quote the specific beat or line, and explain
     why it would lose a reader there. Then propose a fix or ask the user
     which direction to take it.
   - If it passes: present it with a short scorecard of what's carrying it
     (the hook, the emotional engine, the escalation shape, continuity clean,
     prose clean) so the user knows why it was judged sound.
6. **Every flag gets resolved before the work moves on.** Continuity and prose
   issues are fixed (or explicitly waived by the user) before drafting from a
   card, and before saving a chapter. After fixes, re-run the gate on the
   changed parts and report the new verdict.
7. **Never present rejected work as the primary deliverable.** If the user
   says "show me anyway," the rejection reasoning goes first.

## The Continuity Audit (done by the gate agent, against the manuscript)

The gate agent does NOT rely on the brief, a summary, or memory for character
state. It goes to the manuscript itself.

1. **List every character, object, place and past event** the card or chapter
   touches, including minor ones (a driver, a ring, a scroll, a scar).
2. **Search the manuscript for each one** (semantic search, plus reading full
   chapters where the last appearance matters). Search several phrasings when
   the first pass is thin. Read the chapters immediately before the work in
   full.
3. **Build a current-state sheet for each character** as of the end of the
   last saved chapter, with chapter citations:
   - where they are, who they are with, and how they got there;
   - what they KNOW and what they do NOT know (secrets, who told them what);
   - WHO THEY KNOW: which other characters they have actually met or been
     told about on the page, by name and by relationship. A character cannot
     ask after, name, or refer to someone they have never met or heard of,
     and cannot know a relationship (who is whose lover, sister, mate) that
     was never shown to them. Example the author caught (ch565): Kane asked
     "Is Mina happy about it?", but Kane doesn't know Mina exists, or that
     Jace has a woman at all;
   - WHAT THEY WITNESSED: which scenes they were actually present for and
     from what moment. Arriving after a line was said means they didn't hear
     it (ch543: Jace walks in after Kane's accusation in 539, so he only saw
     that something had gone wrong);
   - what they want right now, and their current stance toward each other
     character in the scene;
   - physical state: injuries, healing, pregnancy, exhaustion, what they are
     wearing or carrying;
   - possessions and objects: who holds what, and where it came from;
   - how they speak: real lines from recent chapters, so voice drift shows.
4. **Check every beat or paragraph against those sheets.** Think it through
   step by step, beat by beat. Flag anything that contradicts the manuscript:
   - a character knowing or saying what they were never told, or forgetting
     what they were;
   - a character naming, asking after or referring to a person they have
     never met or heard of, or treating a relationship as known when it was
     never shown to them (run this check for EVERY name in every line of
     dialogue and interior thought);
   - a character citing a source for information that is not where they got
     it (ch565: Jace blamed "the kitchens" for gossip he heard from Ossian;
     Kane heard it from Vidar). Sweep every "I hear", "they say", "word is",
     "I'm told": ch571 had Fenris say "I hear you came North..." when Kane
     told him so to his face;
   - wrong names, titles, relationships, ages, dates or places;
   - objects appearing, vanishing or changing hands without cause;
   - physical states that reset or skip (injuries, weather, time of day);
   - timeline gaps or overlaps with other POV threads;
   - world-rule breaks (technology level, deity, how powers or healing work);
   - voice drift: a character sounding unlike their recent dialogue;
   - setups from earlier chapters that this work contradicts or forgets to pay
     off, and anything this work sets up that later plans can't support.
5. **A character's claim is not a fact.** Before treating anything a
   character says or believes as true (a pregnancy, a parentage, an injury,
   who did what), search later chapters for a reveal that it was a lie or a
   setup. The gate missed this on the ch573 card: it took Elara's pregnancy
   as real from ch342/453, when ch276-277 show it was faked and ch454 shows
   the miscarriage was staged ("The pup never existed").
6. **Don't hand the author questions the page answers.** Before listing
   anything as UNVERIFIED or as a question for the author, run at least
   three differently phrased searches for it. The author has said not to be
   asked anything the manuscript already settles.
7. **Grade each issue:**
   - HARD CONTRADICTION (the page says otherwise): auto-reject until fixed.
   - SOFT GAP (not contradicted, but unsupported or unclear to a reader):
     weakness flag.
   - UNVERIFIED (the agent could not find it either way): list it, so the main
     session can ask the user rather than guess.
8. **Cite everything:** chapter number and a short quote for each flag, so the
   user can check it.

## The Prose Audit (drafted prose only, done by the gate agent)

Read the prose line by line, sentence by sentence, as a reader would. The
standard is prose that is shown, direct, fluid, raw and authentic. Catch every
place it falls short, in these six families:

**A. Telling instead of showing.** The narration reports what a reader should
watch happen.
- Named emotions in place of their evidence: "I was furious", "panic rose in
  me", "I felt hurt". Show the body, the action, the words.
- Summarised dialogue or action: "we argued", "he explained the plan", "I
  protested all the way to the gate". Write the lines, play the moment.
- Conclusions handed to the reader: "I realized what it meant", "that was when
  I understood", "it was clear he didn't care". Let the reader get there from
  what is on the page.
- Narration announcing what dialogue is about to do, or explaining a line after
  it lands.
- Recaps of things the reader just saw.

**B. Suggestive instead of direct.** The prose hints, hedges or gestures at a
thing when the scene needs the thing itself.
- Hedges and blur: "seemed to", "something like", "a kind of", "almost", "as
  if", "somehow", "a hint of", "something shifted".
- Vague abstractions in place of a concrete image or act: "the weight of it",
  "the moment hung", "everything changed".
- Implying an action or a meaning instead of stating it, where the reader needs
  to know plainly what happened or what was said.
- Euphemism where the character would be blunt.

**C. Broken or choppy narration.** Sentences stutter where the moment should
run.
- Strings of fragments or one-line paragraphs stacked back to back with no
  rhythm, so the passage reads as a list.
- Stop-start sentences chopped by commas or full stops where one fluid sentence
  would carry the movement.
- Missing connective tissue, so the reader can't follow cause and effect or who
  is doing what.
- Clumsy or tangled syntax, a dangling clause, or a sentence that has to be read
  twice.
Not every short line is a fault: a deliberate punch line or a single-sentence
beat that lands is kept. Flag choppiness only where it breaks the flow, and say
why that spot needs to run.

**D. Softening.** The draft dulls a moment that should be raw and direct.
Watch this hardest: the drafting model reliably pulls punches.
- Cruelty, fear, violence or anger cushioned: a hard line made polite, a threat
  made gentle, a slap turned into a "push", a swear swapped for something mild.
- Comfort, hope, tenderness or reassurance inserted that the characters do not
  feel at that point.
- A character made more reasonable, apologetic or self-aware than they are.
- Soft exits and fades at the end of a beat ("the world went quiet", "for now,
  that was enough") where the moment should end on its edge.
- Reaction scaled down: a gut punch rendered as a flicker.

**E. Vague description (STANDING RULE, check every draft, every paragraph).**
A line names a category or an abstraction where the reader needs the specific
thing. The author treats every one of these as a fault. Sweep the whole draft
for them, not just the key beats.
- Category words standing in for the thing itself: "something animal,
  something feral", "that spot deep inside", "the smell", "the noise", "the
  room was a mess". Name what it actually is.
- Sensation summarised instead of felt: "it was all sensation, pleasure, pain,
  heat and sweat", "pleasure and pain tangled together", "my body screaming
  for release", "aching and desperate". Say where in the body, what exactly,
  and what the body did.
- Stock stakes and idioms: "one wrong move and it would all come crashing
  down", "my head was foggy", "everything changed". Say the concrete risk or
  state (who could see, what would happen, by when).
- Smells, sounds and textures given a label but no effect: say what it does to
  the character (where it sits in the throat, what the stomach does, whether
  they step back).
- Fixes must stay plain: replacing a vague line with purple prose ("a maelstrom
  of pleasure", "traitorous body", "like a split peach") is not a fix. The fix
  is concrete and in the narrator's own plain voice.

**F. Banned stock patterns and author-flagged habits (STANDING RULE).**
Sweep every draft for patterns the author has banned or flagged before:
- The "opened my mouth... nothing came out / closed it / shut my mouth"
  pattern and every open-and-close-mouth variant. Overused; always flag.
- "Put his hand(s) on me / her / you" and every variant, in narration and
  dialogue. The author finds it suggestive and banned it outright (ch573):
  say plainly what was done (hit, slapped, strangled) instead.
- Summarised small actions that should be played, e.g. "I thanked her and
  headed out" (show the line and the moment instead).
- Quoted past dialogue. When a character remembers something said in an
  earlier scene, the narration never quotes it back; the memory is retold in
  the narrator's own words, filtered through their voice. The author banned
  this outright (ch574: Mina quoting Sera's "I don't know" and "At the feast.
  You'll see."). Never suggest quoting earlier lines as a fix.
- A character's signature words given to someone else (e.g. "man" is Jace's
  word; Kane doesn't use it).
- Frost, ice or snow words in Southern scenes (the North only); Northerners
  speaking stiff or old-fashioned instead of normal everyday speech.
- Questions answered too straight and complete where a real person would
  answer sideways, deflect, or answer a different question.
- Stock, generic phrasing where a fresh, character-specific line would land.
  The author's bar is lines with real creativity, such as "Me, the guy with
  a joke for everything, and I had nothing." Flag flat stock phrasing and say
  what kind of voice-true line the beat needs.

**For every prose flag give:** the exact quoted line, the family (A, B, C, D,
E or F), why it weakens the moment for a reader, and the fix SHAPE: what the line
must do instead (show what, state what plainly, run which sentences together,
which edge to keep). Do not hand back a rewritten line as the fix unless the
brief says the main session writes the prose; where a drafting model writes all
prose, the main session sends the fix shape to that model.

**Severity:** a few scattered prose flags are weakness flags. If the chapter's
key emotional beat or turning point is told, hinted or softened rather than
played, or if one family runs through most of the chapter, that is an
auto-reject for the prose until it is redrafted.

## The Quality Gate

### AUTO-REJECT triggers (any one of these kills the work outright)

**0. Hard continuity contradiction**
Any HARD CONTRADICTION from the Continuity Audit. Name the line, the chapter
it contradicts, and the quote.

**0b. Prose failure at the core**
From the Prose Audit: the key beat is told, hinted or softened instead of
played, or one prose family runs through most of the chapter.

**1. The Vagueness Test: can't state it as one punchy logline**
If the concept can't compress into one sentence with a clear protagonist, a
concrete want, and a concrete obstacle, it's not ready. Reject and demand
specificity: powers doing *what*, opposed by *whom*, at stake for *what*.

**2. No hook in the opening beat**
The first chapter/episode must open on conflict, a reveal, or a question,
never on setup, backstory, or scene-setting. If the opening's job is to
"establish the world" before anything is at stake, reject it and push the
conflict to the first page.

**3. Convenient plotting / plot armor**
Any beat where the protagonist survives, wins, or advances because a new
character/item/coincidence shows up at exactly the right moment with no prior
setup, or because the antagonist inexplicably makes a dumb choice to let the
plot proceed. Also: any character who exists only to feed the protagonist
information or questions. One unearned save is a yellow flag; more than one is
an auto-reject. Name the exact beat.

**4. No clear emotional engine**
Every viable concept runs on a small number of primal drivers: love,
betrayal, secrets, power, revenge, injustice-that-demands-correction. If you
can't name which one(s), reject it.

**5. Flat stakes / nothing to lose**
If the failure state is vague or inconsequential, reject. Stakes must be
concrete and escalating, not atmospheric.

### Weakness flags (don't auto-kill, but must be named and fixed before presenting)

**6. Dead trope, no twist**
Tropes are fine; a trope executed with zero angle is not. What does this
version do that the last 50 didn't?

**7. No escalation shape**
Early peaks to earn commitment, a middle that raises the stakes of "almost"
moments, a dark-middle low point, then the turn. Flag flat arcs.

**8. Cliffhanger discipline missing**
Every chapter break should end on a question, a reveal, or a reversal. Flag
every break that falls at a natural resting point.

**9. No dramatic irony / information gap**
The reader knowing something the protagonist doesn't is free tension. Flag its
total absence in a romance/revenge/betrayal story.

**10. Character legibility and honesty**
Flag any beat where it's unclear what a character wants, fears or feels, and
any line where a character voices a feeling they don't have or says something
they plainly wouldn't say.

**11. Continuity soft gaps**
Every SOFT GAP from the Continuity Audit, with a fix shape.

**12. Prose flags**
Every flag from the Prose Audit (telling, suggestive, choppy, softened, vague,
banned patterns), with the quoted line and a fix shape.

## Learning from the author's flags (STANDING RULE)

Whenever the author flags a problem in a card or draft that the gate missed
(a continuity slip, a banned pattern, a voice or craft fault), the main session
checks whether this skill already covers it. If it doesn't, the main session
proposes an update to this skill with the new check and the author's example,
so the gate catches that kind of issue on every future draft. Until the update
is saved, the main session puts the new check into every gate brief by hand.

## How to deliver the verdict

The gate agent returns this, and the main session surfaces it to the user
(condensed if long, but never with flags silently dropped):

```
VERDICT: [REJECTED / PASSED WITH FLAGS / PASSED]
Gate run by: separate agent, Opus 5.5

Continuity (state sheets checked: [characters]):
- HARD: [the line] contradicts ch[N]: "[quote]" -- [fix]
- SOFT: [the line] -- [why a reader stumbles] -- [fix]
- UNVERIFIED: [what couldn't be found] -- ask the author

Prose (drafted prose only):
- [A telling / B suggestive / C choppy / D softened / E vague / F banned
  pattern] "[quoted line]" -- [why it weakens the moment] -- [fix shape]

Auto-reject failures:
- [Checkpoint] -- [the specific beat/line] -- [why it kills a reader here]

Weakness flags:
- [Checkpoint] -- [specific issue] -- [suggested fix]

What's working:
- [...]
```

Be direct and specific: point to the actual beat, not the category. "The
reveal in chapter 12 that the villain is her brother comes out of nowhere" beats
"there's a pacing issue in the middle."

## Tone

Blunt but not dismissive. The user is trying to build something that works.
The job is to be the harshest editor they'll get before a reader is: reject
fast, explain precisely, cite the page, and always leave a path to fix it
rather than just a verdict.