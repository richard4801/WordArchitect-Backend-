# The drafting system in the backend: design note v2

Written 26 Nov 2026. Supersedes the scope of `docs/skill-research/DESIGN.md` (which still holds for the
reviewer mechanics and the decisions already taken there). Sources: `claude-hanami-drafting-process.txt`,
`gatekeeper/SKILL.md`, `manuscript-context/`, `GATEKEEPER_CLASH_ANALYSIS.md`, the eight briefs. None of those
files is edited; everything below is built alongside them.

Already approved by the author: a real, non-fakeable "Go" gate; porting the gatekeeper into the backend; the
ownership split, the single verdict ladder and the stage table in the clash analysis (sections 2 to 4), to be
verified as rubrics are written.

## 0. The shape, in one picture

```
            ┌────────────────── process module (one source, versioned) ─────────────────┐
            │ renders: MCP `instructions` at connect · MCP prompts · get_drafting_process │
            │          REST /process (human doc) · REST /skills/:name/download (SKILL.md)  │
            └──────────────────────────────────────────────────────────────────────────────┘
chapter workflow state (server-side, per book+chapter): manuscript read ▸ card ▸ card review ▸ GO ▸ drafting ▸ prose review ▸ saved
                     │              │              │          │           │                 │
         manuscript_reads  card stored    gatekeeper  recorded Go  generate_prose   gatekeeper + 8 skills
          (recorded by the                + skills on   (quoted in   _direct checks    → save_manuscript_scene
           read tools)                      the card      chat)       the approval        checks the review
```

Each arrow is a check the backend makes, not a reminder. A tool called out of order fails and its error names the
step that's missing. A new session reads the workflow state and resumes where the last one stopped.

## 1. The manuscript-first gate (manuscript-context, as the author ruled it)

**The author's ruling (26 Nov):** manuscript-context "exists to only force Claude or any subagents to always seek
context first from the Manuscript before doing anything at all." It is a gate on action, not a reviewer and not a
context builder. Its own line is the precedence rule: **"The manuscript is always right. Memory is always suspect."**
The frozen ~ch200 searches and bios, `context-to-prose.md` and the character bible are out of scope (clash M1, M4).

**How the backend forces it.**
1. **Every manuscript read is recorded** in a `manuscript_reads` table: book, tool (`search_manuscript`,
   `get_manuscript_chapter`, `get_codex_entry`, `list_codex_entries`), the chapter read or the query, the MCP session
   id (for the record only), time. The read tools write this themselves; nothing for Claude to remember.
2. **Action tools refuse until a sufficient read is on record** for this book and target chapter, and the refusal names
   the exact lookup still missing ("Read chapter 593 in full with get_manuscript_chapter first"). Action tools:
   `generate_prose_direct`, `start_scene_draft_session`, `save_manuscript_scene`, `request_reviews`,
   `generate_planning_unit`. `generate_prose_direct` gains a required `chapterNumber` for this (it gains `approvalId`
   for Go at the same time, section 4, so one connector re-add covers both).
3. **Scope is book + chapter + time, not the MCP session.** Session ids are wiped by every deploy, and subagents may not
   share their parent's session, so a session-scoped rule would refuse legitimate work after any restart. A read
   counts if it was made for this book within the window (decision below).
4. **Subagents**: every reviewer brief opens with the lookups as its mandatory first step (built: section 4b's preamble).
   The verdict check already rejects any quote not found verbatim in the reviewed text. For the gatekeeper, claims
   about the past must cite a chapter and a short quote, and the backend checks each quote against that chapter's text.
5. **Answering questions in chat** is not a tool call, so the backend can't gate it. The rule reaches it through the
   MCP connect instructions and the process module (section 2), and through the gatekeeper catching what slips.

**What counts as a sufficient read (the author's clarification, 26 Nov):** not a fixed set of chapters. "An agent or
Claude itself is not running an isolated search on a chapter, or few chapters. It would query the system on anything
mentioned for the context it needs." So the gate is driven by the work itself:
- At each action, the backend scans the text being acted on (the beat and compiled context sent to Hanami, the scene
  being saved, the text sent for review, the planning directive) for **every proper name**: capitalised words and
  phrases that don't merely start a sentence, plus Codex names and aliases. The Codex is only a shortcut for aliases;
  it is not the list of what counts. **"The manuscript is always the source of truth"** (the author, 26 Nov): a name
  missing from the Codex is looked up in the manuscript, not skipped.
- Each name needs a recent manuscript query about it on record for this book: a `search_manuscript` whose query
  mentions it, or a read of its Codex entry. Window: 6 hours.
- Missing names refuse the action, listed by name: "Not yet looked up in the manuscript: Amara, Kane. Search for each,
  then retry."
- A name the manuscript has never mentioned (a full-text check on the manuscript) is reported, not silently accepted:
  "'Samuel' appears nowhere in the manuscript: invented, or new? Confirm with the author." This catches the names
  Hanami invents (process doc section 7).
- Reviewer subagents: every claim about the story must cite a chapter and an exact quote, checked by the backend.

**Limit:** an unnamed object or event ("the bar", "the feast") can't be detected by a name scan. The gatekeeper
subagent covers those: it searches the manuscript itself and must cite chapter and quote for every claim.

**Honest limit:** the backend can prove an agent *asked* the manuscript, not that it read or used the answer. The
gatekeeper's independent re-check against the raw text is what covers that.

**The small context block in each reviewer brief** (pinned notes, Codex entries named in the text, the end of the
previous chapter, beats, narration) stays: it's evidence handed to the reviewer, retrieval only, with no model call.
It is not what enforces manuscript-first, and reviewers are still told to search for themselves.

## 2. The process module (the PDF as a real structure)

**One source of truth** (`src/process/`): the 12 steps, the call-building rules, the correction kinds, the craft
rules, the saving rules, each step with an id, its rule, its source (author ruling and date), and the tool calls that
satisfy it. From it the backend renders:

- **MCP `instructions` at connect**: a short version of the 12 steps. Every connected Claude sees it with no skill installed.
- **MCP prompt `chapter_workflow`** and tool **`get_drafting_process`**: the full module, current version.
- **`GET /api/v1/process`**: the human document (markdown), for the author and the app.
- **`GET /api/v1/skills` and `GET /api/v1/skills/:name/download`**: the Claude-side `SKILL.md` files (the process
  skill, a thin gatekeeper launcher, manuscript-context re-pointed at the backend), generated from the same source,
  so a session or account without them downloads them.
- **Tool descriptions and tool results that name the next step.** Every workflow tool result ends with
  "Next required step: …".

**Book-specific rulings become data** (clash C9): a `book_rulings` table (house rules, banned patterns, voice
rulings, each with source chapter and date): "no dashes except cut-off dialogue", "man is Jace's word", "no
frost/ice words in Southern scenes", "never quote past dialogue", "put his hand on is banned", "fresh figures only".
They are injected into every reviewer and into the call-builder checks. **Precedence** (clash M6/C10): author
rulings, then manuscript facts, then house rules, then craft skills, then market.

**Facts updated from the PDF** (clash C12): the Hanami model is `Sao10K-L3.1-70B-Hanami-x1`; POV and tense are
injected and verified by the narration switch *when the book has them set* (this book currently doesn't, see
LEARNINGS 2026-11-26); temperature 1.3 with the preset sampler values; `generate_prose_direct` requires `bookId`;
the "No similes" template line is replaced by "fresh figures only".

## 3. Enforcement: chapter workflow state

`chapter_workflows` (one row per book + chapter + POV pass): step statuses, the read record, card, card
review, approval, prose review and save. Gates:

| Tool | Refuses unless |
| --- | --- |
| `submit_card` (new) | a sufficient manuscript read is on record for this chapter (section 1) |
| `request_prompt_approval` (new) | the card has a review with no unresolved BLOCK |
| `generate_prose_direct` | the exact prompt (hash of sceneBeat + compiledContext) is covered by a writer approval (section 4) |
| `save_manuscript_scene` | a prose review of the exact text exists with no unresolved BLOCK (or a writer override); the chapter slot is empty |

Narrow reruns and comment-driven rewrites are covered by the approval scope chosen in decision 1 below.

## 4. The "Go" gate: a recorded approval, asked for in chat (decided 26 Nov)

The author's ruling: Go stays a chat rule ("Claude has to obey and just ask first"); no app button. The backend makes
skipping it visible instead of silent:

- Before the first Hanami call for a card, Claude shows the prompts and asks. When the author says Go, Claude calls
  `record_prompt_approval` with `{ chapterNumber, beats: [the prompts], writerApproval: "<the author's words, quoted>" }`.
  The backend stores the prompts (hashed) with the quote and time.
- `generate_prose_direct` requires `approvalId`. The call is refused if the approval doesn't exist, belongs to another
  chapter, or the beat being sent isn't one of the approved beats. Narrow reruns of an approved beat are covered
  (decision: card beats + reruns); a new beat or a changed fact needs a new Go.
- Every approval and every call made under it is listed by `get_chapter_workflow`, so the author can see what was
  approved, when, in what words, and what was sent.

What this can't do, stated plainly: the backend can't prove the author said the words Claude quotes. It turns "Claude
forgot to ask" into a refused call, and "Claude invented a Go" into a stored, quoted claim the author can check.

## 4b. Who runs the reviewers: subagents in the author's chat (decided 26 Nov)

The eight skills and the gatekeeper are run by **subagents in the author's Claude chat**, not by the backend's own
Anthropic key. The backend owns everything around the run:

1. The drafting Claude calls `request_reviews` with the text and where it sits. The backend stores the text (hashed),
   decides which skills apply (stage table), builds one **brief** per skill (rubric, criteria, output contract, context
   pack, the text) and returns a short launch prompt per skill: "You are the <skill> reviewer. Call
   `get_review_brief(<briefId>)`, judge, call `submit_review_verdict`."
2. The drafting Claude spawns one subagent per launch prompt (Opus). Each subagent fetches its own brief by id (the
   author confirmed subagents can call the connector), so the drafting Claude never sees or edits what the reviewer
   is given.
3. The subagent submits its verdict JSON. The backend validates it: every criterion answered, severity on the ladder,
   and **every evidence quote must appear verbatim in the reviewed text** (or in the cited chapter). A fabricated or
   paraphrased quote is rejected and the subagent is told to resubmit. A refusal is submitted as such and recorded as
   reviewer_error, never a pass.
4. `save_manuscript_scene` checks that every applicable skill has a submitted verdict for this exact text, and that
   no BLOCK finding is open (or the author overrode it).

The limit: a drafting Claude determined to cheat could submit a verdict itself. The quote check, the stored record of
who asked and when, and the brief being built server-side make that hard and visible, not impossible.

## 5. The gatekeeper, ported

A backend-defined reviewer (`gatekeeper`), run as a chat subagent like the other skills:
- **Continuity audit**: a chat subagent (section 4b) that starts from the context block in its brief and runs its own
  `search_manuscript` / `get_manuscript_chapter` calls through the connector. Keeps every rule: list every character, object and place; who they know;
  what they witnessed; sourced claims ("I hear…"); "a character's claim is not a fact"; three phrasings before
  UNVERIFIED; cite chapter and quote. HARD / SOFT / UNVERIFIED.
- **Prose audit**: families A to F, with the book-specific items moved to `book_rulings` and stock/vague (E, F-stock)
  folded into skill 07 per the ownership matrix.
- **Retired or moved** per the clash analysis: flag 8 → brief 04 (pull, varied, no fake-outs); flag 9 → brief 05
  (irony absent *or* stale); flags 3, 5, 7 → brief 06; quality-gate checks 1, 2 and 4 run only at pitch stage; flag D
  yields to a payoff recorded in the arc.
- Model: Opus 5.5, as the SKILL.md requires; the launch prompt says so, and the verdict records the model the subagent reports.
- The Claude-side `story-concept-gatekeeper` becomes a thin launcher: "call `run_gatekeeper`; show the verdict; fix;
  re-run on the changed parts".

## 6. One verdict ladder across everything (approved; how it maps)

| Level | Who can issue it | Effect |
| --- | --- | --- |
| BLOCK | the merge layer only: a gatekeeper HARD contradiction, a core prose failure (gate 0b), or a `book_rulings` violation | stops the next step until fixed or the writer overrides |
| FLAG | any reviewer, including all eight craft skills | listed in the tool result and stored; never blocks |
| NOTE | any reviewer | advisory |

The merge layer de-duplicates by quoted span and issue class, so one line never collects three flags.

**This changes what was built in the anti-slop slice**: today a "major" anti-slop finding blocks a save unless the
writer overrides. Under the ladder it would be a FLAG and wouldn't block. That is decision 3 below.

## 7. Stage table (approved draft; confirmed against what's built)

As in clash section 4, with two notes: skill 07 already runs on prose fragments, scenes and chapters, and on every
Planning Engine stage; the gatekeeper runs on outline, card, prose pass and assembled chapter, and its prose audit only
on prose.

## 8. Build order and slice

1. **Slice: the manuscript-first gate plus the gatekeeper continuity audit**, end to end, validated against a regression set:
   take saved chapters, put back errors the gatekeeper is on record as catching (ch565 Kane asking "Is Mina happy
   about it?"; ch543 Jace reacting to a line said before he walked in; ch571 "I hear you came North"; the ch573 pregnancy
   taken as real; the 594 card's "blockers"), and measure what it catches, plus false alarms on the clean originals.
   Same method that validated the narration switch.
2. The process module, workflow state and the Go gate.
3. The other seven craft skills on the shared pack, then the merge layer.

## 9. Cost

Reviewers and the gatekeeper run as subagents in the author's chat, so they use the author's Claude plan, not the
backend's API key; the backend's own cost is database reads and one embedding call per manuscript search. The
$1.00-per-review cap and the backend reviewer path built in the first slice stay in the code but are unused unless
reviews are ever moved server-side again.

## Decisions (author, 26 Nov)

1. Go-gate scope: **card beats + reruns**.
2. Where Go is pressed: **in chat**; the backend records the quoted approval (section 4).
3. Anti-slop vs the ladder: **adopt the ladder**; craft findings FLAG, only BLOCKs stop a save.
4. Other Claude-side skills (chapter-hook, prose-style, etc.): **out of scope**. Manuscript-context is the standing
   "search the manuscript first, ask the author only when the page doesn't settle it" rule for every agent and every
   question, delivered in the MCP connect instructions and every brief.
5. Reviewers run as **chat subagents** that fetch their own briefs and submit their own verdicts (section 4b).
