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
