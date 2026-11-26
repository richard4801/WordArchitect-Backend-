# Backend skills: design note (draft for decision)

Status: decisions taken 2026-11-26 (below); skill 07 (anti-slop) built end to end as the first slice, the other seven not yet built.

## What a "skill" is here

A skill is a server-side reviewer: one rubric (distilled from one brief in this
folder), one independent Claude call that judges a piece of text against it, and
one stored, structured verdict. It is not a Claude Code `SKILL.md`, and it is not
an instruction to the Claude session doing the drafting. The drafting Claude
never grades its own work. It can only *request* a review, and the backend
decides what context the reviewer sees and records what it said.

## Skill vs. the alternatives

| Option | Verdict | Evidence |
| --- | --- | --- |
| A. Put the rubrics in Hanami's drafting prompt | Reject as the enforcement mechanism | Eight distilled rubrics are roughly 6-10k tokens, more than the whole 6,000-token context budget. LEARNINGS 2026-11-26: a rule stated once in the prompt held in 0 of 10 runs where it mattered most. Hanami has no judgment to apply a rubric with. |
| B. Put the rubrics in the MCP Claude's instructions (tool descriptions, a Claude Code skill) | Reject | That is the "nudge" LEARNINGS 2026-10-20 shows is not enforcement, and it makes the author its own grader. The user ruled it out ("not in claude environment"). |
| C. One combined reviewer with all eight rubrics | Reject, keep as fallback | Cheaper by about one shared-context read per skill, but: one refusal (likely, given the content) silently kills all eight verdicts; eight rubrics in one prompt dilute attention; model and effort can't differ per skill; the writer can't edit or switch off one skill without touching the rest. |
| D. One reviewer agent per skill, run only where it applies | **Recommend** | Same pattern the Planning Engine already runs in production (3 independent critics). A refusal is isolated to one skill and reported. Each rubric is editable and versioned on its own. Prompt caching makes the shared context almost free after the first call (see Cost). |

D is "always better as a skill" only with **applicability gating**: a skill that
doesn't apply to this stage or this text is not called at all (verdict
`not_applicable`, cost zero). Running all eight on every paragraph would be the
wrong design.

## Architecture

```
Claude (MCP) ──run_skill_review──▶ skillReview.ts
                                    │ 1. decide which skills apply (stage table + cheap gates)
                                    │ 2. gather context SERVER-SIDE (Claude can't curate it)
                                    │ 3. one Anthropic call per skill, in parallel
                                    │ 4. validate verdict JSON; refusal/empty/missing criteria → reviewer_error
                                    ▼
                              skill_reviews table ──▶ returned in the tool result
save_manuscript_scene / approve_planning_unit ──▶ check a review exists for THIS exact text (hash)
```

- **Rubric storage**: in the existing `agent_prompts` table, one role per skill
  (`skill_anti_slop`, `skill_romance_craft`, ...), stage `prose` or a planning
  stage, with `all` as fallback. That gives versioning, writer editing, the
  Prompt Editor UI, `list_agent_prompts` / `update_agent_prompt` over MCP, and
  per-skill `model` / `effort`, all for free. Seeded from a script, per book
  (`clone` copies them to new books). Each rubric has numbered criteria
  (`AS1`, `AS2`, ...) so a verdict can be checked for completeness.
- **What stays in code**: which stages a skill applies to, its context recipe,
  and its applicability gate. These are fetch logic, not prose, and a writer
  editing a prompt shouldn't be able to break them.
- **Context recipe (server-fetched)**:
  - Prose: the text under review; Codex entries whose names/aliases appear in
    it (the Layer 1 matcher); the trailing ~1,500 words of the previous chapter
    (from `manuscript_chapters`); the chapter's own beats from `chapter_beats`
    if any; the book's narration setting. Skill 04 also gets the previous
    chapter's ending; skill 05 also gets the continuity ledger when a planning
    run exists.
  - Planning: what the critics already get (`BOOK_VISION`, `PARENT_ARTIFACT`,
    `CONTINUITY_LEDGER`, the artifact), reusing `planningEngine.ts`.
- **Deterministic pre-pass for skill 07**: the phrase list from the brief
  (flickered, voice barely above a whisper, testament, tapestry, "not X but Y",
  ...) is a free regex scan. It runs on every `generate_prose_direct` result as
  a note, and its hits are fed to the LLM reviewer as evidence.

## Verdict format

```json
{
  "skill": "anti_slop",
  "verdict": "pass | revise | fail",
  "criteria": [
    { "id": "AS3", "result": "met | not_met | n/a",
      "evidence": "short quote, max ~20 words", "note": "one sentence" }
  ],
  "mustFix": [ { "criterionId": "AS3", "problem": "...", "fix": "..." } ],
  "summary": "two sentences"
}
```

The backend, not the model, decides the stored status:
- `pass` / `revise` / `fail`: valid JSON, every criterion id answered.
- `reviewer_error`: refusal (`stop_reason: "refusal"`), empty output, invalid
  JSON after one corrective retry, or criteria missing. **Never treated as a
  pass**; reported by name.
- `not_applicable`: the gate skipped it (with the reason).

Reviewer system prompts frame the job as professional manuscript editing of
adult fiction: judge craft, quote short fragments only, never write explicit
prose or rewrite the passage.

## How the backend makes Claude follow it

1. `run_skill_review` (new MCP tool, plus `POST /api/v1/skill-reviews`). Input
   is `{ bookId, userId, text, target: "prose" | "planning", chapterNumber?,
   sessionId?, runId? }`. It returns verdicts and a `reviewId`.
2. **Gate on acceptance, the two moments that make text canon**:
   - `save_manuscript_scene` gets a **required** `skillReviewId`. The backend
     checks that the review exists, belongs to this book, and was run on this
     exact text (SHA-256 of normalized text). If not, the save is refused with
     a message saying what to call.
   - `approve_planning_unit` checks the same for the run's current artifact.
     Planning skills are folded into `critique_planning_unit`, so the normal
     flow produces the review without an extra step.
3. **What a failing verdict does**: see decision (a) below.
4. **Honest reporting**: tool results list each skill as passed, failed (with
   its must-fix items), reviewer error, or skipped. A save that went through
   with unresolved fails says so. Nothing says "reviewed" unless it was.

What this cannot do: it can't stop a Claude session from writing to the
database by some other route, or from passing a review of text A and then
saving text B. The hash check closes that one.

## Where each skill runs (proposal)

| Skill | Planning stages | Prose | Gate |
| --- | --- | --- | --- |
| 01 werewolf genre promises | act_summary, part_outline, part_beats | chapter | always |
| 02 romance craft | act_summary, part_outline, part_beats | chapter | both leads on the page (Codex match) |
| 03 erotic/high heat | part_beats (beat flagged intimate) | chapter/scene | only when the text is intimate: cheap Haiku classifier |
| 04 serial plotting | part_outline, part_beats | chapter | full chapter only, not fragments |
| 05 secrets & reveals | act_summary, part_outline, part_beats | chapter | always |
| 06 fiction fundamentals | every planning stage | chapter | always |
| 07 anti-slop | every planning stage | chapter, scene, and draft fragments | always (regex pass is free) |
| 08 current market | stage_1_summary, act_summary | none | always, with a staleness warning once the brief (Nov 2026) is >90 days old |

Prose review runs on a whole scene or chapter, not on every paragraph-level
Hanami pass in a draft session. A scene draft session reviews its final draft
in `finish_scene_draft_session`.

## Cost (estimate, to be measured in the slice)

Sonnet 5.5 at effort `medium`: about 11k input tokens per skill (about 9k of it
shared context, cached after the first skill at $0.10/MTok) and about 3k
output and thinking tokens. **Roughly $0.04-0.06 per skill, so $0.25-0.35 to
review one chapter with the 5-6 skills that usually apply.** The regex pre-pass
and the Haiku intimacy gate cost under $0.001. A planning unit costs more
because `BOOK_CONTEXT` is large: about $0.10-0.20 per skill. On Opus 5.5 every
figure roughly doubles.

## Decisions (writer, 2026-11-26)

a. **Reviewing is mandatory; passing is not.** A save over an unpassed review
   requires `writerOverride` with the writer's reason, stored on the review.
b. **The stage table above**, as proposed.
c. **Opus 5.5 for reviewers, $1.00 cap per review.**
d. **`skill_reviews` table + MCP + REST.** No frontend work in this pass.

## Slice results (skill 07 on three real chapters)

Ch 12, 300 and 590 of the production book, read-only, each with the end of the
previous chapter as context. The free regex scan found 1 hit in total. The
reviewer verdicts came from stand-in Opus agents given the exact prompt the
backend builds (the container has no backend Anthropic key), then went through
the real validation code: Ch 300 passed; Ch 12 and Ch 590 each needed revision
for one major (AS4, a summary ending or restated helplessness), with minors
noted. None refused, including Ch 590 (sexual-violence threat scene). Prompt
size: about 5k tokens per skill per chapter.
