# Gatekeeper vs the eight skills: clash analysis (first pass)

Written by the coordinating session on 26 Nov 2026 from three inputs in this folder and one next to it:

- `gatekeeper/SKILL.md` (the existing Claude-side `story-concept-gatekeeper` skill)
- `claude-hanami-drafting-process.pdf` / `.txt` (the author's full working process)
- `../skill-research/01` to `08` (the eight research briefs)

This is a first pass. The session building the skills should verify each point against the rubrics it actually writes, and
should treat the ownership matrix and the verdict ladder below as proposals for the author to approve, not decisions.

## 1. Conflicts and overlaps

| # | Existing rule | Collides with | Why it matters | Proposed resolution |
| --- | --- | --- | --- | --- |
| C1 | Gatekeeper weakness flag 8: "Flag every break that falls at a natural resting point." | Brief 04 section 5: "Every chapter needs pull. Not every chapter needs a cliffhanger"; a threat that turns out to be nothing costs readers' trust. Brief 07 checklist 12: chapter endings should differ in kind, none should end on a summary. The process doc says splits at beat boundaries are welcome. | Flag 8 pushes a cliffhanger onto every break, which is the sameness and fake-out pattern both briefs warn against. | Brief 04 owns chapter endings. Replace flag 8 with: does the break leave an unresolved question, decision or change; vary the kind; no fake-outs; no closing summary. |
| C2 | Process doc, call template: "No similes." | Same doc, section 13: "you reversed the blanket simile ban", i.e. figures of speech only if fresh. Gatekeeper prose family B flags "as if" as a hedge without exception; brief 07 (Orwell) says "never use a figure of speech you're used to seeing in print". | The gatekeeper keeps flagging fresh figures, and Claude keeps writing the retired rule into every call. | One rule in the per-book rulings: fresh figures allowed; "like" and "as if" flagged only when stock or hedging. |
| C3 | Same defect owned by two or three reviewers: plot armor (gatekeeper 3, brief 06 Pixar rule 19, brief 07 checklist 5); stakes and escalation (gatekeeper 4, 5, 7; briefs 06, 02); telling and named emotions (gatekeeper prose A, brief 07 Palahniuk thought verbs); stock phrasing and vagueness (gatekeeper E and F, brief 07 sections 1, 3, 5). | n/a | Duplicate flags, double cost, and different severities for the same line. | Ownership matrix in section 2. |
| C4 | Gatekeeper flag 9 flags the total absence of dramatic irony. | Brief 05 section 7, brief 02 section 2 and brief 04 item 8: irony left open too long stops being suspense and becomes waiting; cash it in front of the person it hurts. | The gatekeeper only pushes for more irony. The briefs treat stale irony as the defect. | Brief 05 owns it and flags both absence and staleness. Retire flag 9. |
| C5 | Gatekeeper prose family D flags a character "made more reasonable, apologetic or self-aware than they are" and tenderness the characters don't feel. | Briefs 01, 02 and 08: a cruel hero must pay on the page (the grovel; one true thing that costs his pride). | The gatekeeper can mark a planned, earned payoff as softening. | D yields when the beat is a recorded payoff in the arc. It flags only unearned softening. |
| C6 | Gatekeeper quality gate 1, 2 and 4 (one-line logline, hook in the opening beat, emotional engine). | These are pitch and outline checks. Briefs 06 and 08 hold premise and engine at outline level. | Run on every mid-book beat card they produce noise. | Stage-applicability matrix in section 4. |
| C7 | Gatekeeper has AUTO-REJECT triggers, weakness flags, and HARD / SOFT / UNVERIFIED. The eight briefs define no scale. | n/a | Two agents could return REJECTED and PASSED on the same text. | One shared ladder, section 3. |
| C8 | Gatekeeper says it is tuned for Goodnovel and ReelShort style markets, in static text. | Brief 08 is a dated snapshot (6 Nov 2026) with time-sensitive figures. | Static assumptions go stale silently. | Market facts live in one dated record with an expiry that the gatekeeper and brief 08 both read. |
| C9 | The gatekeeper embeds book-specific rulings: chapter examples (565, 543, 571, 573, 574), "man" is Jace's word, no frost or ice words in Southern scenes, no "put his hand on", the open-and-close-mouth pattern, no quoted past dialogue. It also hard-codes "Opus 5.5". | n/a | Method and rulings are mixed in one file, so a second book can't use it and a new ruling means editing the skill. | Split portable method (versioned) from per-book rulings (data). Model is config in `agent_prompts`, not text. |
| C10 | Process doc section 13: chapters of about 800 to 1,300 words; no dashes except cut-off dialogue. | Brief 04 quotes platform guidance of 1,000 to 2,000 words. | A skill's generic guidance must not override the author. | Precedence: author rulings, then house rules, then manuscript facts (gatekeeper), then craft skills, then market. |
| C11 | Gatekeeper runs through the Claude Code Agent tool (`model: "opus"`), file in and out, resumed with SendMessage, brief assembled by the main session. | The backend skills run server-side. | Two implementations, two verdicts, double cost, and the gate exists only in sessions that installed the skill. | Port the gatekeeper into the backend as a reviewer role. The Claude-side `SKILL.md` becomes a thin, downloadable launcher that calls the backend. |
| C12 | Process doc facts that are now out of date: section 14 says the Hanami model is unknown; the call template spells out POV and tense by hand; section 7 describes Hanami behaviour seen at temperature 0.85 with no sampler values. | Since 26 Nov: the model is `Sao10K-L3.1-70B-Hanami-x1` on Infermatic; the narration switch injects and verifies POV and tense when a book has them set; Hanami now runs at 1.3 with the preset sampler values; `generate_prose_direct` requires `bookId`. | The doc would teach stale mechanics. | Update when the doc is turned into the module. Re-check section 7 behaviours at the new settings (invented hair and eye colours still appeared in about half of test runs at every setting). |
| C13 | Process doc section 13: Claude won't write a sexual assault being carried out. | Skill 03 (heat) and the gatekeeper must still review such passages. | A reviewer that refuses or returns nothing must not read as a pass. | Reviewers critique and quote short fragments only; an empty or refused review is an error state, never a pass. |

## 2. Ownership matrix (proposed): one owner per class of issue

| Class of issue | Owner |
| --- | --- |
| Continuity: who knows what, who they've met, what they witnessed, objects, injuries, timeline, world rules, voice drift, claims vs facts | Gatekeeper (continuity audit). Keeps. |
| The author's own line standards: telling, hedging, choppy narration, unearned softening, and the banned-pattern list (as data) | Gatekeeper (prose audit). Keeps. |
| Likeliest-choice slop: stock phrasing, machine vocabulary, vague description, name-swap test, characters explaining feelings | Brief 07. Gatekeeper E and F-stock fold into it. |
| Genre promises: bond, alpha, rejection and reversal, claiming, the moon | Brief 01 |
| Arc, tension, honest separation, the black moment | Brief 02 |
| Heat scenes (only when a scene is intimate) | Brief 03 |
| Chapter endings, pull, arcs, mid-run sag | Brief 04 (retires gatekeeper flag 8) |
| Secrets, reveals, open threads, dramatic irony | Brief 05 (retires flag 9) |
| Desire, cause and effect, set-up and payoff, escalation, plot armor, cast | Brief 06 (retires flags 3, 5, 7) |
| Premise positioning, market fit | Brief 08, with gatekeeper checks 1, 2, 4 at pitch stage |

## 3. One verdict ladder (proposed)

- **BLOCK**, issued only by the merge layer and only for: a hard continuity contradiction, a prose failure at the core, or a
  violation of an author ruling.
- **FLAG**: a weakness with a fix shape. Craft skills can emit nothing stronger than this.
- **NOTE**: advisory.
- Every finding carries: owner skill, severity, chapter and short quote, why it costs a reader, fix shape. The merge layer
  de-duplicates by quoted span and class, so one line never gets three flags.
- Reviewers share one context pack (the character state sheets and chapter text, built once) instead of each re-reading the manuscript.

## 4. Stage applicability (draft; the skills session should confirm)

| Skill | Pitch | Outline | Beat card | Prose pass | Assembled chapter |
| --- | --- | --- | --- | --- | --- |
| Gatekeeper, continuity | | yes | yes | yes | yes |
| Gatekeeper, prose audit | | | | yes | yes |
| 01 genre promises | yes | yes | yes | | |
| 02 romance craft | | yes | yes | | yes |
| 03 heat | | | yes (intimate only) | yes (intimate only) | yes (intimate only) |
| 04 serial pull | | yes | yes | | yes |
| 05 secrets and reveals | | yes | yes | | yes |
| 06 fiction fundamentals | | yes | yes | | yes |
| 07 anti-slop | | yes | yes | yes | yes |
| 08 market | yes | yes | | | |

## 5. The manuscript-context skill: a manuscript-first rule

Source: `manuscript-context/`. **Author's ruling (26 Nov): it exists only to force Claude, and every subagent, to seek
context from the manuscript first, before doing anything at all.** So it is a rule that gates action. It is not a ninth
reviewer and it is not a context builder.

**Author decisions recorded 26 Nov:** yes to a real, non-fakeable approval action for the "Go" gate; yes to porting the
gatekeeper into the backend; yes to the ownership split in section 2.

| # | Finding | Evidence | Resolution |
| --- | --- | --- | --- |
| M1 | **The rule is portable; the text around it is frozen at about chapter 200.** The skill hard-codes its searches, "live threads" and a character bible from then (it says "a character in chapter 205" and "200+ chapters"): `Torin alive Bram face council deception`, `recording crystal Irina consequence`, four fixed Mina searches, bios of Mina, Sera, Fenris, Aldric and Irina. | Run against the live manuscript on 26 Nov: the top 8 matches for those two searches are in chapters 63 to 314 (mostly 162 to 261) and none is later, while the book is now at about chapter 595. I did not check whether those threads were resolved. | Keep the rule. Do not copy the fixed searches or bios. What an agent looks up comes from the work in front of it (the chapter, beat or card and its cast). |
| M2 | **It targets claude.ai Project knowledge, not the backend.** `reading-the-manuscript.md`: "The project knowledge search returns chunks of the manuscript". | The backend already has `search_manuscript` (8 ranked results, no cutoff), `get_manuscript_chapter`, Codex tools and notes. | Point the rule at the backend's retrieval. |
| M3 | **Same instinct as the gatekeeper's continuity audit, at a different moment.** The rule makes the drafter look first. The gatekeeper audits afterward. | Compare the skill's `character-state.md` with the gatekeeper's Continuity Audit step 3. | Keep them separate. The gatekeeper does not trust the drafter's lookups: it re-checks against the raw text, so the work never grades itself. |
| M4 | **Out of scope under the author's ruling:** `context-to-prose.md` (surface vs engine, the echo question, "what would be lost if this chapter were removed") and the character bible in `reading-the-manuscript.md`. | These go beyond "seek context first". | Leave the files in the folder as reference. Do not build from them. |
| M5 | **Keep its core line verbatim:** "The manuscript is always right. Memory is always suspect." | Consistent with the gatekeeper. | Make it the precedence rule: author rulings first, then manuscript facts, then everything else. |

**How the backend should force it (proposal for the skills session to design and verify):**
1. Record every manuscript read (`search_manuscript`, `get_manuscript_chapter`, Codex reads) per session, book and chapter.
2. Action tools (`generate_prose_direct`, `start_scene_draft_session`, `save_manuscript_scene`, planning generate, every reviewer run)
   refuse until a read is on record for this book and the target chapter's surroundings, and the refusal says what to look up.
3. Every subagent run (gatekeeper and the eight reviewers) opens with the lookups as its mandatory first step, and a verdict is
   invalid unless each claim cites a chapter and a short quote from the manuscript.
4. Honest limit: the backend can prove an agent asked for the manuscript, not that it read or used it. The gatekeeper's
   independent verification is what covers that.

Updated ownership row: **manuscript-first rule**: applies to every agent and is enforced by the backend gate above. It has no
reviewer of its own.
