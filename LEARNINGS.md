# Learnings Log

Append-only. This is not architecture documentation (that's `CLAUDE.md`) —
it's the operational record of mistakes, surprises, and non-obvious truths
discovered the hard way while working on this project, so the same mistake
doesn't get made twice by a future session (human or Claude) that has no
memory of this one.

**Rules for this file:**
- Read it in full before starting real work in this repo.
- When you hit something non-obvious the hard way — a wrong assumption, a
  process gotcha, a surprising failure mode, anything that cost real time
  to figure out — add a new entry before ending your turn. Don't wait to be
  asked.
- Append only. Never edit or delete a past entry, even if a later entry
  supersedes it — if something changes, add a new entry that says so and
  references the old one. The history of what used to be true is part of
  the value here.
- One entry = one concrete lesson with a dated heading, what happened, and
  the actionable rule going forward. Not a changelog of features shipped —
  that's what commit messages and CLAUDE.md are for.

---

## 2026-09-30 — A migration file on the branch is not a migration that ran

Pushing `supabase/migrations/NNN_*.sql` to the branch only ships the SQL
text — nothing in this project's deploy pipeline (Render) applies it
automatically. There is no `supabase db push`, no CI step, nothing in
`package.json`. Confirmed live: `book_links` (migration 030) was merged
and deployed as application code, but the table genuinely did not exist in
production until someone manually ran the migration in the Supabase SQL
Editor — the API was 502ing the whole time with no clue from the code
itself that this was the cause.

**Rule:** after writing a migration, always say so explicitly and give the
exact SQL to paste into the Supabase SQL Editor — don't assume "pushed to
the branch" means "applied." If a new feature touching a new table/column
isn't working in production and the code looks right, check whether the
migration actually ran before debugging anything else.

## 2026-10-01 — A deployed MCP tool schema change needs deploy *and* reconnect

Editing `src/mcp/tools.ts` and deploying to Render changes what the
*server* will return from `tools/list` on a brand-new session — but an
already-connected MCP client (Claude Desktop, claude.ai custom connector,
this session's own WordArchitect connector) keeps using whatever tool
schema it cached from its last `initialize` call. A soft "disconnect/
reconnect" toggle in some clients doesn't reliably force a real new
handshake — it can resume cached connector metadata instead.

**Rule:** after a tool-schema change ships, verify server-side correctness
independently of any client (a raw `curl` `initialize` + `tools/list`
call, or re-loading the tool via this session's own `ToolSearch`) before
concluding the deploy didn't work. If the server is confirmed correct but
a client still shows the old schema, the fix is a *full remove-and-re-add*
of that connector, not just a toggle.

## 2026-10-01 — A 401 from an upstream LLM provider doesn't always mean a bad key

Infermatic (the Hanami/Llama 3.1 provider) returned
`"Invalid proxy server token passed... Unable to find token in cache or
LiteLLM_VerificationTokenTable"` on a key that had worked minutes earlier,
then started working again intermittently with the *same* key. This
pattern — a previously-valid credential rejected, then accepted again,
with no change on our end — is the signature of flapping/degraded
infrastructure on the provider's side, not a wrong or expired key.
Confirmed directly: Infermatic's own `/status` page showed 13 of 16
models offline at the time, including Hanami itself.

**Rule:** before concluding an API key is bad, check whether the *same*
key fails inconsistently (strong signal of a provider-side outage) and
check the provider's own status page/dashboard if one exists. Regenerating
keys repeatedly in response to a flapping outage wastes time and produces
a false "fixed it" signal when the real cause (the outage) resolves on its
own.

## 2026-10-01 — A breaking API change needs frontend instructions in the same turn, not after

Shipping a change that alters a documented request/response shape (e.g.
`GET /banned-terms` moving from `?bookId=` to `?userId=`) with no
contract-enforcement between this backend and its frontend means the
frontend silently breaks the moment it deploys, with no compiler or test
to catch it. It surfaced as a generic "Couldn't load banned words" error
with no obvious link back to the backend change that caused it.

**Rule:** any time a change alters an existing endpoint's request shape,
response shape, or scoping semantics (not just adds something new), give
exact before/after frontend instructions as part of the same response
that ships the backend change — don't wait to be asked separately.

## 2026-10-01 — Commit attribution footer goes in the first commit, not a fixup

Wrote and pushed a real commit without the required
`Co-Authored-By`/`Claude-Session` footer from this session's system
instructions, then had to `git commit --amend` + `git push --force-with-lease`
to fix it — avoidable rework, and force-pushing (even to a branch only
this session uses) is exactly the kind of action that should be rare, not
routine.

**Rule:** check the active session's attribution requirements *before*
writing a commit message, not after pushing. Build the full commit message
— including the footer — in one pass.

## 2026-09-29 — An unexpectedly empty local git checkout is not data loss

The local working tree reset to a completely empty repo (no files, no
commits, bare `master` branch) mid-session, for reasons unrelated to any
command this session ran — almost certainly a container/session artifact.
The instinct to panic or start re-creating files from memory would have
been wrong and dangerous.

**Rule:** if the local checkout looks wrong/empty/corrupted, `git fetch`
the known remote branch *first* and confirm whether the history is intact
there before assuming anything was lost. If it is intact remotely, restore
with `git checkout -B <branch> origin/<branch>` — don't reconstruct
anything by hand, and don't touch anything destructively until the fetch
confirms what's actually missing versus what's just a local artifact.

## 2026-10-07 — "Learning record" was ambiguous and I built the wrong scope first

Asked to add a mechanism so "Claude always documents a record of everything
it learns... so a mistake isn't repeated," I built exactly that — but
scoped to engineering/deploy knowledge (this very file), since that was
the kind of lesson most present in the conversation at the time. The
actual ask was about craft/collaboration knowledge: what's learned working
with Hanami as a creative collaborator, and with the writer themselves —
a completely different scope, audience, and (it turned out) a different
storage mechanism entirely (a live DB table writers' real sessions can
grow, `collaboration_learnings`, not a static repo file only a dev session
touches). Caught only because the user corrected it after the fact, not
because anything about the request itself should have been ambiguous in
hindsight — "learning record" undersold how differently "engineering
lessons" and "creative-collaboration lessons" needed to be built.

**Rule:** when a request names a general capability ("a log," "a learning
record," "a memory system") without naming its subject matter, don't
default to the scope most recently active in the conversation — ask which
domain it's actually for before designing the storage/data model, since
"where does this live and who writes to it" depends entirely on the
answer and is expensive to redo.

## 2026-10-20 — An optional MCP parameter gating a safety guarantee is a silent-failure trap

`generate_prose_direct`'s `userId` parameter was optional from the start,
with its tool description nudging Claude to "pass it whenever you know
it." Two real guarantees were gated on it: Ghost Editor banned-term
enforcement, and (once added) Writing Voice injection. Omitting `userId`
didn't error — it just quietly skipped both, with the call returning
normal-looking prose either way. The writer — who drafts almost
exclusively through an MCP-connected Claude session, not `/generate-prose`
— reported banned terms reaching their manuscript "for a while," which is
exactly what this produces: no error, no warning, just a feature that
silently wasn't running, for an unknown stretch of real drafting sessions,
because whichever live Claude session was calling the tool didn't happen
to pass `userId` on those calls. A prompt-level nudge ("pass this when you
know it") is not a substitute for a hard requirement when the cost of
skipping it is a safety/consistency guarantee quietly not holding — a
model's per-call judgment is not a reliable enforcement mechanism for
something the system is supposed to promise unconditionally.

Fixed by making `userId` a required parameter (not optional) on
`generate_prose_direct`, so the tool call itself fails loudly if it's
missing rather than silently degrading. Also fixed, found during the same
pass: the MCP response text after a banned-term correction said
"automatically rewritten to remove banned term(s)" even when a paragraph
still contained the term after exhausting all 3 regeneration attempts
(`corrections[i].resolved === false`) — the test UI already surfaced
`resolved` honestly in its report table, but the MCP text summary didn't
check it before claiming success.

**Rule:** if a tool parameter gates a guarantee the system is supposed to
provide unconditionally (not a nice-to-have), don't make it optional and
rely on a description nudging the caller to remember it — make it
required, so a missing value is a hard, visible failure instead of a
silent one. And when summarizing a corrective/retry loop's outcome in any
user- or Claude-facing text, always branch on whether it actually
succeeded — a correction attempt that exhausted its retries without
resolving the issue is not the same outcome as one that resolved it, and
both should never be described with the same success-sounding sentence.

## 2026-11-26 — Infermatic's UI sampler settings do not apply to our API calls, and `.env.example` has a stale base URL

Tested directly against the real Hanami model (`Sao10K-L3.1-70B-Hanami-x1`).
Findings, all from live calls rather than assumption:

- **`temperature` in the request body is honored.** Five calls at 0 returned
  identical text; five at 1.5 returned five completely different outputs that
  degraded into word salad and mixed-language/code fragments. So a value set
  in Infermatic's own dashboard/playground does not override what
  `src/services/llm.ts` sends (0.85).
- **`min_p`/`top_p`/`top_k`/`repetition_penalty` are NOT sent by us** (the
  request body is only `model`, `temperature`, `stream`, `messages`), and the
  API's defaults when they are omitted are far looser than the values shown in
  Infermatic's UI (Min P 0.02, Top P 0.95, Top K 40, Rep Penalty 1.05): at
  temperature 1.5, omitting them gave word salad every time, while sending
  those four values explicitly gave coherent prose every time. The UI sliders
  are not a statement of what our calls use.
- **Temperature 0 is not strictly deterministic across time.** Five calls in
  one batch were identical, but the same prompt minutes later gave a different
  text. Don't use an exact-match comparison at temperature 0 to prove two
  request shapes are equivalent; it can't distinguish a real difference from
  server-side nondeterminism.
- **The working endpoint is `https://api.totalgpt.ai/v1`.** `.env.example`
  says `https://api.infermatic.ai/v1`, which returned 401 for the key that
  worked on totalgpt.ai. Check this before debugging a "bad key."
- **The key is rate limited:** 1 parallel request and 12 requests/minute.
  Firing parallel calls produces 429s that look like failures; pace them.

**Rule:** don't assume a sampler setting visible in a provider's UI is applied
to API calls, and don't assume an omitted parameter means "same as the UI."
Verify with a high-temperature comparison, where truncation settings actually
change the output.

## 2026-11-26 — Tense and POV fail systematically when the prompt has no prose to copy; a prompt line is not a switch

Tested on a real chapter-opening call: with only the facts and no previous
prose in the prompt, none of 10 runs held "first person, past tense" (nearly
all came out third person, present tense). The same call with the preceding
paragraphs added to the context held the voice in 9 of 9. So a rule
stated once in the prompt is not reliable exactly where it matters most (the
first call of a chapter, where there is nothing to imitate), and putting the
same content into a Python-script-style prompt did not fix it (tense slipped in
2 of 8 runs where the plain format had 0 of 8). Fixed by building the narration
switch (see CLAUDE.md, "Narration Switch"): a book-level setting the backend
injects every time and then verifies, with paragraph-level rewrite, instead of
relying on the prompt.

Related gotchas found while doing it:
- **Node's built-in `fetch` does not use the sandbox's credential proxy by
  default.** `curl` honors `HTTPS_PROXY` and the proxy injects the Infermatic
  key into a request that has NO `Authorization` header; Node's `fetch` goes
  direct, so a live test of backend code gets "No api key passed in". Run such
  tests with `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`
  and drop the Authorization header (the proxy will not overwrite one you send;
  a dummy key reaches Infermatic as a dummy key).
- **A regex tense detector needs a labelled corpus before it is trusted.** The
  first version false-flagged "where would they start?" (a subject after a
  modal) and a 198-word text with no "I"; both were found only by running it
  over ~100 saved outputs whose correct answer was already known. Keep saved
  generations around as a regression set whenever a heuristic checks them.
- **Counting a heuristic's hits by eye is not validation.** One output I had
  labelled "wrong" was actually fine and one I had labelled "fine" had no
  narrator at all; label first from the text, then measure.

## 2026-11-26 — A shipped switch is not an active switch: the main book's pov/tense are null in production

While testing skill reviews against real chapters, a plain read of
`GET /api/v1/books/a1b2c3d4-2222-4a2b-9c3d-000000000002` showed `pov: null`
and `tense: null`. The narration switch (entry above, CLAUDE.md "Narration
Switch") is only ON when both are set, so for the writer's main book it has
been injecting and checking nothing since it shipped, with no error, because
"off" is the documented, silent state for a book without a setting. The code
was right; the data never turned it on.

**Rule:** after shipping a feature gated on stored data (a book setting, a
seeded prompt row, a profile), read the real row for the real book and confirm
the gate is actually open before telling anyone the feature is working. For
the same reason, skill reviews ship with built-in rubrics instead of requiring
a seeded `agent_prompts` row.

Related, practical: production's read-only GET endpoints
(`/manuscript/chapters?bookId=`, `/manuscript/chapters/:id`, `/books/:id`)
are reachable from a cloud session with plain `curl`, which is the easy way to
pull real chapter text into scratch files for offline testing. MCP connector
results are not saved to disk, so retyping them is the only other route.

## 2026-11-26 — "Each skill runs its own agent" meant a subagent in the writer's chat, not a backend API call

Asked to build eight "skills" in the backend where "each skill runs its own
agent", I built reviewers that the backend runs itself, on the backend's
Anthropic key (`anthropicReviewerCaller` in `skillReview.ts`), and shipped
the anti-slop slice that way. The writer then said the reviewers "won't run on
Claude API. They run in chat... run by subagents in chat", the same way the
Claude-side gatekeeper already worked. The backend's job is to own the skill
definitions, build the brief, and check and record the verdict, not to run
the model. The verdict checking, storage and save gate survived the change;
the execution path did not.

**Rule:** when a request says an "agent" or "skill" does some work, ask where
it executes (the backend calling an API, or a subagent in the writer's own
Claude session) and whose account pays, before building the call path.
"Backend" in this project can mean "the backend enforces it" without meaning
"the backend runs it".

## 2026-11-26 — The Ghost Editor removes banned terms reliably but rewrites far more than the term

Tested live against Hanami with the real `enforceBannedTerms` (paragraph-level
regeneration) on five paragraphs, using the writer's two real banned phrases plus
a test-only list of likely substitutes. It resolved all five, including a case
that needed 3 attempts because the first rewrites landed on other banned
phrases, so the retry loop works. But one banned phrase in a 100-word paragraph
got the WHOLE paragraph rewritten: two named characters (Fenris, Mina) dropped
out, a dash (house-banned) and a stock line ("The air hung heavy with unspoken
tension") came in. Another case turned two sentences into 70 words of invented
content. "resolved: true" only means the banned string is gone; it says nothing
about what else changed.

Also tested the narrower alternatives. Sentence-level rewrite (only the sentence
holding the term, re-checked against the full list, landed-on terms added to the
avoid list) resolved everything in 1-2 calls and left the rest of the paragraph
byte-for-byte, though the rewritten sentence could still pick up an invented
detail. Asking Hanami for replacement words for ONLY the banned span and splicing
them in broke grammar every time ("to look look at", "stepped forward. step
forward"): Hanami doesn't respect span boundaries.

**Rule:** judge a corrective rewrite loop by what it changed outside the target,
not only by whether the target is gone; diff it. And the smallest unit Hanami
can safely rewrite is a sentence, not a word or phrase.

## 2026-11-26 — A reviewer rubric is only trusted after it catches a known error; "met or heard of" let a real one through

Validated the ported gatekeeper by putting back an error it is on record as
catching (Ch 565: Kane asks "Is Mina happy about it?" though he has never heard
her name) and giving a fresh Opus reviewer the exact backend brief. First run:
it found the line but rated it a minor soft gap, because Ch 543 shows Mina on
Jace's arm in a room Kane is in, and the check read "a person they have never
met or heard of" — seeing her satisfied "met". The backend's citation check
confirmed its Ch 543 quote was real, so the reviewer wasn't hallucinating; the
rubric's wording was too loose. After adding "seeing someone is not knowing
their name: find the scene where they heard the name", a fresh reviewer marked
it a hard contradiction and the backend turned it into a BLOCK.

**Rule:** validate every reviewer rubric against at least one known, recorded
error before trusting it (the same rule as the narration detector's labelled
corpus). When it misses, the fix is usually a sharper distinction in the
criterion's wording, not a stronger instruction.
