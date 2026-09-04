# WordArchitect Backend — Architectural Blueprint

## System Vision

WordArchitect is an **Autonomous Contextual AI Fiction Platform** backend for
long-form novel writers. Existing tools force authors to manually write and
maintain chapter/scene summaries to keep AI-generated prose consistent with
the story so far — a "manual summary tax."

This system eliminates that tax entirely. A writer maintains a standard
**Codex** (characters, locations, lore) as they normally would, types a scene
beat, and clicks generate. The backend autonomously compiles the exact
context the model needs — no summaries, no manual context curation — without
bloating the LLM's context window.

## Tech Stack

- **Runtime**: Node.js + TypeScript (strict mode, ESNext/NodeNext modules)
- **API layer**: Express
- **Database & Vector Memory**: Supabase (PostgreSQL) with the `pgvector` extension
- **Embedding model**: OpenAI `text-embedding-3-small` (1536 dimensions) — used to index both manuscript text and Codex profiles
- **Creative generation engine**: Hanami (Llama 3.1 70B merge), hosted via the Infermatic API, 32k token context window
- **In-app AI Assistant**: Claude (Anthropic API), agentic tool-calling chat — distinct from Hanami (prose generation) and from the external MCP server (Claude Desktop/claude.ai as a separate connected client)

## Frontend Integration Reference

**Base URL: `https://wordarchitect-backend.onrender.com`** — every path
below is relative to this (e.g. `POST /books` = `POST
https://wordarchitect-backend.onrender.com/api/v1/books`). Render's free
tier spins down on inactivity, so the first request after a quiet period
can take several seconds to wake it up; not a bug, just cold-start
latency to plan the UI around (a loading state, or a keep-alive ping).

Fast lookup for wiring the frontend's mock-store entities to real
endpoints — see Content Management API below for full request/response
detail on each. Every route is prefixed `/api/v1` and takes/returns JSON.
Almost everything is scoped by `bookId` (a real UUID from `POST /books`,
not the frontend's mock project IDs), and most writes also take `userId`.

| Frontend entity | Backend surface | Notes |
| --- | --- | --- |
| Project | Books CRUD (`/books`) | `books.id` *is* the `bookId` every other entity below is scoped by |
| Character | Codex CRUD (`/codex`), `entryType: "character"` | rich profile fields per the `codex_entries` schema above |
| Worldbuilding categories | World Categories CRUD (`/world-categories`) | open-ended, user-creatable |
| Worldbuilding entries (`WorldEntry`) | Codex CRUD (`/codex`), `entryType: <category key>` | same table/endpoints as Character, different `entryType` |
| Notes | Notes CRUD (`/notes`) | `mine` is not a stored field — compare `note.userId` to the viewer |
| Manuscript/Chapters (rich editor) | Manuscript Chapters CRUD (`/manuscript/parts`, `/manuscript/chapters`, `/manuscript/chapters/:id/scenes`) | `PATCH /manuscript/chapters/:id` is the autosave endpoint; `POST .../sync-to-memory` is a separate, explicit "accept into AI memory" action |
| AI Assistant (in-app chat, persona cards) | Chat Assistant (`/chat`, `/chat/sessions`) | see Chat Assistant section below — separate from Hanami prose generation and from the external MCP server |
| Outliner (Act/Chapter/Beat) | Outliner (`/outline/beats` for the whole-book board, `/manuscript/chapters/:id/beats` for a single chapter) | Acts are `manuscript_parts`, Chapters are `manuscript_chapters` — both already existed; Beats (`chapter_beats`) are the new piece — see Outliner section below |
| Dashboard-only stats (today's progress, AI insights, activity feed) | *not built* | frontend's own decision to keep these mock for now |

**Known gap, deliberately accepted for now — revisit once real user
accounts exist:** no authentication on `/api/v1/*`. Every route trusts
whatever `userId`/`bookId` the caller sends — there's no session/token
tying a request to a real logged-in account, so anyone who knows or
guesses a `bookId` can read or write that book's data. Acceptable at this
MVP/single-user stage; only the separate `/mcp` surface requires a bearer
token (`MCP_API_KEY`). Add real auth in a follow-up pass, not silently —
this is a conscious tradeoff, not an oversight.

## Dual-Layer Context Engine

`POST /api/v1/generate-prose` accepts a user's scene beat and autonomously
compiles context from three parallel layers — plus optional, mandatory
per-chapter instructions ranked above all three — before invoking Hanami.
No layer depends on manually authored summaries.

### Layer 0 — Instructions For This Chapter (Mandatory, Highest Priority)

Fresh, per-generation `MUST` / `MUST NOT` directives for the chapter about
to be written — e.g. "write entirely from Kaelen's POV" (MUST) or "don't
reveal Sera's pregnancy yet" (MUST NOT, i.e. a negative prompt). Entered
directly in the test UI's Generate Prose form (`chapterInstructions` /
`chapterAvoid` fields) alongside the scene beat, on every call — **not
saved anywhere**. A writer fills this in fresh before writing a given
chapter; nothing here silently carries over to the next one. (An earlier
version of this persisted a single saved-per-book instructions block that
was always injected — deliberately reworked into this per-generation form
because "guides every chapter forever" and "guides the chapter I'm about
to write" are different needs, and conflating them meant there was no way
to say "don't do X" for just this one scene.)

Split into two fields rather than one free-text box specifically so a
negative constraint is structurally unambiguous — Hanami is far more
likely to actually enforce "don't reveal X" when it's a syntactically
distinct `MUST NOT` rule than when it's one sentence inside a paragraph it
can read as ambient description. Built by `buildChapterInstructionsSection`
in `src/services/rag.ts`.

Ranked above Layer 1/2/3 in three ways, not just token priority:
- **Placement**: first section in the compiled system prompt (models
  weight instructions near the start more heavily).
- **Budget priority**: its token cost is measured and reserved before any
  other layer sees its budget, making it the last thing trimmed rather
  than the first. Capped at ~500 tokens combined (`CHAPTER_INSTRUCTIONS_
  TOKEN_BUDGET` in `rag.ts`) and truncated if longer, so an unusually long
  do/avoid list can't consume the entire 6,000+100 ceiling and starve
  Codex/History/RAG entirely.
- **Recency reinforcement**: the `MUST NOT` list is *also* echoed by
  `buildUserMessage` in `src/routes/generateProse.ts`, restated
  immediately before the scene beat in the user turn Hanami actually
  writes from. Instructions closest to where generation starts are
  weighted more heavily than the same instruction stated once further
  back in a long prompt — this matters most for negative constraints,
  since nothing later in generation naturally reinforces "don't."

Empty by default; costs nothing when unset. Applies to `/generate-prose`
and `/generate-prose/preview`; not sent to `/ask`, which is a retrieval
diagnostic rather than a real generation.

#### Inline (parenthetical) instructions in the scene beat

A second, positional way to give Hanami a directive: wrap a note in the
scene beat itself in `(parentheses)` — e.g. "he opens the door (describe
the cold air first) and steps in" — to scope an instruction to that exact
point in the scene, rather than the whole chapter (that's what
Instructions For This Chapter, above, is for). Only `()` triggers this;
`[]`/`{}`/`<>` are always left as plain text with no special meaning, so a
character's own bracket usage in dialogue or narration is never misread as
a directive. Live-highlighted in the test UI's scene beat field as you
type (`buildBeatHighlightHtml` in `public/index.html`) so it's visually
obvious what's being read as an instruction versus prose.

`markBracketedInstructions` (`src/lib/bracketInstructions.ts`) rewrites
each matched span into an explicit `<<DIRECTIVE: ...>>` tag before the beat
is sent, kept exactly where the writer placed it — `buildUserMessage`
(`generateProse.ts`) prepends a one-line explanation of the convention
whenever at least one tag is present. Deliberately **not** part of the
compiled context (`assembleContextPayload`) at all: the whole point is to
put the instruction directly in the one message Hanami is actually writing
from, not have it compete with Codex/History/RAG further up the prompt.

The tag is `<<DIRECTIVE: ...>>` rather than the more obvious
`[INSTRUCTION: ...]` — testing found Hanami (an RP-tuned model with a
learned habit of bracketed OOC asides) would occasionally imitate a
single-bracket-style tag and fabricate one of its own into the output,
roughly 1 in 3-4 generations with the original format. Double angle
brackets sit further from that learned convention and reduced it, but
this is a mitigation, not a guarantee, so `stripLeakedDirectiveTags` in
`src/services/llm.ts` is the actual backstop: it wraps both
`streamHanamiProse` and `generateHanamiProse`, buffering just enough of
the token stream to detect and drop any `<<DIRECTIVE: ...>>`-shaped span
that leaks into the real output, whether or not the current generation
used the syntax itself. An unterminated open tag (no closing `>>` ever
arrives) is flushed as plain text at the end of the stream rather than
held forever, so it fails safe rather than silently swallowing content.

### Layer 1 — Codex (Explicit Match)

Direct string/alias lookup against saved character, location, and lore
entries. Scans the scene beat text for known names or aliases and injects a
condensed summary of the matched profile(s) — description plus top
personality traits/motivations, not the full Codex record (see Database
Schema below for what stays human-facing-only).

- Budget: **~500–800 tokens max**
- Deterministic, no embedding call required

### Layer 2 — Recent History (Linear Slip)

Pulls the trailing **1,500–2,000 words** of manuscript text immediately
preceding the user's cursor position. Guarantees continuity of scene pacing,
tone, and character positioning at the point of generation.

- Budget: **~2,000 tokens**
- Positional slice, no embedding call required

### Layer 3 — Deep Past (Vector RAG)

The scene beat is first expanded (`src/services/queryExpansion.ts`) into up
to 4 distinct searchable concepts — plot objects, events, or threads, not
character names (Layer 1 already covers those deterministically) — each
rewritten into a concrete narrative sentence, not an abstract summary
label, closer to how it would actually read in prose (the expansion
prompt gives explicit good/bad phrasing examples for this). This exists
because a single beat often mixes unrelated topics (e.g. "the pregnancy,
and the totem"), and embedding the whole beat as one blended query lets
one topic crowd out the other; searching each concept separately gives
both a fair shot. Each concept is embedded via `text-embedding-3-small`
and matched against previously embedded manuscript chunks using the
cosine similarity RPC `match_manuscript_chunks`. Which matches *qualify*
is decided by interleaving round-robin across concepts (best-of-A,
best-of-B, ..., second-best-of-A, ...) rather than pooling and sorting by
raw similarity — otherwise a concept with generally higher-scoring
matches could crowd a less-dominant one out of consideration entirely.
Once selected, though, the qualifying matches are re-sorted by similarity
before anything gets expanded/budgeted (`gatherLayer3Candidates` in
`rag.ts`) — round-robin order and similarity order are different things,
and using round-robin order for budget allocation was a real bug: a
concept's weaker match (an incidental background detail, going first
purely because it's that concept's turn) could consume a full chapter's
worth of budget before a different concept's genuinely central match
ever got expanded, confirmed against a real generation where the scene's
actual subject got squeezed to a ~300-token fragment while a barely-
relevant background detail got a full chapter. Falls back to treating the
whole beat as a single concept if expansion fails for any reason.

- Budget: **whatever remains of the 6,000-token total after Layer 1,
  Layer 2, and the fixed prompt scaffolding** — see Strict Context
  Boundary below. Not a fixed sub-budget: a fixed 1,000-token Layer 3
  cap routinely left hundreds of tokens on the table when Layer 1/2
  under-used their own share, the difference between Hanami getting a
  full chapter of surrounding context versus one isolated ~180-word
  fragment.
- The only layer that performs live embedding + vector search round trips
- Match threshold is `0.3` — was `0.5`, chosen with no real calibration.
  A stress test against real manuscript content found genuinely relevant
  matches scoring 0.33-0.37 and getting wrongly excluded entirely; after
  sharpening the query-rewriting prompt toward concrete narrative
  phrasing (above) and lowering the threshold, the same test scene beat
  went from 0 relevant passages included to 5, correctly ranked, with
  the previously-thin "totem" thread now getting two passages instead of
  one fragment. Still a value worth re-tuning as more real usage
  accumulates, not a permanently settled constant — and a lower
  threshold does let occasional weak/borderline matches through at the
  margin, a known tradeoff of favoring recall over precision here.
- **Chapter-aware expansion**: a raw vector match is one ~180-word chunk,
  too thin on its own for Hanami to follow a scene. For each match that
  clears the threshold, in similarity-ranked order (highest first) and
  deduplicated by chapter, `src/services/rag.ts` fetches every chunk
  belonging to that chunk's `chapter_number` and expands outward from the matched
  `scene_order` (alternating forward/backward by proximity, whole-chunk
  boundaries only — never a mid-sentence truncation) until the remaining
  Layer 3 budget for this generation is used up. This is what lets a
  single similarity hit surface as a real, readable scene instead of a
  disconnected fragment. Requires `match_manuscript_chunks` to return
  `chapter_number`/`scene_order` (migration `007_match_chunks_with_position.sql`
  — see Database Schema below).
- `/generate-prose/preview` surfaces exactly which chapters got expanded,
  their token cost, best matching similarity, and which concept(s) pulled
  them in (`expandedChapters` in the response, rendered in the test UI's
  Preview panel) — full inspectability into what Layer 3 actually did for
  a given generation, since retrieval finishes well under a second and
  there's no meaningful "in progress" state to stream.

## Strict Context Boundary

The **total compiled prompt payload** (Layer 0 this-chapter's instructions
+ Layer 1 + Layer 2 + Layer 3 + the fixed system-prompt scaffolding from
`buildSystemPrompt`/`buildAskSystemPrompt`) **must remain under ~6,000
tokens, with up to 100 tokens of tolerance (6,100 hard ceiling)**.

Raised from an original 4,000 after checking real usage against a live
172-chapter book: a realistic "continue writing" beat with pasted recent
history was landing at 4,095-4,096/4,100 — maxed out — and squeezing a
second genuinely relevant chapter down to ~100 tokens purely because the
budget ran out, not because it was less relevant. At 6,000, the same beats
landed at 5,933-6,031/6,100 and both got three full expanded chapters
instead of two full plus a fragment. Not a permanently settled number —
worth re-checking against real usage again if it starts happening at 6,000
too, the same way 4,000 did.

This exists to preserve context headroom out of Hanami's 32k window for
uninterrupted prose generation (~26,000 tokens free at the current 6,000
cap) — raising it further has a real ceiling, since the compiled context
and the generated chapter share the same 32k window. The layers pool this
budget rather than each getting a fixed slice: Layer 0, then Layer 1, then
Layer 2 are measured in that order (by actual token usage, not their
nominal caps), and Layer 3 receives whatever remains, up to the 6,000+100
ceiling — it's fine, and expected, to spend that remainder down to the
tolerance rather than leave it unused, since unused budget here means
Hanami gets less real context, not a safety margin worth preserving.
Layer 3's chapter expansion (above) is greedy and stops as soon as the
next whole chunk would exceed what's left, so it lands at or slightly
under budget rather than over it.

Priority order when trimming to fit budget: Layer 0 (this chapter's
instructions) > Layer 1 (Codex) > Layer 2 (Recent History) > Layer 3
(Deep Past RAG).

## `POST /api/v1/ask` — Retrieval Accuracy Diagnostic

Not prose generation: asks Hanami a direct factual question using the same
Layer 1/3 retrieval `/generate-prose` relies on (Layer 2 is skipped — a
question has no cursor position), instructed via a stricter system prompt
to answer only from the compiled context and say plainly when it can't,
at a low temperature (0.2, vs. prose generation's 0.85) since precision
matters more than creative variation here. Exists to separate two
failure modes that look identical from prose output alone: retrieval
finding the wrong/no context, vs. Hanami failing to use context it was
actually given. Built in `src/routes/ask.ts`.

**Book Facts**: prepended ahead of Codex/manuscript memory, computed via
the `get_book_facts` RPC (`src/services/bookFacts.ts`) rather than
retrieval — highest chapter number written, total chapters ingested,
total manuscript chunks. Exists because a question like "what's the last
chapter written?" is an aggregate fact about the corpus, not something
vector similarity can answer: there's no meaningful "closest match" to
the concept of "lastness," so retrieval-based questioning answered it
with a different, essentially arbitrary chapter on every attempt. Must be
a server-side SQL aggregate, not a client-side fetch-and-reduce — an
earlier version fetched all `manuscript_chunks` rows for the book and
computed `MAX`/`COUNT DISTINCT` in JS, which is silently wrong on any book
with more than 1,000 chunks because PostgREST caps an unbounded
`.select()` at 1,000 rows by default. Caught via a real 2,303-chunk book
reporting chapter 313 as the highest instead of the real 377.

## Banned Terms (Ghost Editor)

A writer can ban a word or phrase per book — via the test UI's Banned
Terms panel, or `GET/POST /api/v1/banned-terms` and
`DELETE /api/v1/banned-terms/:id` — and Hanami is guaranteed to never
produce it again, checked on every `/generate-prose` call and on every
MCP `generate_prose_direct` call that passes `bookId` (see MCP Server
below — `bookId` is optional there since not every direct call is tied to
a real book, but omitting it also means banned terms for that book go
unchecked, so the MCP tool's own description tells Claude to always pass
it when one exists, including every call inside a scene draft session).

**Why there's no cheap path**: the obvious-sounding mechanism —
suppress the word at the token level via `logit_bias` so Hanami
literally cannot generate it, at zero extra cost — does not work on this
stack. Confirmed by direct testing against the real Infermatic API:
temperature 0, the exact real token IDs for a test word (verified with
Llama 3's actual tokenizer), maximum suppression (-100), and the output
was byte-for-byte identical to an unbiased request across repeated
trials. `logit_bias` is silently not honored somewhere in the LiteLLM
proxy / inference chain. It also wouldn't have been safe even if it
worked: most English words are multiple subword tokens, and the pieces
are frequently shared with unrelated vocabulary — "shiver" decomposes to
"sh" + "iver," and both fragments are common pieces of many other words
entirely. Suppressing either would have collateral effects far beyond
the one word intended. So there is exactly one enforcement mechanism
here, used for both single words and full phrases — no fast path, no
free path.

**How it actually works** (`src/services/ghostEditor.ts`): when a book
has at least one banned term, `/generate-prose` buffers the full
generation (`generateHanamiProse`, not the live token stream) instead of
streaming it directly, splits it into paragraphs, and checks each one
(case-insensitive substring match — deliberately not strict word-
boundary matching, so banning "delve" also catches "delved"; a writer
wanting full conjugation coverage bans multiple literal forms rather
than relying on a stemmer this doesn't have). Any paragraph containing a
banned term gets regenerated via a narrowly-scoped Hanami call — only
that paragraph, with the surrounding paragraphs supplied as context-only
— re-checked after each attempt, up to 3 tries, before being accepted.
Paragraph-level scope is deliberate, not arbitrary: it matches the
project's established finding that Hanami's scope discipline holds up
well around one paragraph per call and degrades sharply beyond it (see
the MCP Server section's supervised-drafting findings), so this reuses
the same "narrow scope, verify, retry" pattern already proven to work
rather than inventing a new one.

**The real cost, stated plainly**: for a book with banned terms
configured, `/generate-prose` loses live token-by-token streaming —
the writer sees the finished, already-clean text appear once generation
and any needed corrections are done, not prose typing out in real time.
This is the honest tradeoff for the actual guarantee ("never see a
banned term on screen") instead of the originally-imagined free one. A
book with zero banned terms is completely unaffected — same live
streaming as always, zero added latency, zero extra calls; the banned-
terms lookup is the only overhead, one cheap query per generation.

A generation's correction report (which paragraphs were rewritten, what
was found, how many attempts, whether it was ultimately resolved) is
appended to the stream after a `<<<GHOST_EDITOR_REPORT>>>` marker
(`GHOST_EDITOR_REPORT_MARKER` in `generateProse.ts`) that the test UI
strips out and renders as its own table rather than showing as raw text
in the prose output — the same transparency principle as the diff
tooling elsewhere in this project: show what actually happened, not just
a claim that it worked.

## Database Schema

Defined in `supabase/migrations/001_init_schema.sql`. Every table is scoped
by `book_id` (and `user_id`) so retrieval never crosses between books or
accounts.

### `codex_entries` (Layer 1 source)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID NOT NULL | |
| `book_id` | UUID NOT NULL | |
| `name` | VARCHAR(255) NOT NULL | |
| `aliases` | VARCHAR(255)[] | alternate names/titles scanned during Layer 1 match |
| `entry_type` | VARCHAR(50) NOT NULL | `character`, or any worldbuilding category key. No longer a fixed `CHECK` enum as of migration `016_world_categories.sql` — see World Categories below |
| `description` | TEXT NOT NULL | overview/summary; the only field always injected on a Layer 1 match |
| `embedding` | VECTOR(1536) | reserved for future semantic Codex lookup; not used by Layer 1's deterministic string match |
| `tier` | VARCHAR(20) | CHECK: `main` \| `supporting` \| `minor` \| `extra` |
| `quote`, `image_url`, `age`, `gender`, `role_in_story`, `occupation`, `location_name` | TEXT/VARCHAR | human-facing profile fields, CRUD-only — not injected into Layer 1 |
| `physical_description`, `motivations` | TEXT[] | bullet-list fields; `motivations` (top 3) is condensed into Layer 1 alongside `personality_traits` |
| `personality_traits` | VARCHAR(100)[] | condensed into Layer 1 as a short `Traits: ...` line |
| `background` | TEXT[] | bullet-list field, human-facing only, not injected into Layer 1. Was a single TEXT column until migration `014_character_expansion.sql`, matching the frontend's Character shape (`background: string[]`); an existing free-text value became a one-element array rather than being guessed apart at paragraph breaks, which risked mangling real data based on formatting assumptions that might not hold |
| `notes` | JSONB | array of `{ title, body, date?, pinned? }`, human-facing only. Was a single TEXT column until the same migration; an existing free-text value became a single `{ title: 'Notes', body: <old text>, date: <created_at>, pinned: false }` note rather than being dropped |
| `character_arc` | JSONB | array of `{ stage, description }`; human-facing only |
| `event_year` | VARCHAR(50) | for `history`-type entries (timeline events) |
| `nickname`, `epithet`, `status`, `alignment`, `archetype` | VARCHAR | human-facing profile fields, CRUD-only — not injected into Layer 1 |
| `pov_character` | BOOLEAN NOT NULL | default `false`; whether this character is a POV character for the book |
| `favorites` | INT NOT NULL | default `0` |
| `motivation`, `goal`, `fear`, `secret`, `internal_conflict` | TEXT | singular human-facing fields, distinct from the `motivations` list above — human-facing only |
| `life_events` | JSONB | array of event objects; shape not strictly enforced server-side (frontend's `LifeEvent` shape isn't settled) |
| `cultural_background` | JSONB | object, e.g. `{ origin, upbringing, education, beliefs, languages }`; shape not strictly enforced server-side |
| `strengths`, `weaknesses` | TEXT[] | human-facing only |
| `created_at` | TIMESTAMPTZ | default `NOW()` |
| `updated_at` | TIMESTAMPTZ | default `NOW()`, set on every `PATCH`/`update_codex_entry` call. Added in migration `016_world_categories.sql` — `codex_entries` never had one, needed for the frontend's "last updated" display (Character and `WorldEntry.updatedHours` both need it) |

Managed entirely through `POST/GET/PATCH/DELETE /api/v1/codex` (see below). Only
`description` + condensed `personality_traits`/`motivations` ever reach Hanami's
prompt — the richer fields exist for a human-facing Codex UI (character sheets,
worldbuilding pages) and stay out of the token budget regardless of how much
detail a writer stores.

Added in migration `014_character_expansion.sql` to close the frontend's
biggest documented editable gap for Character (per its own CLAUDE.md,
`src/lib/character-data.ts`): most of the fields above previously existed
only in the frontend's seed data, with nothing to save to on this side.
`life_events`/`cultural_background` are validated only as "an array of
objects" / "an object" (`isObjectArray`/`isPlainObject` in
`src/routes/codex.ts`), not against specific required keys — their exact
shape isn't settled on the frontend yet, and a strict schema would just
reject legitimate writes once it inevitably falls out of sync.

### `world_categories` (worldbuilding category metadata)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | `gen_random_uuid()` |
| `book_id` | UUID NOT NULL | |
| `key` | VARCHAR(100) NOT NULL | slug, UNIQUE with `book_id`; the value stored in `codex_entries.entry_type` for entries in this category |
| `name` | VARCHAR(255) NOT NULL | display name, e.g. "Ship Technology" |
| `description` | TEXT | |
| `color` | VARCHAR(50) | |
| `icon` | VARCHAR(100) | |
| `created_at` | TIMESTAMPTZ | default `NOW()` |

Added in migration `016_world_categories.sql`, which also **dropped**
`codex_entries`' `entry_type` `CHECK` constraint — closing the gap between
that constraint's original fixed list (`character` \| `location` \| `item`
\| `lore` \| `nation` \| `culture` \| `magic` \| `faction` \| `religion` \|
`history`, from migration `002_expand_codex_schema.sql`) and the
frontend's open-ended, user-creatable `WorldCategoryKey` system (its
`NewCategoryInput` lets a writer create arbitrary new categories with a
slugified key, color, and icon — a closed enum can't represent that).

Worldbuilding entries themselves are **not** a separate table — they
already live in `codex_entries` (the non-`character` `entry_type` values
above, including real production data predating this migration). Forking
a dedicated table would have meant either migrating that real data or
losing Layer 1's explicit name/alias-match coverage of it for no real
benefit — Layer 1 (`src/services/rag.ts`) already scans `codex_entries`
by name/alias regardless of `entry_type`, and nothing there needed to
change. `entry_type` is now validated at the application layer as "any
non-empty string" (`src/routes/codex.ts`) rather than a closed list;
`world_categories` only ever adds presentation metadata (name/color/icon)
for a key, it never gates whether an `entry_type` is "valid".

This table only stores categories that have been explicitly created (with
custom color/icon/description). `GET /api/v1/world-categories?bookId=`
(`listWorldCategories` in `src/routes/worldCategories.ts`) merges these
rows with any `entry_type` already in real use on the book's
`codex_entries` that has no matching row here yet — so a book's
pre-existing `nation`/`culture`/`magic`/`faction`/`religion`/`history`
entries show up as categories immediately (with a derived display name,
title-cased from the key) rather than being invisible until someone
manually backfills a row for them. Deleting a category (`DELETE
/api/v1/world-categories/:id`) only removes its metadata row —
`codex_entries` rows keep their `entry_type` string as-is and just fall
back to the derived display, the same non-cascading principle used
everywhere else in this schema.

### `codex_relationships` (character bonds)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | `gen_random_uuid()` |
| `book_id` | UUID NOT NULL | |
| `from_entry_id`, `to_entry_id` | UUID NOT NULL, FK → `codex_entries(id)` | `ON DELETE CASCADE`; CHECK prevents self-relationships |
| `bond_type` | VARCHAR(100) NOT NULL | e.g. "Nephew of", "Rival" |
| `description` | TEXT | |
| `strength` | VARCHAR(20) | CHECK: `strong` \| `moderate` \| `tense` \| `weak` |
| `created_at` | TIMESTAMPTZ | default `NOW()` |

Not currently surfaced to Layer 1 — purely for the human-facing Codex UI's
Relationships tab. Managed via `/api/v1/codex/:id/relationships`.

### `notes` (quick brainstorming captures)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID NOT NULL | the note's author |
| `book_id` | UUID NOT NULL | |
| `title` | VARCHAR(255) NOT NULL | |
| `excerpt` | TEXT NOT NULL | the note's body |
| `category` | VARCHAR(50) NOT NULL | CHECK: `World Building` \| `Character` \| `Plot` \| `Research` \| `Inspiration` \| `Magic System` |
| `pinned` | BOOLEAN NOT NULL | default `false` |
| `comments` | INT NOT NULL | default `0`; a plain stored counter, not backed by a real comments table — nothing in the frontend's documented `Note` shape describes individual comment records, same pattern as `codex_entries.favorites` |
| `created_at`, `updated_at` | TIMESTAMPTZ | default `NOW()` |

Added in migration `017_notes.sql` for the frontend's Quick Notes composer
/ notes modal (`Note { id, title, excerpt, category, date, dateRank,
comments, pinned, mine }`). Unlike Worldbuilding's category system,
`category` here is `CHECK`-constrained to a fixed set rather than
open-ended — the frontend's documented values are sourced from real type
definitions, not placeholder seed data, and nothing in its `NewNoteInput`
suggests a writer can invent new categories the way `NewCategoryInput`
does for worldbuilding.

`mine` from the frontend type is deliberately **not** a stored column —
it's relative to whoever is viewing ("is this my note"), not an inherent
property of the note itself. `user_id` is stored instead (the same
pattern every other table in this schema uses), and "mine" is just
`note.user_id === the viewer's user_id`, computed by whichever layer
knows who's currently viewing.

Managed via `GET/POST/PATCH/DELETE /api/v1/notes` (see below), mirrored
on the MCP surface as `list_notes`/`create_note` since a writer's
brainstorming notes are exactly the kind of context a Claude session
should be able to read and add to.

### `manuscript_chunks` (Layer 2/3 source)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID NOT NULL | |
| `book_id` | UUID NOT NULL | |
| `chapter_number` | INT NOT NULL | |
| `scene_order` | INT NOT NULL | ordering within a chapter |
| `raw_text` | TEXT NOT NULL | source for both the trailing-window slice (Layer 2) and embedding (Layer 3) |
| `embedding` | VECTOR(1536) | generated from `raw_text` via `text-embedding-3-small` |
| `created_at` | TIMESTAMPTZ | default `NOW()` |

### `match_manuscript_chunks` RPC (Layer 3)

`match_manuscript_chunks(query_embedding VECTOR(1536), match_threshold FLOAT, match_count INT, target_book_id UUID) RETURNS TABLE(id UUID, raw_text TEXT, chapter_number INT, scene_order INT, similarity FLOAT)`

Cosine distance search (`<=>` operator) scoped to `target_book_id`,
filtered by `match_threshold`, ordered by similarity descending, capped at
`match_count`. Layer 3 calls this once per expanded concept (see above)
with `match_count = 3` and `match_threshold = 0`, applying the real
threshold locally afterward. Returns `chapter_number`/`scene_order`
alongside each match (added in migration
`007_match_chunks_with_position.sql`, which drops and recreates the
function since Postgres requires that for a return-signature change) so
Layer 3's chapter expansion (above) knows which chapter to fetch and
where the match sits within it — without this, expansion would need a
second round-trip per match just to look up its position.

### `get_book_facts` RPC (`/ask`'s Book Facts)

`get_book_facts(target_book_id UUID) RETURNS TABLE(highest_chapter INT, total_chapters INT, total_chunks INT)`

Single SQL aggregate (`MAX`, `COUNT(DISTINCT chapter_number)`, `COUNT(*)`)
scoped to `target_book_id`, added in migration `010_book_facts.sql`.
Deliberately a server-side aggregate rather than fetching rows to compute
in JS — see Book Facts above for why that was tried first and was
silently wrong past 1,000 chunks.

### `manuscript_parts` / `manuscript_chapters` / `manuscript_scenes` (rich-editor content)

Added in migration `015_manuscript_chapters.sql` to close the frontend's own
biggest documented gap: its rich-text chapter editor (paragraphs with
emphasis/breaks/inline comments) had real formatting but nothing on this
backend to save to — "All changes saved" was decorative, never actually
false.

Deliberately a separate set of tables from `manuscript_chunks`, not a
reuse of it. `manuscript_chunks` is a *derived* RAG index — ~180-word
chunks, purpose-built for Layer 2/3 retrieval. These tables are the
*editable source of truth* for a chapter's full rich content — one row
per chapter — independent of how that content later gets chunked for
retrieval. Conflating the two would mean warping either the editor's data
model to fit chunk boundaries, or retrieval chunking to fit editor
pagination, and neither side actually needs that.

| Table | Column | Type | Notes |
| --- | --- | --- | --- |
| `manuscript_parts` | `id` | UUID PK | |
| | `book_id` | UUID NOT NULL | |
| | `title` | VARCHAR(255) NOT NULL | |
| | `order_index` | INT NOT NULL | default `0` |
| | `created_at` | TIMESTAMPTZ | default `NOW()` |
| `manuscript_chapters` | `id` | UUID PK | |
| | `user_id`, `book_id` | UUID NOT NULL | |
| | `part_id` | UUID | FK → `manuscript_parts(id)` ON DELETE SET NULL |
| | `number` | INT NOT NULL | UNIQUE with `book_id`; the same chapter-numbering space `manuscript_chunks.chapter_number` uses |
| | `title` | TEXT | e.g. "The Harbor Gate" |
| | `heading` | TEXT | editor-facing display heading, e.g. "Chapter One" — kept separate from `title` per the frontend's `ChapterBody` shape |
| | `complete` | BOOLEAN NOT NULL | default `false` |
| | `paragraphs` | JSONB NOT NULL | array of `{ id, text, emphasis?, break?, comments?, ... }`, matching the frontend's `ChapterParagraph` shape; validated only loosely server-side (`isParagraphsArray` in `manuscriptChapters.ts` — array of objects with string `id`/`text`, everything else passes through) since inline comment threads are naturally nested per-paragraph data and the exact shape isn't fully settled on the frontend yet |
| | `synced_to_memory_at` | TIMESTAMPTZ | null until the first sync (see below); the sync endpoint itself compares this against `content_updated_at` to decide whether a resync is actually needed |
| | `content_updated_at` | TIMESTAMPTZ NOT NULL | default `NOW()`; bumped ONLY when a `PATCH` actually includes `paragraphs` — unlike `updated_at`, a plain title/heading/complete/part edit never moves this. Added in migration `021_chapter_content_updated_at.sql` specifically so "has the manuscript text changed since last sync" isn't confused with "was this row touched at all" |
| | `created_at`, `updated_at` | TIMESTAMPTZ | |
| `manuscript_scenes` | `id` | UUID PK | |
| | `chapter_id` | UUID NOT NULL | FK → `manuscript_chapters(id)` ON DELETE CASCADE |
| | `title` | VARCHAR(255) NOT NULL | |
| | `order_index` | INT NOT NULL | default `0` |
| | `created_at` | TIMESTAMPTZ | default `NOW()` |

### `chapter_beats` (Outliner)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | |
| `chapter_id` | UUID NOT NULL | FK → `manuscript_chapters(id)` ON DELETE CASCADE |
| `order_index` | INT NOT NULL | default `0` |
| `title` | VARCHAR(255) NOT NULL | |
| `outline_text` | TEXT NOT NULL | default `''`; what the writer plans for this beat — becomes `/generate-prose`'s `userSceneBeat` when generating via `beatId` instead of a freehand paste |
| `status` | VARCHAR(20) NOT NULL | CHECK: `not_started` \| `planned` \| `in_progress` \| `completed`; default `not_started` |
| `linked_to_manuscript` | BOOLEAN NOT NULL | default `false`; flips true once this beat's accepted prose has been written into the chapter's `paragraphs` — a flag, not a tracked paragraph range (see Outliner below for why) |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Added in migration `020_chapter_beats.sql`. See the Outliner section below —
Acts and Chapters already existed as `manuscript_parts`/`manuscript_chapters`;
this table is the one genuinely new piece.

`manuscript_scenes` is a writer-authored navigation marker within a
chapter, not to be confused with `manuscript_chunks.scene_order` — a
RAG chunk position assigned automatically during ingestion.

No foreign key to `books(id)` on `manuscript_parts`/`manuscript_chapters`
— same reasoning as `codex_entries`/`manuscript_chunks` (see `013_books.sql`):
a real `book_id` already in use may not yet have a corresponding `books`
row, and a FK here would block legitimate writes for it. `part_id` and
`chapter_id` above *are* real foreign keys, since those referenced tables
are wholly new with no pre-existing data to conflict with.

### `chat_sessions` / `chat_messages` (in-app AI Assistant)

| Table | Column | Type | Notes |
| --- | --- | --- | --- |
| `chat_sessions` | `id` | UUID PK | |
| | `user_id`, `book_id` | UUID NOT NULL | |
| | `persona` | VARCHAR(50) NOT NULL | default `'general'`; one of `VALID_CHAT_PERSONAS` — see Chat Assistant below |
| | `title` | TEXT | auto-derived from the first message (truncated) if not set explicitly |
| | `created_at`, `updated_at` | TIMESTAMPTZ | `updated_at` bumped on every new message, for "most recent conversation" ordering |
| `chat_messages` | `id` | UUID PK | |
| | `session_id` | UUID NOT NULL | FK → `chat_sessions(id)` ON DELETE CASCADE |
| | `role` | VARCHAR(20) NOT NULL | CHECK: `user` \| `assistant` |
| | `content` | TEXT NOT NULL | |
| | `tool_calls` | JSONB | array of `{ tool, input }` — which read tools the assistant called while producing this message, null for user messages; transparency into what it actually looked up before answering |
| | `created_at` | TIMESTAMPTZ | default `NOW()` |

Added in migration `019_chat_assistant.sql`. One row per conversation,
one row per turn — not a single growing JSONB blob on the session row, so
appending a message never means rewriting/resending the whole history.
See Chat Assistant below for the full feature.

### Indexes

- `idx_codex_entries_book_id`, `idx_manuscript_chunks_book_id` — B-tree, scope every retrieval query to one book
- `idx_codex_entries_embedding`, `idx_manuscript_chunks_embedding` — HNSW (`vector_cosine_ops`), back the cosine-distance searches above
- `idx_codex_relationships_book_id`, `idx_codex_relationships_from_entry`, `idx_codex_relationships_to_entry` — B-tree
- `idx_manuscript_parts_book_id`, `idx_manuscript_chapters_book_id`, `idx_manuscript_chapters_part_id`, `idx_manuscript_scenes_chapter_id` — B-tree
- `idx_world_categories_book_id` — B-tree
- `idx_notes_book_id` — B-tree
- `idx_chat_sessions_book_id`, `idx_chat_messages_session_id` — B-tree

## Content Management API

Endpoints that keep the Codex and manuscript memory populated and up to date
as a writer works — separate from `/generate-prose`'s read-only retrieval path.

### Projects/Books CRUD (`src/routes/books.ts`)

Every other table in this schema (`codex_entries`, `manuscript_chunks`,
`banned_terms`, `scene_draft_sessions`) scopes itself by `book_id`, but
until migration `013_books.sql` nothing actually created, listed, or
stored a book's own metadata — `book_id` was just a bare UUID other
tables referenced, generated externally. This is what a real frontend's
"Projects" feature reads/writes; the `books.id` a project creates here
*is* the `bookId` used everywhere else in this API.

- `GET /api/v1/books?userId=` — list a user's projects
- `GET /api/v1/books/:id` — fetch one, plus best-effort manuscript stats
  (`highestChapter`/`totalChapters`/`totalChunks` from the same
  `get_book_facts` RPC `/ask`'s Book Facts uses) since chapter count is
  derived from ingested manuscript data, not stored on the book row
  itself — falls back to nulls/zeros rather than failing the whole
  request if a brand-new project has no manuscript yet
- `POST /api/v1/books` — create (`userId`, `title` required; `tagline`,
  `genre`, `subgenres`, `pov`, `tense`, `targetWords`, `status`,
  `coverUrl` all optional)
- `PATCH /api/v1/books/:id` — partial update
- `DELETE /api/v1/books/:id` — deletes only the project's own metadata
  row. Deliberately does not cascade to Codex/manuscript/banned-terms/
  scene-draft data for that `book_id` — there's no foreign key to
  cascade through (see below) — so deleting a project can never
  silently wipe its story content as an unreviewed side effect.

No `CHECK` constraint on `status`/`pov`/`tense`: a real frontend's exact
enum values for these aren't settled yet, and a mismatched constraint
would just reject legitimate writes rather than protect anything. No
foreign key from `codex_entries.book_id` etc. to `books.id` either —
those tables already hold real production data referencing `book_id`s
that predate this table, and adding a FK now risks breaking that data
rather than protecting it. Both are worth revisiting once the real value
sets and existing data are reconciled.

### Codex CRUD (`src/routes/codex.ts`)

- `GET /api/v1/codex?bookId=&entryType=&tier=` — list entries for a book
- `GET /api/v1/codex/:id` — fetch one entry (full record, all fields)
- `POST /api/v1/codex` — create an entry
- `PATCH /api/v1/codex/:id` — partial update
- `DELETE /api/v1/codex/:id` — delete (cascades to its relationships)
- `GET /api/v1/codex/:id/relationships` — list relationships involving an entry (either direction)
- `POST /api/v1/codex/:id/relationships` — create a relationship from `:id` to another entry
- `DELETE /api/v1/codex/relationships/:relationshipId` — delete a relationship

`entryType` accepts `character` or any worldbuilding category key — see
World Categories below rather than a fixed list.

### World Categories CRUD (`src/routes/worldCategories.ts`)

- `GET /api/v1/world-categories?bookId=` — every category for a book:
  explicit `world_categories` rows merged with any `entry_type` already in
  use on the book's `codex_entries` that has no metadata row yet (see the
  `world_categories` schema section above for why). Derived entries carry
  `is_derived: true` and an empty `id`/`created_at`
- `POST /api/v1/world-categories` — `{ bookId, name, key?, description?,
  color?, icon? }`; `key` is auto-slugified from `name` when omitted
  (lowercase, non-alphanumeric runs collapsed to `-`), matching the
  frontend's own `NewCategoryInput` slugification so a category created
  from either side lands on the same key. 409 if the key already exists
  for this book
- `PATCH /api/v1/world-categories/:id` — `name`/`description`/`color`/
  `icon` only; `key` is immutable once created since existing
  `codex_entries.entry_type` values reference it by string, and renaming
  it would silently orphan them
- `DELETE /api/v1/world-categories/:id` — deletes only the category's
  metadata row; `codex_entries` rows using its key keep that value and
  fall back to a derived display (see above), never cascaded

Mirrored on the MCP surface as `list_world_categories` and
`create_world_category` (`src/mcp/tools.ts`) so Claude can check what
categories already exist before proposing an `entryType` for
`create_codex_entry`, and create new ones the same way a writer would
from the frontend.

### Notes CRUD (`src/routes/notes.ts`)

- `GET /api/v1/notes?bookId=&category=&pinned=` — list a book's notes,
  pinned first then most recently updated
- `GET /api/v1/notes/:id`
- `POST /api/v1/notes` — `{ userId, bookId, title, excerpt, category,
  pinned? }`
- `PATCH /api/v1/notes/:id` — partial update, including `comments` (a
  plain counter — see the `notes` schema section above)
- `DELETE /api/v1/notes/:id`

Mirrored on the MCP surface as `list_notes`/`create_note` — a writer's
brainstorming notes are context a Claude session should be able to read
and add to, the same reasoning as the rest of the MCP surface.

### Manuscript ingestion (`src/routes/manuscript.ts`, `src/services/manuscriptIngest.ts`)

`POST /api/v1/manuscript/chunks` — `{ userId, bookId, chapterNumber, rawText, startingSceneOrder? }`

Groups `rawText` into ~180-word paragraph-aligned chunks
(`chunkManuscriptText`), embeds each via `generateEmbedding()`, and stores
them with auto-incrementing `scene_order` (continuing from whatever's
already stored for that book+chapter unless `startingSceneOrder` is given).
This is what keeps Layer 3's "Deep Past" memory growing automatically as a
manuscript is written — call it whenever a scene/chapter is finished (or
once AI-generated prose from `/generate-prose` is accepted) so future
generations can recall it.

Chunks within one chapter are embedded and stored in concurrent batches
of `INGEST_BATCH_SIZE` (8), not one at a time — `scene_order` is assigned
to every chunk up front, before any async work starts, so ordering stays
correct regardless of which embed+insert call happens to finish first.
Was fully sequential originally: for a full chapter (20-40+ chunks) that
meant the same number of sequential round trips to OpenAI *and* Supabase
in one request, slow enough (~4s+ for embeddings alone on a 20-chunk
chapter, measured; slower still with the per-chunk insert also in the
critical path) to plausibly exceed an MCP tool call's timeout — making a
live, reachable server look "unreachable" to Claude when `save_manuscript_
scene` tried to save a real chapter. Batched rather than fully unbounded
so a very long chapter's chunks don't all fire at OpenAI in one burst.

`POST /api/v1/manuscript/save-scene` — `{ userId, bookId, chapterNumber, rawText }`

The "accept this scene" endpoint: runs the same chunk/embed/store pipeline
as `/manuscript/chunks` above, **and** appends `rawText` to that chapter's
`manuscript_chapters.paragraphs` (creating the chapter row if it doesn't
exist yet), so an accepted scene lands in both Deep Past retrieval memory
and the editor the writer actually sees, in one call. Appends rather than
replaces existing editor content, so it never overwrites anything the
writer was editing themselves. Shared implementation with the MCP server's
`save_manuscript_scene` tool — both call `saveManuscriptScene` in
`src/services/manuscriptSceneSave.ts` — so this is also the endpoint the
Chat Assistant's `propose_save_manuscript_scene` confirm step calls once
the writer approves it.

`chunkManuscriptText` splits on blank-line paragraph breaks first; any
resulting block still more than 2x the target chunk size (e.g. a whole
chapter pasted with single line breaks and no blank lines at all) is force-
split further via `splitOversizedBlock` — single newlines, then sentence
boundaries, then hard word-count slicing as a last resort — so a chunk can
never balloon into an entire chapter regardless of input formatting.

`POST /api/v1/manuscript/bulk-import` — `{ userId, bookId, rawText }`

Imports a whole manuscript in one call. `splitIntoChapters` detects
"Chapter N" header lines (digits, spelled-out up to twenty, optional title
after a colon/dash) and splits `rawText` into per-chapter blocks; content
before the first detected header is dropped. Each detected chapter is then
run through the same chunk/embed/store pipeline as `/manuscript/chunks`.
If no headers are found, the whole input is imported as a single chapter.
Chapters are processed sequentially in one request, which is fine for
testing and small manuscripts, but risks a request timeout on anything
long — for that, use the resumable job-based import below instead.

#### Resumable bulk import (background job)

For large manuscripts, `/manuscript/bulk-import` above is superseded by a
step-based job that processes one chapter per HTTP call instead of the
whole manuscript in one request — this is what makes a very long import
safe on a platform like Render's free tier, which has no separate worker
process and spins down without incoming traffic: every request stays
short (one chapter), progress is persisted to Postgres after each step, and
the client (not a server-side timer) drives the next step by polling, which
also happens to keep the instance's inbound traffic alive for the whole
import.

- `POST /api/v1/manuscript/bulk-import/jobs` — `{ userId, bookId, rawText }`.
  Splits `rawText` into chapters (same `splitIntoChapters` as above),
  creates a `manuscript_import_jobs` row (`status: 'pending'`), and inserts
  each chapter's full text as its own row in
  `manuscript_import_job_chapters`. No embedding calls happen here, so this
  returns immediately regardless of manuscript size. Chapter text is kept
  out of the job row itself — an earlier version stored it inline as JSONB
  on the job, which meant every subsequent step re-fetched (and
  re-returned) the *entire remaining manuscript* on every call, a cost that
  grew with manuscript size instead of staying flat per step and caused
  failures partway through long imports. Splitting it into a child table
  means each step only ever touches the one chapter row it's processing.
- `POST /api/v1/manuscript/bulk-import/jobs/:jobId/step` — chunks, embeds,
  and stores exactly one chapter (the row at `next_chapter_index`), then
  advances the index and returns updated progress. Call this repeatedly —
  once per HTTP request — until `status` is `'done'`. A `'failed'` job is
  not terminal: `next_chapter_index` was never advanced past the chapter
  that failed, so stepping a failed job retries that same chapter, which
  is what makes retrying safe after a transient error (rate limit, network
  blip) instead of losing the whole import.
- `GET /api/v1/manuscript/bulk-import/jobs/:jobId` — read-only status
  check, does not advance the job.

Defined in `src/services/manuscriptImportJob.ts` /
`manuscript_import_jobs` + `manuscript_import_job_chapters` (migrations
`003_manuscript_import_jobs.sql` and `004_import_job_chapters.sql`). Not
safe against two callers stepping the same job concurrently (no row-level
claim/lock) — fine while the only caller is a single sequential poller.

### Manuscript Chapters — rich-editor persistence (`src/routes/manuscriptChapters.ts`)

The editor's actual save path — everything above (`/manuscript/chunks`,
`/manuscript/bulk-import*`) writes directly to the RAG-optimized
`manuscript_chunks` index. This is the separate CRUD surface for the
chapter content itself (see the `manuscript_chapters`/`manuscript_parts`/
`manuscript_scenes` schema above for why the two are deliberately not the
same table).

**Parts:**
- `GET /api/v1/manuscript/parts?bookId=`
- `POST /api/v1/manuscript/parts` — `{ bookId, title, orderIndex? }`
- `PATCH /api/v1/manuscript/parts/:id`
- `DELETE /api/v1/manuscript/parts/:id` — chapters referencing this part
  have `part_id` set to `NULL`, never deleted as a side effect

**Chapters:**
- `GET /api/v1/manuscript/chapters?bookId=` — metadata only (no
  `paragraphs`), for a chapter list/navigation view
- `GET /api/v1/manuscript/chapters/:id` — full content (including
  `paragraphs`) plus its scene markers
- `POST /api/v1/manuscript/chapters` — `{ userId, bookId, number, partId?,
  title?, heading?, complete?, paragraphs? }`; `number` must be unique per
  book (409 on conflict)
- `PATCH /api/v1/manuscript/chapters/:id` — the editor's autosave
  endpoint. Deliberately cheap: it only ever writes this one row, never
  touches `manuscript_chunks` or makes an embedding call, so autosaving on
  every keystroke/pause costs nothing beyond a normal database write.
  Bumps `content_updated_at` only when `paragraphs` is actually part of
  the patch — a title/heading/complete/part-only edit never moves it
- `DELETE /api/v1/manuscript/chapters/:id` — deletes this chapter's editor
  content, its scene markers and beats (`ON DELETE CASCADE` via their FKs
  to `manuscript_chapters`), **and** its `manuscript_chunks` (Deep Past
  retrieval memory), which is deleted explicitly since it has no FK to
  cascade through — matched by `book_id` + chapter `number` instead.
  Deliberately **not** treated like `DELETE /books/:id`'s non-cascading
  behavior: that choice exists to stop a shallow "delete this project"
  action from silently wiping independent data underneath it (Codex,
  notes, etc.), but a chapter's chunks aren't independent data — they're
  a derived RAG index of that exact chapter's content, so leaving them
  behind would let deleted prose keep quietly influencing future
  generations

**Sync to memory:**
- `POST /api/v1/manuscript/chapters/:id/sync-to-memory` — the explicit,
  writer-triggered bridge from this chapter's editor content into Layer
  2/3 retrieval memory. Joins the chapter's current `paragraphs` into
  plain text, **deletes** any existing `manuscript_chunks` rows for that
  `book_id` + chapter `number`, then re-runs the normal chunk/embed/store
  pipeline (`ingestManuscriptText`) against the fresh text — replacing
  rather than appending, so re-syncing an edited chapter can never leave
  stale/duplicate chunks from a previous draft sitting in memory alongside
  the current one. Sets `synced_to_memory_at`. Deliberately not automatic
  on every autosave — an "Accept into manuscript memory"-style writer
  action, since every keystroke triggering a fresh embedding pass would be
  wasteful and would spam `manuscript_chunks` with in-progress drafts.
  **Guards against redundant resyncs server-side, not just via a UI
  hint**: if the chapter was already synced and `content_updated_at`
  hasn't moved past `synced_to_memory_at` since (i.e. no real paragraph
  edit happened after the last sync), this is a no-op — returns `200
  { alreadySynced: true, syncedAt }` instead of re-running the embed
  pipeline. A genuine edit re-enables it: the next `PATCH` that includes
  `paragraphs` bumps `content_updated_at` past `synced_to_memory_at`, and
  the next sync call proceeds normally with `201 { chunks, syncedAt }`.

**Scenes:**
- `GET /api/v1/manuscript/chapters/:chapterId/scenes`
- `POST /api/v1/manuscript/chapters/:chapterId/scenes` — `{ title, orderIndex? }`
- `PATCH /api/v1/manuscript/scenes/:id`
- `DELETE /api/v1/manuscript/scenes/:id`

**Beats** — see Outliner below for the full feature; these are the
per-chapter CRUD endpoints (e.g. for the editor's own "Outline" side-panel
tab):
- `GET /api/v1/manuscript/chapters/:chapterId/beats`
- `POST /api/v1/manuscript/chapters/:chapterId/beats` — `{ title, outlineText?, orderIndex?, status? }`
- `PATCH /api/v1/manuscript/beats/:id` — `title`/`outlineText`/`orderIndex`/`status`/`linkedToManuscript`
- `DELETE /api/v1/manuscript/beats/:id`

## Outliner

Acts → Chapters → Beats — the structural planning layer above the
manuscript itself, where a writer plans what a chapter is going to do
before writing or generating it.

**Acts and Chapters already existed** — Acts are just `manuscript_parts`
(already a generic ordered grouping with `title`/`order_index`; "Act I",
"Act II" is simply what a writer names a part) and Chapters are
`manuscript_chapters`, already the same row the writing page opens and
edits. Nothing new was needed for either.

**Beats are the genuinely new piece** (`chapter_beats`, migration
`020_chapter_beats.sql`) — an outline card under a chapter: a title, an
`outline_text` (what the writer plans happens in this beat), a `status`
(`not_started` / `planned` / `in_progress` / `completed`), and
`linked_to_manuscript` (flips true once the beat's accepted prose has
been written into the chapter — a simple flag rather than a tracked
paragraph range, since precise range-linking is a bigger feature than a
first version needs).

**Two views over the same data, not two features**: `GET
/api/v1/outline/beats?bookId=` (`src/routes/outline.ts`) returns
everything needed for the full-book board — every `manuscript_parts` row,
every chapter's metadata, and every beat across the book, all flat rather
than deeply nested (the same convention as `GET /manuscript/chapters/:id`
returning `{ chapter, scenes }` separately) — the frontend groups beats
under chapters under parts itself. `GET
/manuscript/chapters/:chapterId/beats` is the same underlying table
filtered to one chapter, for the editor's own "Outline" side-panel tab
showing just the open chapter's beats. Deliberately built as one table
with two query shapes rather than two separate backends for what's really
the same data viewed at two zoom levels.

**Feeds generation directly**: `/generate-prose` and
`/generate-prose/preview` now accept an optional `beatId` alongside (or
instead of) `userSceneBeat` — when present and no explicit `userSceneBeat`
is given, the beat's `outline_text` is pulled and used as the scene beat.
An explicit `userSceneBeat` still wins over `beatId` when both are sent,
so a writer can paste a one-off tweak without editing the saved beat.
This is a real shift from before: a beat card the writer already filled
in becomes the generation input directly, rather than requiring the scene
beat to be retyped or pasted into the generation form on every call. Beat
granularity also matches the project's own established finding that
Hanami's scope discipline holds up best around one beat/paragraph per
call (see the MCP Server section's supervised-drafting findings) — this
is a natural unit to generate from, not an arbitrary one.

Not automatically marked `linked_to_manuscript` by `/generate-prose`
itself — that endpoint only returns prose, it never writes to
`manuscript_chapters`. Setting the flag is a writer/frontend action taken
once generated prose is actually accepted into the chapter.

## Chat Assistant

`/chat` (`src/routes/chat.ts`, `src/services/chatAssistant.ts`) is the
in-app "AI Assistant" surface — a persona-based chat backed directly by
the Anthropic API, distinct from both Hanami (`/generate-prose`, prose
generation) and the MCP server (Claude as an *external* connected client,
e.g. Claude Desktop). This is a real embedded chat inside the product
itself.

**Why a separate surface from MCP, even though both give Claude access to
the same book data**: MCP is designed for an external client holding its
own session (a human driving Claude Desktop/claude.ai, deciding turn by
turn whether to call a write tool). An in-app chat panel has no such
external client — the backend itself has to run the model call and any
tool calls synchronously within one HTTP request/response. Reusing MCP's
transport for that would mean standing up an internal MCP client just to
talk to an MCP server in the same process, for no real benefit. Instead,
`chatAssistant.ts` calls the Anthropic API directly with native
tool-calling, running its own request/response loop.

**Read tools**: `list_codex_entries`, `get_codex_entry`, `search_manuscript`,
`get_manuscript_chapter`, `list_world_categories`, `list_notes`.

**Write tools are propose-only, deliberately** —
`propose_create_codex_entry`, `propose_update_codex_entry`,
`propose_create_world_category`, `propose_create_note`,
`propose_save_manuscript_scene` (mirrors the MCP server's write-tool set).
The MCP server's write tools are safe *because* a human is actively
directing each write in real time via conversation; this loop instead
runs several tool calls autonomously within a single turn with no
confirmation in between, so a tool that directly wrote to the Codex here
would mean unsupervised writes — exactly what every write tool elsewhere
in this project has been built to avoid. Calling a `propose_*` tool does
**not** touch Supabase at all (`proposalAck` in `chatAssistant.ts`) — it
just validates the shape Claude sent and returns an acknowledgment;
the actual proposed payload is only ever recorded in
`chat_messages.tool_calls`, the same transparency log every tool call
already gets. The real write happens later, outside the loop entirely:
the frontend reads a `propose_*` entry off the assistant message's
`tool_calls`, renders a Confirm/Reject card, and — only if the writer
confirms — calls the real, already-validated CRUD endpoint directly
(`POST/PATCH /api/v1/codex`, `POST /api/v1/world-categories`, `POST
/api/v1/notes`, or `POST /api/v1/manuscript/save-scene`) with that exact
payload. This is why the `propose_*` tool schemas stay loose (a `fields:
object` passthrough for Codex entries rather than an exhaustively
enumerated schema) — the schema doesn't need to be the source of truth
for what's valid, because nothing executes off it directly; the CRUD
endpoint it eventually calls already enforces that, so there's no second
copy of Codex's field list to drift out of sync with the first (see the
Codex field-list sync note below for why that drift risk is taken
seriously here).

`propose_save_manuscript_scene` and the MCP server's `save_manuscript_scene`
share one implementation, `saveManuscriptScene` in
`src/services/manuscriptSceneSave.ts` (also exposed directly as `POST
/api/v1/manuscript/save-scene` for the frontend's confirm step to call) —
chunks+embeds the text into `manuscript_chunks` and appends it to the
chapter's `manuscript_chapters.paragraphs`, creating the chapter row if
needed. One implementation two callers reach, not two independently
maintained copies of the same combined ingest-plus-editor-append logic.

**Shared query layer, not duplicated logic**: `list_codex_entries`,
`get_codex_entry`, `search_manuscript`, and `get_manuscript_chapter`'s
actual queries live in `src/services/bookContextTools.ts`; `list_notes`
reuses `listNotesForBook` (`src/routes/notes.ts`) and `list_world_categories`
reuses `listWorldCategories` (`src/routes/worldCategories.ts`). The MCP
server's equivalent tools call the exact same functions. Two LLM-facing
surfaces independently reimplementing "how do I look up this book's
Codex" is exactly the kind of drift this project has caught and fixed
before (see the Codex field-list sync note under MCP Server below).

**Personas** (`ChatPersona` in `src/types/domain.ts`) — `general`,
`story_assistant`, `character_coach`, `worldbuilding_guide`,
`writing_editor`, `brainstormer`. Each is the same underlying loop and
the same tool access; only the system prompt's specialization instruction
changes (`PERSONA_INSTRUCTIONS` in `chatAssistant.ts`). A session is
locked to the persona it was created with — set once via `POST /chat`
without a `sessionId`, then implied by `sessionId` on every later message
in that conversation.

**Tool-call transparency**: every assistant message stores which tools it
called and with what input (`chat_messages.tool_calls`) — the same
"show what actually happened" principle as the Ghost Editor correction
report and `record_scene_draft_iteration`'s automatic diff.

**Not for writing manuscript prose** — the system prompt explicitly tells
the assistant this chat is for discussion/brainstorming/advice, and to
point the writer at the normal generation flow if they want actual prose
written. Keeps this surface's job distinct from Hanami's and from the MCP
server's `generate_prose_direct`/scene-draft-session tools.

**Endpoints:**
- `POST /api/v1/chat` — `{ userId, bookId, sessionId?, persona?, message }`.
  Creates a new session (with `persona`, default `general`) if `sessionId`
  is omitted; otherwise appends to the existing session, ignoring `persona`
  (a session keeps the persona it was created with). Runs the full
  tool-calling loop synchronously and returns the finished reply — not
  streamed, since a turn can involve several tool round trips before a
  final answer, unlike Hanami's single-pass stream. Response:
  `{ sessionId, message: <chat_messages row> }`.
- `GET /api/v1/chat/sessions?bookId=&userId=` — list conversations for a
  book, most recently updated first (the "Recent Conversations" list).
- `GET /api/v1/chat/sessions/:id` — full message history, for resuming or
  viewing a past conversation.
- `PATCH /api/v1/chat/sessions/:id` — rename (`{ title }`).
- `DELETE /api/v1/chat/sessions/:id` — deletes the session and its
  messages (cascades).

**Requires `ANTHROPIC_API_KEY`** (and optionally `ANTHROPIC_MODEL`,
default `claude-sonnet-5`) in the environment — a new env var this
feature introduces; not required by anything else in this backend (Hanami
generation uses `INFERMATIC_API_KEY`/`INFERMATIC_BASE_URL` instead). Every
`/chat` call fails clearly (502, "Missing required environment variable")
if unset, rather than silently.

**Safety cap**: `MAX_TOOL_ITERATIONS = 6` in `chatAssistant.ts` — if the
assistant is still calling tools after 6 rounds without producing a final
answer, the turn fails with a clear error rather than looping
indefinitely or silently truncating.

## MCP Server

`/mcp` (`src/routes/mcp.ts`, `src/mcp/tools.ts`) exposes this book's Codex
and manuscript memory to any MCP client — in practice, Claude connected via
a custom connector for brainstorming sessions with the writer.

**Why this exists**: Hanami has no content guardrails but a small (32k)
context window and no judgment — it only ever sees what the automatic
Layer 1/2/3 pipeline finds, bounded by the 6,000-token budget. Claude has
much more context and real reasoning, but won't write the content this
platform needs. The MCP server lets Claude do the understanding — reading
broadly across the Codex and manuscript, catching inconsistencies a single
similarity search can't, brainstorming with the writer — while Hanami
stays purely an execution engine that writes from exactly what it's given.

**The handoff problem this solves**: if Claude only passed a scene beat
to the normal `/generate-prose` pipeline, Hanami would just run its own
automatic retrieval again and Claude's richer understanding would never
reach it. `generate_prose_direct` exists specifically to close that gap —
it skips Layer 1/2/3 entirely and sends Hanami exactly the context Claude
(and the writer, in conversation) already compiled.

**Supervised drafting, not just a single handoff**: a single
`generate_prose_direct` call accepts whatever Hanami returns on the first
try. The `*_scene_draft_session` tools let Claude instead supervise —
generate, check the draft against the plot points agreed on in
brainstorming, redirect with a sharper instruction (the same MUST/MUST
NOT and `(bracketed)` beat-note conventions `/generate-prose` uses),
regenerate — across as many passes as it takes, pausing to check in with
the writer periodically rather than looping unsupervised. Progress
(current draft, plot-point checklist, open issues, and a full pass-by-pass
log) is persisted in `scene_draft_sessions`/`scene_draft_iterations`
(migration `011_scene_draft_sessions.sql`) specifically so a session
survives past the conversation that started it — closing it, coming back
later, even in a different Claude session, and resuming exactly where it
left off via `get_scene_draft_session`. The iteration log is also the
transparency mechanism: the writer can see exactly what instruction
produced each draft and why Claude redirected it, not just a final
summary.

**Every Hanami call is stateless — deliberately not a persistent chat
session.** `generateHanamiProse`/`streamHanamiProse` send exactly one
system message and one user message per call; Hanami has no memory of
any previous call, including its own prior drafts. A true multi-turn
session (replaying the full growing conversation on every revision) was
considered and rejected: it would resend the entire prior conversation —
compiled context plus every previous draft — on each successive pass,
growing fast enough to crowd out the 6,000+100 budget and the generation
itself within a few revisions, without making Hanami any better at
self-correcting (it still has no judgment, whether or not it can "see"
its own prior text — and models tend to anchor on a flawed prior attempt
rather than genuinely re-approach it). A fresh, sharply-worded instruction
each call — the same MUST/MUST NOT and recency-reinforcement techniques
already used elsewhere — is both cheaper and more reliable. The practical
continuity a real session would have given Hanami (seeing its own last
draft) is still available at a fraction of the cost: `generate_prose_direct`
and `record_scene_draft_iteration`'s tool descriptions both instruct
Claude to paste the current draft verbatim into the next call when
revising, rather than relying on memory Hanami doesn't have.

**Findings from the first real supervised session** (10 real iterations
against a live book, not synthetic testing): the workflow held up, but
surfaced two real gaps and confirmed two Hanami behavior patterns worth
knowing.

Gaps, both addressed by `diff_drafts` (`src/lib/textDiff.ts`, word-level
diff, `{-removed-}` / `{+added+}` format via the `diff` package):
- Hanami silently dropped a clause during a revision pass, and nothing
  caught it except a human manually re-reading the full draft — slow and
  easy to miss. `record_scene_draft_iteration` now automatically diffs
  the new draft against the one before it and returns `diffFromPrevious`
  in its response, so a silent drop is visible the moment the pass is
  logged, not just if someone thinks to check.
- Resuming a session meant reading critique text but not seeing the
  actual before/after of each pass. `get_scene_draft_session` now
  includes `diffFromPrevious` on every iteration (computed from the
  already-stored draft texts, nothing new persisted) — resuming shows
  real history, not just a summary.
- Deliberately *not* built: a server-side check that inspects `draftText`
  and second-guesses whether a claimed `satisfiedPlotPoints` entry is
  "really" there. That's Claude's judgment to exercise, not something to
  fake with keyword/semantic heuristics the tool can't actually back up —
  the same principle that's kept Hanami's own role honest all along.
  Surfacing the diff automatically closes the practical gap instead:
  the miss got caught by manual comparison once; an unmissable diff at
  the point of logging is what makes that reliable instead of lucky.

Hanami behavior patterns, folded into `generate_prose_direct`'s tool
description since they're operating knowledge Claude should carry in
rather than rediscover per project:
- Scope discipline degrades sharply past roughly one paragraph per call
  — a multi-paragraph pass is meaningfully more likely to drop or alter
  content outside the intended change than a single-paragraph pass.
- It invents small unestablished physical details (a scar, an object, an
  expression) even under a general "avoid embellishment" instruction —
  avoiding this needs to be explicit and specific nearly every call, not
  assumed as default behavior.
- Neither is 100% reliable even at narrow scope — a leak into a
  supposedly untouched paragraph happened once even at single-paragraph
  scope — which is exactly why diffing the result matters more than
  trusting the scoped instruction was followed.

Also surfaced, but not a tool/code issue: thin Codex coverage for
secondary characters central to a book's arcs means the automatic Layer 1
pipeline has nothing to inject for them regardless of retrieval quality —
a data-entry gap the writer/Claude needs to close via `create_codex_entry`,
not something a retrieval or prompting fix can compensate for.

### Tools

Read (safe to call freely):
- `list_codex_entries` — `{ bookId, entryType? }`
- `get_codex_entry` — `{ entryId }` — full record, not just what Layer 1 injects
- `search_manuscript` — `{ bookId, query }` — up to 8 ranked matches, no
  relevance threshold applied (unlike Layer 3) — Claude applies its own
  judgment, and can call this repeatedly with different phrasing rather
  than being limited to one shot the way the automatic pipeline is
- `get_manuscript_chapter` — `{ bookId, chapterNumber }` — literal chapter
  text, for when a similarity-matched excerpt isn't enough
- `preview_automatic_context` — `{ userId, bookId, sceneBeat }` — runs the
  same Layer 1/2/3 compilation `/generate-prose` would use, as a reference
  point before deciding whether Claude can do better
- `list_world_categories` — `{ bookId }` — every worldbuilding category
  for a book, including derived ones (see World Categories CRUD above);
  check this before guessing an `entryType`
- `list_notes` — `{ bookId, category? }` — a book's brainstorming notes,
  pinned first then most recently updated
- `list_agent_prompts` — `{ bookId }` — every Planning Engine agent
  role/stage's CURRENTLY ACTIVE prompt (see `agent_prompts` above),
  compact: id/role/stage/version/model/effort/authoredBy plus a short
  truncated preview of each prompt's text, not the full text — cheap to
  call broadly before narrowing in with `get_agent_prompt`
- `get_agent_prompt` — `{ promptId }` — one specific version's full,
  untruncated `systemPrompt`/`userPromptTemplate` text, by id
- `get_platform_craft_notes` — `{ bookId }` — this book's saved Platform
  Craft Notes (trending tropes/tags, hook/pacing conventions, common
  rejection reasons for serialized-fiction platforms like GoodNovel — see
  Platform Craft Notes above), plus the app's own research-job draft
  state. Read this before proposing an update so a save extends the
  existing notes rather than silently discarding them

Write (mirror the Codex CRUD routes' full field set — every optional
column `PATCH /api/v1/codex/:id` accepts, including `characterArc`, kept
in sync via a shared field list in `tools.ts` so a field present on one
path and missing from the other can't silently fail to save again; only
meant to be called when the writer has actively confirmed the change in
the conversation, never speculatively — nothing here should ever write
unsupervised):
- `create_codex_entry`, `update_codex_entry`
- `create_world_category` — `{ bookId, name, key?, description?, color?,
  icon? }`, same auto-slugify behavior as `POST /api/v1/world-categories`
- `create_note` — `{ userId, bookId, title, excerpt, category, pinned? }`
  — only call when the writer has actually asked something be jotted
  down, not as a running log of the conversation
- `save_manuscript_scene` — ingests accepted prose into permanent
  manuscript memory and appends it to the chapter's editor content via
  `saveManuscriptScene` (`src/services/manuscriptSceneSave.ts`), so it's
  there for future generations (Claude-assisted or automatic) and visible
  in the editor too — same shared function `POST /api/v1/manuscript/save-scene`
  and the Chat Assistant's `propose_save_manuscript_scene` confirm step call
- `update_agent_prompt` — `{ bookId, agentRole, stage, systemPrompt?,
  userPromptTemplate? }` — lets a writer iterate on a Planning Engine
  prompt conversationally (discuss it, land on wording, then have Claude
  actually apply it) instead of only through the Prompt Editor UI. Always
  creates a genuinely new version and activates it immediately — never an
  in-place overwrite — tagged `authoredBy: "claude"`, exactly like the
  writer saving an edit in the UI themselves; the previous version is
  deactivated but never deleted, so it stays inspectable and instantly
  restorable. **Cannot change `model` or `effort`** — those aren't
  exposed as tool parameters at all; the new version always inherits
  whatever the current active version already uses. This is deliberate:
  `model`/`effort` are operational/cost settings (which real model runs,
  at what thinking effort, i.e. what it costs per call), not prompt
  *content* — keeping them out of this tool's reach means a chat
  conversation about wording can never accidentally escalate a role to a
  more expensive model or effort level; that stays writer-controlled
  through the Prompt Editor UI only. Omitting `systemPrompt` or
  `userPromptTemplate` carries that half over unchanged from the current
  active version, so a small wording tweak to just one half doesn't
  require resending the other
- `activate_agent_prompt_version` — `{ promptId }` — instantly reverts to
  an older, currently-inactive version (deactivating whatever's active
  now) with no retyping — the undo for a chat-driven `update_agent_prompt`
  change that didn't work out. Touches only which version is active,
  never any version's actual text/model/effort
- `update_platform_craft_notes` — `{ bookId, content }` — saves this
  book's Platform Craft Notes after the writer has Claude research
  current platform trends conversationally (using the MCP session's own
  live web access), a parallel path to the app's own automated
  `platform_researcher` research pass — see Platform Craft Notes above.
  `content` replaces the notes wholesale, same as the app's own save
  action, so the tool's description tells Claude to read the existing
  notes via `get_platform_craft_notes` first and send back the complete
  merged document, not just new findings alone

Generation:
- `generate_prose_direct` — `{ sceneBeat, compiledContext }` — see "the
  handoff problem" above. Buffers Hanami's full response and returns it
  as one result rather than streaming, since the caller is a tool result,
  not a live browser connection (`generateHanamiProse` in `llm.ts`).

Supervised drafting (see "Supervised drafting" above; state lives in
`scene_draft_sessions`/`scene_draft_iterations`, not conversation memory):
- `start_scene_draft_session` — `{ userId, bookId, sceneBeat, plotPoints, chapterNumber?, label? }`
  — plotPoints is the checklist from brainstorming; returns a sessionId
- `record_scene_draft_iteration` — `{ sessionId, draftText, instructionsGiven?, critique?, satisfiedPlotPoints?, openIssues? }`
  — call after every `generate_prose_direct` pass made as part of a
  session, not just the final one; `openIssues` replaces the previous
  list rather than appending; response includes `diffFromPrevious`
  (automatic word-level diff against the prior draft)
- `diff_drafts` — `{ oldText, newText }` — standalone word-level diff for
  any comparison outside the automatic one above (e.g. verifying a
  supposedly-untouched paragraph really wasn't touched)
- `get_scene_draft_session` — `{ sessionId }` — current state plus the
  full pass-by-pass history, each iteration including `diffFromPrevious`
  against the pass before it, for resuming
- `list_scene_draft_sessions` — `{ bookId, status? }` — most recently
  updated first, for finding a session to resume
- `finish_scene_draft_session` — `{ sessionId, finalDraft? }` — marks a
  session done; deliberately does not call `save_manuscript_scene` itself,
  since "Claude and the writer are satisfied with this draft" and "the
  writer has accepted it into canon" are different moments

### Auth

Every request needs `Authorization: Bearer <MCP_API_KEY>` — checked in
`requireMcpAuth`. Unlike the rest of this API (which has no auth at all,
fine for a local test harness), this surface is reachable from the public
internet by whatever MCP client connects to it and grants read/write
access to real data, so it can't be left open. Not full OAuth — a shared
secret is enough for a single-user tool at this stage.

### Session handling

Stateful, one `McpServer` + `StreamableHTTPServerTransport` pair per
session, held in an in-memory map keyed by `Mcp-Session-Id`. Fine for a
single Render instance with no horizontal scaling; would need to move to
a shared store if that ever changes.

Every deploy restarts the process and wipes this map — any conversation
whose session predates the deploy now carries a session ID the server no
longer recognizes. A session ID that's present but unrecognized returns
**404** ("Session not found"), not 400 — per the MCP Streamable HTTP
spec, 404 on a session-bearing request is the signal a well-behaved
client uses to silently discard the session and re-initialize, whereas
400 reads as a generic, unrecoverable error. These used to be collapsed
into one 400 response for both "session expired" and "genuinely
malformed request," which left a client with no way to tell "just
reconnect" from "something is broken" — diagnosed after every MCP tool
call started failing for an active writer mid-session, surviving even a
manual connector toggle, confirmed by testing the exact same request
directly against production: a fresh `initialize` + `tools/call` worked
immediately, proving the server itself was healthy and the problem was
specifically the client having no recovery signal for a stale session.

## Planning Engine

A pre-writing pipeline — Stage 1 Core Summary, then a strict, incremental
**Act → Part → Beats hierarchy** — with a 4-agent Scrutiny Panel
(Continuity Critic, Pacing & Chapter-Economy Critic, Craft & Suspense
Critic, Arbitrator) and a mandatory human review gate at every unit.
Entirely separate from manuscript drafting: nothing in this pipeline ever
writes prose. "Generator" here means planning text — summaries, outlines,
beat lists — never manuscript prose, which stays exclusively Hanami's job
via the existing `/generate-prose` and MCP tools, unchanged by any of
this. Approved output feeds two systems that already exist: a Part's
approved beats become real `chapter_beats` rows (the same table backing
the Outliner), and an entity-extraction pass proposes Codex/World
Category entries for the writer to batch-review.

### Why a hierarchy, not one call per stage

The original design planned an entire book's Act structure — or an
entire book's Chapter Beats — in one Generator call. Confirmed live that
this is genuinely disastrous for continuity, not just a theoretical
risk: a real test (a heist book, six arcs, 600+ chapters planned in one
Stage 2 call) came back with the Continuity Critic catching the
artifact's own stated numbers contradicting each other — bearer-core
weights that didn't sum to the claimed total, a manifest-tolerance rule
stated one way early and violated later in the same document. A single
call planning that much material loses track of its own established
facts well before it reaches the end, even though everything is
technically still in its context window.

The fix: **3 fixed Acts, each with 3 fixed Parts (9 Parts total),
generated incrementally and gated at every step — the AI never decides
how many Acts or Parts a book gets, that structure is fixed regardless
of book length.** Each Act starts with a short, self-contained summary
(not a full outline). Each Part then gets a *detailed* outline —
expanding just that Act's relevant slice — and only that outline commits
to a real chapter range (`startChapter`/`endChapter`), which is the
first point in the hierarchy concrete enough to do so. A Part's Chapter
Beats are generated in bounded chunks (`PART_BEATS_CHAPTER_WINDOW`,
`src/services/planningEngine.ts` — currently 15 chapters per call, not
yet exposed via the API, a tunable constant like this project's other
not-yet-calibrated values such as Layer 3's match threshold), not the
whole Part at once, for the same reason whole-Act planning was replaced.
**Strict sequencing**: Part 2's outline can't start until Part 1's beats
are fully approved and materialized; Act 2's summary can't start until
all 3 of Act 1's Parts are done. Nothing plans further ahead of the book
than the writer has actually approved so far — which also means this
pipeline is meant to be worked alongside real drafting over weeks, not
finished in one sitting, picking back up wherever it was left.

`ACTS_PER_BOOK`/`PARTS_PER_ACT` (`src/types/domain.ts`) are both `3`,
plain constants, not model-decided or configurable per book.

### Three layers of context at every unit

Every Generator/Critic call gets, in addition to `BOOK_CONTEXT`
(existing Codex/facts):

1. **`BOOK_VISION`** — Stage 1's Core Summary, always the exact same
   value regardless of how deep into the hierarchy the current unit is.
   Deliberately *not* cascaded one hop at a time the way `PRIOR_STAGE_ARTIFACT`
   works for the Generator — if it were, the book's actual premise/
   ending-shape/theme would dilute by the time a call is several hops
   deep (e.g. Act 2 Part 3's beats). Every unit stays anchored to it
   directly.
2. **`PARENT_ARTIFACT`** — the immediate parent unit's approved content:
   an Act summary's parent is the Book Vision itself; a Part outline's
   parent is its Act's approved summary; a beats chunk's parent is its
   Part's approved outline.
3. **`CONTINUITY_LEDGER`** — a running list of hard facts (numbers,
   rules, established states) extracted after every approved beats
   chunk (see below), fed to the Generator *and* all three critics (the
   Continuity Critic in particular checks new content against it as its
   #1 priority, ahead of even Codex contradiction).

### The continuity ledger — reconciled against the real manuscript, not just the plan

Because a Part can be drafted weeks or months before the next Act's
summary gets written, a ledger built purely from what the *plan* claimed
would drift from what was actually written — reintroducing the same
contradiction problem the hierarchy exists to prevent, just one level
up (plan vs. reality instead of plan vs. itself). `appendLedgerFacts`
(`planningEngine.ts`), run automatically right after a beats chunk is
approved and materialized:

- For every chapter in the chunk, checks `manuscript_chapters.paragraphs`
  (the editor's real content — **not** `manuscript_chunks`, the separate,
  opt-in RAG index a chapter might not be synced to yet even once
  written) for real, non-empty drafted text.
- Where a chapter has real drafted content, extracts facts from *that* —
  ground truth. Where it doesn't, falls back to what the chunk's own
  beats claimed — the plan, since that's all there is yet.
- Calls the `ledger_extractor` agent role with both the reconciled
  per-chapter content and the existing ledger (so it doesn't re-extract
  duplicates), gets back a short JSON array of fact strings, and appends
  each as a `ContinuityLedgerEntry { fact, sourcedFrom: "plan"|"manuscript", unit }`
  to `planning_runs.continuity_ledger`. Never pruned within a run.

Auto-appended with **no separate review gate** — unlike Codex/World
Category entries, the ledger isn't new writer-facing canon; it's a
compressed memory of content (the beats chunk) that already went through
its own human review gate. The full ledger is visible in every
`GET /planning/runs/:id` response for inspection, just not a blocking
step.

### Entity extraction is now on-demand, not automatic

A real behavior change from the old flat model, where extraction
auto-fired once after the whole book's beats were approved and blocked
the pipeline on a review screen (`awaiting_entity_review`) before
finishing. Under the Act/Part hierarchy a Part can be approved months
before the next one, so tying extraction (and a forced review screen) to
*every* beats-chunk approval — potentially 9+ times per book — would be
real, unwanted friction. Instead `extractEntities` (exported, callable
whenever the writer wants via `POST .../entities/confirm`'s sibling
endpoint below) scans every approved beats chunk in the run so far.
Neither `extractEntities` nor `confirmEntities` touch the run's `status`
anymore — extraction/confirmation is a side action independent of the
run's actual pipeline position; an error extracting entities must never
make the run's real position look "failed."

### Every agent's behavior is prompt-driven, not hardcoded

Every `system_prompt`/`user_prompt_template` (plus `model` and `effort`)
is a row in `agent_prompts`, authored and owned by the writer via the
Prompt Editor, never written by this backend. Saving a new version
deactivates the previous one and activates the new one immediately — a
runtime change, not a redeploy. This backend supplies only the mechanics
that make those prompts actually run reliably: the unit-progression
loop, template interpolation, and a verify-don't-trust JSON parse with
one corrective retry (same principle as Ghost Editor already established
for banned terms).

**`max_tokens` is 16000 by default for every agent call, not lower —
confirmed live, not a hypothetical.** A real test against production
(Opus 5, effort `high`, a full-book `BOOK_CONTEXT`) spent its entire
budget on adaptive thinking before emitting any visible text, and
originally returned silently — an empty artifact saved with `status`
advancing normally, as if generation had actually succeeded. `callAgent`
now throws explicitly whenever a response comes back with no text
(`stop_reason` included in the error).

**No LangGraph.** A step-based job table (`planning_runs`) plus one short
HTTP call per step is the same pattern already proven in this project for
`manuscript_import_jobs` — every request is one bounded LLM call (or one
parallel trio for the three critics), so nothing risks a timeout on any
hosting tier regardless of pipeline complexity. The client polls/drives
the run forward step by step; nothing here holds state in memory between
requests. **Every unit** (Stage 1 Summary, each Act Summary, each Part
Outline, each Part's beats chunks) goes through the identical cycle:
`generate` → `critique` → `arbitrate` → `approve`/`reject`. The step
functions (`generateStage`/`runCritique`/`runArbitration`/`approveStage`/
etc.) are completely generic across every unit type — driven purely by
`current_stage` (which prompt/JSON-contract applies) and
`current_act`/`current_part`/`current_beat_chunk` (which specific unit
this is) — so adding, say, a 4th Act later would be a constant change,
not new code.

### `agent_prompts`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | |
| `book_id` | UUID NOT NULL | prompts are scoped per book, not global |
| `agent_role` | VARCHAR(50) NOT NULL | `generator` \| `continuity_critic` \| `pacing_critic` \| `craft_critic` \| `arbitrator_panel` \| `arbitrator_chat` \| `arbitrator_directive` \| `entity_extractor` \| `ledger_extractor` — the 3 critic roles are `CRITIC_ROLES` in `src/types/domain.ts`, not hardcoded call sites |
| `stage` | VARCHAR(50) NOT NULL | `stage_1_summary` \| `act_summary` \| `part_outline` \| `part_beats` \| `all` (a role whose prompt doesn't vary by stage — all 3 critics, `arbitrator_panel`, `entity_extractor`, `ledger_extractor`) \| `intake` (prompt-lookup only — never a run's real `current_stage`) |
| `version` | INT NOT NULL | auto-incremented per (book_id, agent_role, stage) on each save |
| `is_active` | BOOLEAN NOT NULL | exactly one active version per (book_id, agent_role, stage); `getActivePrompt` tries the exact stage first, then falls back to `stage = 'all'` |
| `system_prompt`, `user_prompt_template` | TEXT NOT NULL | 100% writer-authored; this backend contains none of the actual prompt content |
| `model` | VARCHAR(50) NOT NULL | e.g. `claude-opus-5`, `claude-sonnet-5` — a runtime setting per role/stage, not hardcoded |
| `effort` | VARCHAR(20) NOT NULL | `low` \| `medium` \| `high` \| `xhigh` \| `max` (`output_config.effort`) |
| `authored_by` | VARCHAR(20) NOT NULL | default `writer`; `writer` \| `claude` — lets the Prompt Editor warn before the writer edits over a Claude-authored version rather than one they wrote themselves |
| `created_at` | TIMESTAMPTZ | |

Added in migration `022_planning_engine.sql`. Managed via `GET/POST/PATCH/DELETE /api/v1/agent-prompts` (`src/services/agentPrompts.ts`, `src/routes/agentPrompts.ts`) and the "Planning Engine — Agent Prompt Editor" panel in the test UI. `DELETE` refuses to remove the active version of a role/stage.

**`agent_prompts` is scoped per `book_id`, not global** — a brand-new
book starts with zero rows. `POST /api/v1/agent-prompts/clone` —
`{ fromBookId, toBookId }` — copies every active prompt from one book to
another, each landing as a new active version via the normal
`createAgentPrompt` versioning path (safe to call even if the
destination already has some prompts). 404 if the source book has no
active prompts to clone; 400 if `fromBookId === toBookId`.

**Template placeholders** (`interpolateTemplate` in `agentPrompts.ts` — a `{{KEY}}` not present in a given template is simply left alone):

| Placeholder | Available to | Contents |
| --- | --- | --- |
| `{{BOOK_CONTEXT}}` | generator, continuity_critic, pacing_critic, craft_critic, entity_extractor | Book Facts (`get_book_facts`) + every current Codex entry |
| `{{BOOK_VISION}}` | generator, continuity_critic, pacing_critic, craft_critic, arbitrator_panel | Stage 1's approved Core Summary — always this exact value at every depth, never diluted by cascading one hop at a time. See "Three layers of context" above |
| `{{PARENT_ARTIFACT}}` | generator (act_summary, part_outline, part_beats only) | The immediate parent unit's approved content — see "Three layers of context" above |
| `{{CONTINUITY_LEDGER}}` | generator, continuity_critic, pacing_critic, craft_critic | Accumulated hard facts from every approved beats chunk so far, reconciled against the real manuscript wherever chapters have actually been drafted — see "The continuity ledger" above |
| `{{PREVIOUS_ARTIFACT}}` | generator | This *exact same unit's* own last draft — empty on a first generation, populated with the rejected draft when regenerating after a rejection. The Generator has no memory of its own prior output otherwise, the same statelessness Hanami has |
| `{{CHAPTER_RANGE}}` | generator (part_beats only) | Which specific chapter window this call must produce, plus the Part's full range for context |
| `{{FINAL_DELTA_DIRECTIVE}}` | generator | Set only when regenerating after a rejection; consumed once and cleared |
| `{{CURRENT_ARTIFACT}}` | continuity_critic, pacing_critic, craft_critic, arbitrator_panel, arbitrator_chat, arbitrator_directive | The artifact currently being reviewed/discussed |
| `{{PANEL_REVIEWS}}` | arbitrator_panel, arbitrator_chat, arbitrator_directive | All three critics' JSON output |
| `{{PREVIOUS_CRITIQUE}}` | continuity_critic, pacing_critic, craft_critic | This critic's *own* previous review of this same unit — empty on a first review, populated on a revision pass so the critic can mark its own prior issues resolved/unresolved instead of reviewing blind |
| `{{PREVIOUS_SYNTHESIS}}` | arbitrator_panel | The Arbitrator's *own* previous synthesis of this same unit |
| `{{CHAT_HISTORY}}` | arbitrator_directive | The writer's ENTIRE conversation with the Arbitrator so far — intake plus every rejection interview across the whole run, not just the current cycle |
| `{{CONTENT}}`, `{{EXISTING_LEDGER}}` | ledger_extractor | The reconciled per-chapter content to extract facts from, and the ledger so far (so it doesn't re-extract duplicates) |

**Two roles have a required output shape**, since their output gets parsed into real data, not just displayed:
- `generator` at `part_outline` must return JSON: `{"startChapter": N, "endChapter": M, "outline": "..."}` — this is what `approveStage` records into `part_chapter_ranges`.
- `generator` at `part_beats` must return JSON: `{"chapters": [{"chapterNumber": 1, "title": "...", "beats": [{"title": "...", "outlineText": "..."}]}]}` — this is what `materializeBeats` inserts into `manuscript_chapters`/`chapter_beats` on approval.
- `entity_extractor` must return a JSON array: `[{"type": "codex_entry" | "world_category", "name": "...", "entryType": "...", "description": "..."}]`.
- `ledger_extractor` must return a JSON array of plain strings.

All go through `callAgentForJson`, which retries once with a corrective nudge if the first response isn't valid JSON before failing loudly rather than silently storing garbage.

### `planning_runs`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | |
| `book_id`, `user_id` | UUID NOT NULL | |
| `current_stage` | VARCHAR(50) NOT NULL | default `stage_1_summary`; which prompt/JSON-contract applies right now — see `current_act`/`current_part`/`current_beat_chunk` for exactly which unit |
| `current_act` | SMALLINT | 1-3; null while `current_stage` is `stage_1_summary` or during intake |
| `current_part` | SMALLINT | 1-3; also null while `current_stage` is `act_summary` |
| `current_beat_chunk` | SMALLINT | only meaningful during `part_beats` — which window of the Part's chapter range is being generated right now |
| `part_chapter_ranges` | JSONB NOT NULL | keyed `"act-part"` (e.g. `"1-2"`); recorded once that Part's outline is approved: `{ startChapter, endChapter }` |
| `continuity_ledger` | JSONB NOT NULL | array of `{ fact, sourcedFrom, unit }` — see "The continuity ledger" above |
| `status` | VARCHAR(30) NOT NULL | default `intake_active`; `intake_active` \| `generating` \| `critiquing` \| `awaiting_arbitration` \| `awaiting_user_review` \| `user_chat_active` \| `done` \| `failed` |
| `stage_artifacts` | JSONB NOT NULL | keyed by **unit**, not stage type — `'stage_1_summary'`, `'act_1_summary'`, `'act_1_part_2_outline'`, `'act_1_part_2_beats_chunk_1'`, etc. (`unitKey()` in `planningEngine.ts`). A beats chunk gets its own key per chunk, not one accumulated key per Part — each chunk is independently reviewable and materializes independently |
| `panel_reviews` | JSONB | keyed by critic role (`CRITIC_ROLES`), whatever shape each critic's own prompt asks for. Also the previous-verdict source for `{{PREVIOUS_CRITIQUE}}` |
| `arbitrator_synthesis` | JSONB | |
| `stage_panel_history` | JSONB NOT NULL | keyed by unit (same keys as `stage_artifacts`); snapshot of that unit's `panel_reviews`/`arbitrator_synthesis` taken by `approveStage` right before they're cleared. What `unapproveStage` restores from |
| `chat_history` | JSONB NOT NULL | every rejection-interview turn across the WHOLE run, all units, concatenated — never reset |
| `intake_chat_history` | JSONB NOT NULL | the one-time pre-Stage-1 conversation; separate thread from `chat_history`. Not reset |
| `final_delta_directive` | TEXT | set by `finalize-directive` **or** `intake-finalize`, consumed by the next `generate` call, then cleared |
| `extracted_entities` | JSONB | candidates proposed by an on-demand `entities/extract` call, cleared once reviewed |
| `last_error` | TEXT | set when a main-pipeline step fails, alongside `status: 'failed'` — never set by the on-demand `entities/extract` action, which doesn't touch `status` |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Added in migration `022_planning_engine.sql`; `intake_chat_history`/`intake_active` default added in `023_planning_intake.sql`; the Act/Part hierarchy columns (`current_act`/`current_part`/`current_beat_chunk`/`part_chapter_ranges`/`continuity_ledger`) added in `026_planning_hierarchy.sql`, replacing the old flat `stage_2_acts`/`stage_3_beats` model — no backfill needed for existing runs, since `current_stage` has no `CHECK` constraint and a run already at `stage_1_summary` picks up the new hierarchy the moment it advances past Stage 1. `src/services/planningEngine.ts` / `src/routes/planning.ts`.

### Endpoints

- `POST /api/v1/planning/runs` — `{ bookId, userId }`, starts a run in the intake conversation (`status: intake_active`) — **not** Stage 1 generation yet
- `GET /api/v1/planning/runs?bookId=` — every run for a book, most recently updated first. Lets the frontend resolve "what's this book's current run" without depending on a run id surviving in a URL/local state
- `POST /api/v1/planning/runs/:id/intake-chat` — `{ message, documentBase64?, documentMediaType? }`, one turn of the pre-Stage-1 conversation; has the `web_fetch_20260209` server tool available, so a pasted URL gets actually read
- `POST /api/v1/planning/runs/:id/intake-finalize` — compiles the intake conversation into `final_delta_directive` and opens Stage 1 (`status -> generating`)
- `GET /api/v1/planning/runs/:id` — poll current state
- `POST /api/v1/planning/runs/:id/generate` — one Generator call for the current unit
- `POST /api/v1/planning/runs/:id/critique` — all of `CRITIC_ROLES` (Continuity, Pacing & Chapter-Economy, Craft & Suspense), fired in parallel in one request
- `POST /api/v1/planning/runs/:id/arbitrate` — Arbitrator panel-synthesis call, opens the human review gate. Optional `{ excludedCritics: string[], excludedIssues: { role: string; index: number }[] }` — `excludedCritics` drops a critic's entire review (score/summary/strengths/every issue); `excludedIssues` is the finer-grained sibling, dropping individual flagged issues inside an otherwise-included critique, addressed by the critic's role and that issue's index into its own `issues` array as last returned by `GET /planning/runs/:id` (stable until the next `/critique` regenerates it). Both filtered server-side against `CRITIC_ROLES` (and `index` to a non-negative integer) so a bad value can't silently no-op or throw deep in the service — see "Per-issue and per-critique inclusion" below
- `POST /api/v1/planning/runs/:id/approve` — the gate's approve action. On `part_outline`, records the Part's committed chapter range. On `part_beats`, also materializes the chunk into the Outliner and reconciles the continuity ledger. Advances to the next unit per the fixed Act→Part→Beats sequence, or marks the run `done` once all 3 Acts' 9 Parts are fully planned
- `POST /api/v1/planning/runs/:id/reject` — opens the Arbitrator chat interview
- `POST /api/v1/planning/runs/:id/unapprove` — undoes approving whatever unit came before the current one and reopens its rejection interview directly, restoring its `panel_reviews`/`arbitrator_synthesis` from `stage_panel_history`. `409` if the current unit already has its own generated artifact, or if there's no previous unit
- `POST /api/v1/planning/runs/:id/discard-stage` — trashes the CURRENT unit's draft outright (unlike `unapprove`, allowed even when one exists — that's the point) and falls back to the PREVIOUS unit's review gate, ready to re-approve into a genuinely fresh generation. No interview. `409` if there's no previous unit
- `POST /api/v1/planning/runs/:id/chat` — `{ message }`, one interview turn. Can auto-finalize (see "Auto-finalizing the rejection interview" below) — the returned run may already be back to `status: "generating"` with a fresh directive applied, not just an updated `chat_history`
- `POST /api/v1/planning/runs/:id/finalize-directive` — compiles the chat into one directive, loops back to `generate` for the same unit. Still exists as an explicit fallback for resuming a run where auto-finalize's signal was missed; the normal path is `/chat` triggering this itself
- `POST /api/v1/planning/runs/:id/apply-critique` — a second, zero-extra-LLM-call path to the same place `finalize-directive` reaches, for when the writer agrees with the Arbitrator's already-compiled synthesis and doesn't need a chat interview to get there. Takes the current `arbitrator_synthesis` (`mustFix` + `worthConsidering` from the last `/arbitrate` call) and formats it directly into a numbered checklist directive (`applyCritiqueDirectly` in `planningEngine.ts`) — the exact same shape `arbitrator_directive`'s own prompt now produces (see "Generator instruction-following" below) — then sets `status: "generating"` with that as `final_delta_directive`, same as `finalize-directive` does. 400 if there's no synthesis yet for this unit (arbitrate hasn't run) or if it has neither `mustFix` nor `worthConsidering` items to apply
- `POST /api/v1/planning/runs/:id/entities/extract` — on-demand, callable whenever the writer wants (not tied to any single beats-chunk approval — see "Entity extraction is now on-demand" above). Scans every approved beats chunk in the run so far. Does not touch `status`
- `POST /api/v1/planning/runs/:id/entities/confirm` — `{ approvedIndexes }`, writes only the approved candidates into `codex_entries`/`world_categories`; anything not listed is discarded, never written. Does not touch `status`
- `DELETE /api/v1/planning/runs/:id` — abandons the run's own bookkeeping row only; does not touch anything already materialized from it

### Generator instruction-following — checklist-verifiable directives, not prose

Real usage surfaced a genuine Generator reliability gap: on a revision pass,
the Generator would sometimes leave a `mustFix` item from the Arbitrator's
synthesis effectively untouched — sometimes literally unaddressed,
sometimes only superficially reworded — and a critic's own next review
would independently confirm the same item was still unresolved. The root
cause wasn't (only) the Generator ignoring instructions; it was that a
correction directive was, until this fix, a single free-form paragraph —
easy for a model to partially address and move on from, with nothing
forcing it to verify each distinct requested change actually landed,
unlike a critic's own `issues` array, where every item already carries an
explicit `resolved`/`unresolved` status the critic is required to set.

Two changes close this gap, both text-only (no new architecture):

- **Every correction directive is now a numbered checklist, not prose,
  regardless of which of the two paths produced it.** `arbitrator_directive`'s
  prompt (`stage: "all"`, used by `finalize-directive`) now requires its
  output to be a numbered list of discrete, individually-verifiable action
  items rather than a paragraph — the same shape `applyCritiqueDirectly`
  (see `apply-critique` above) already produces deterministically from
  `mustFix`/`worthConsidering` with no LLM call at all. Both paths now hand
  the Generator the exact same kind of directive.
- **Every Generator prompt's revision-mode instructions (`stage_1_summary`,
  `act_summary`, `part_outline`, `part_beats`, `codex_documentation`,
  `hook_chapters_outline`) now explicitly require treating the directive as
  a checklist**: go through it item by item and confirm each one is
  genuinely and fully resolved before returning — not superficially
  touched, partially addressed, or reworded without the substance actually
  changing — mirroring the resolved/unresolved discipline the critics
  already use on their own prior issues.

This is prompt engineering, not a code-level guarantee — nothing server-side
parses the Generator's output to verify compliance the way, say, the Ghost
Editor's paragraph-recheck loop does for banned terms. The next critique
pass remains the actual backstop: a critic explicitly re-checks its own
prior issues on every revision (`{{PREVIOUS_CRITIQUE}}`) and marks anything
still present `unresolved` rather than dropping it, so a Generator miss
surfaces again rather than silently passing.

`hook_chapters_outline` and `part_beats` also had their `outlineText` rules
strengthened specifically: this text is what a downstream prose generator
actually sees, so a vague label or euphemism here is simply missing
content later, not a style problem. Both now require a full, detailed
paragraph per beat — concretely who does what, what's physically
happening, what's actually said or revealed — explicitly banning
gesture-at-it phrasing ("things escalate," "she reveals something
shocking") and reaffirming that this platform doesn't sanitize dark or
explicit content regardless of how uncomfortable a vague phrasing might
feel to produce.

### Auto-finalizing the rejection interview

There used to be a manual "send directive and regenerate" action the writer
had to find and press once the chat interview reached agreement — an extra
step for something already settled in conversation. `chatTurn`
(`planningEngine.ts`) now auto-finalizes instead: the `arbitrator_chat`
prompt (`stage: "all"`) is instructed to end its reply with the literal
token `<<READY_TO_FINALIZE>>`, as the very last thing in the message and
nothing after it, but ONLY when both (1) it has already said plainly that
it understands the correction and (2) the writer's message it's replying to
is itself a clear go-ahead ("yes", "go ahead", "let's regenerate" — not a
continued description of the problem, and not the Arbitrator asking
permission). `chatTurn` detects the token, strips it before the message is
ever stored or shown to the writer, and — only when present — chains
straight into `finalizeDirective` for the same run, returning that result
instead of the plain chat-turn update. The same code-level marker-detection
pattern this project already uses for `<<DIRECTIVE: ...>>` tags (`llm.ts`)
and the `<<<GHOST_EDITOR_REPORT>>>` marker (`generateProse.ts`) — a
structural signal from the model, not a frontend heuristic guessing at
prose.

This is a real, accepted tradeoff, not a hidden one: a false-positive
trigger (the model deciding "ready" prematurely) costs one Generator call
that wouldn't otherwise have run — the same cost a manual button click would
have caused anyway, just without the writer's own click as the last gate.
`finalize-directive` is kept callable directly as a fallback for exactly
this kind of miss, and for resuming an older run.

### Per-issue and per-critique inclusion — letting the writer choose exactly what reaches the Arbitrator

Two independent granularities, both filtering `{{PANEL_REVIEWS}}` before a
given `/arbitrate` call — neither ever deletes anything from `panel_reviews`
itself, they only control what that one synthesis call actually reasons
from:

- **Per-issue** (`excludedIssues`) — the primary mechanism. Each individual
  flagged issue inside a critique panel (not the panel as a whole) carries
  its own checkbox, default checked. Unchecking one and sending
  `{ role, index }` for it in `excludedIssues` drops just that issue from
  the critic's `issues` array before `{{PANEL_REVIEWS}}` is built — the
  critic's `score`/`summary`/`strengths` and every issue the writer left
  checked still reach the Arbitrator normally. `index` is the issue's
  position in that critic's own `issues` array exactly as last returned by
  `GET /planning/runs/:id` — stable until the next `/critique` call
  regenerates the array, so an index read off a fresh fetch is always safe
  to send back.
- **Per-critique** (`excludedCritics`) — a coarser, all-or-nothing toggle
  for dropping one critic's entire review (score, summary, strengths, every
  issue) from a synthesis pass, independent of the per-issue mechanism
  above. Useful for "I don't trust this critic's read at all this time,"
  distinct from "most of what it flagged is right, but not this one item."

Either way, nothing an excluded critic or excluded issue said can surface
in that call's `mustFix`/`worthConsidering`/`whatWorks` even indirectly,
since the Arbitrator never sees it for that pass. Re-arbitrating with
everything included again picks it all back up — this only affects the one
`/arbitrate` call it's sent with, not any stored state.

**Every surviving issue is `mustFix`, regardless of severity.** This
checkbox filtering is what makes that the right rule, not an accident of
prompt wording: severity (critical/moderate/minor) is a critic's own
diagnostic framing of how bad a problem is, not a signal that the writer
wants it deprioritized — and by the time an issue reaches the Arbitrator,
the writer has already decided, one checkbox at a time, that it's worth
carrying forward. `arbitrator_panel` (all three stage variants — `all`,
`codex_documentation`, `hook_chapters_outline`) is explicitly instructed
to put every surviving issue into `mustFix` regardless of the critic's own
severity label, never sort moderate/minor ones into `worthConsidering`.
`worthConsidering` is reserved only for the Arbitrator's own optional
suggestions that aren't tied to any specific critic-flagged issue — a
genuine "you could also consider..." with nothing upstream backing it,
never a place a real finding quietly loses its urgency. The recommendation
gate moved with it: "revise" is recommended whenever `mustFix` is
non-empty at all, not only when a critical-severity item is present.

This closes a real compliance gap, not just a naming inconsistency: before
this, a moderate/minor issue landed in `worthConsidering`, and
`applyCritiqueDirectly`'s own formatting (see `apply-critique` above)
explicitly treats that list as lower-priority ("address these too where it
doesn't conflict with the must-fix items") — so the Generator had an
actual textual permission slip to deprioritize exactly the class of issue
a writer had just deliberately chosen to keep. A live case: minor/moderate
issues repeatedly came back marked `unresolved` on the next critique pass
after a revision, consistent with the Generator treating "worth
considering" as optional. Once severity stops gating urgency, every issue
that survives the checkboxes gets the same binding, individually-verified
treatment described in "Generator instruction-following" above.

### Why Codex/World Category extraction is a batch review, not silent auto-write

The writer's own framing was "we won't have to do that by hand" — but
"nothing writes unsupervised" is a rule every other write path in this
project follows (MCP's write tools, the Chat Assistant's `propose_*`
tools), and a bad extraction (a character mentioned in passing promoted
to a full Codex entry) is far cheaper to catch on one review screen than
to clean up after the fact. `confirmEntities` is the only thing that
ever actually writes — `extractEntities` only stages candidates.

## Contract Pipeline

A second, shorter Planning Engine track, alongside the Act/Part/Beats
hierarchy above — same `planning_runs` table, same generate → critique →
arbitrate → approve machinery, distinguished only by
`pipeline_type: "full" | "contract"`. Built to mirror how serialized-
fiction platforms (GoodNovel-style) decide whether a book gets picked
up: on roughly its first five chapters, judged on hook strength and
early pacing, not the whole book. Where the full pipeline plans an
entire book incrementally, the Contract Pipeline plans exactly enough to
give a book its strongest possible shot at clearing that read — a
Core Summary, initial Codex documentation, and a fixed 5-chapter hook
outline — nothing more.

**Never writes prose**, same as the full pipeline — the five "hook
chapters" this pipeline produces are an outline (beats), not manuscript
text. Turning that outline into actual chapters is still Hanami's job,
via the existing `/generate-prose` flow or the MCP scene-draft tools,
unchanged by any of this.

### The three units

- `stage_1_summary` — identical to the full pipeline's Stage 1, same
  Generator prompt, same intake flow. Both tracks share this exact unit;
  they only diverge afterward.
- `codex_documentation` — the book's initial character/world
  documentation, generated fresh from the Book Vision (its Parent
  Artifact) before any chapters exist. Unlike on-demand entity extraction
  (`extractEntities`/`confirmEntities`, which stays proposal-only), this
  stage's whole job IS to produce the book's starting Codex — approving
  it writes directly into `codex_entries` (`materializeCodexDocumentation`
  in `planningEngine.ts`), the same non-proposal treatment
  `materializeBeats` already gives an approved beats chunk. JSON
  contract: `{"entries": [{"name", "entryType", "description", "aliases"?,
  "tier"?, "personalityTraits"?, "motivations"?}]}` — the same field
  subset Layer 1 (`rag.ts`) actually injects into prose generation,
  deliberately not the full Codex field list; richer fields stay
  writer-editable afterward through the normal Codex CRUD surface, same
  as any entry.
- `hook_chapters_outline` — Chapter Beats for exactly chapters 1-5,
  fixed, the same way `ACTS_PER_BOOK`/`PARTS_PER_ACT` are fixed and never
  model-decided. Same JSON contract as `part_beats`
  (`{"chapters": [{"chapterNumber", "title"?, "beats": [{"title",
  "outlineText"}]}]}`), so approving it reuses `materializeBeats` and
  `appendLedgerFacts` unchanged — a hook chapter lands in the Outliner
  and contributes to the continuity ledger exactly like a full-pipeline
  beats chunk does.

Both `codex_documentation` and `hook_chapters_outline` go through the
identical generate → critique → arbitrate → approve cycle every unit in
this system uses — no shortcut, no unsupervised write. The 3 critics and
the Arbitrator run at these stages too, via `getActivePrompt`'s existing
exact-stage-then-`"all"`-fallback lookup — this needed zero new
architecture, just new prompt rows scoped to these two stage names.
`pacing_critic` in particular is deliberately re-purposed per stage
rather than skipped: at `codex_documentation` its rubric becomes
coverage/completeness (is every character the premise needs actually
documented, not padded with excess), and at `hook_chapters_outline` it
becomes the pipeline's most consequential critic — a strict, zero-
tolerance check that chapter 1 hooks immediately and that literally
every one of the five chapters ends on a real cliffhanger, not just some
of them. `craft_critic` at `hook_chapters_outline` weights hook
specificity and anti-cliché harder than its full-pipeline job, since a
generic first impression is a worse defect here than mid-book. No
pipeline can literally guarantee a platform will offer a contract —
every prompt at this stage frames its job as maximizing the known hook/
pacing signals these platforms actually reward, not promising the
outcome.

### Platform Craft Notes

Documented under Contract Pipeline since that's where it originated, but
**not Contract-Pipeline-exclusive** — see the note near the end of this
section; it now feeds the full Act/Part/Beats hierarchy too.

A per-book reference doc (`platform_craft_notes`, one row per `book_id`)
feeding a `{{PLATFORM_TRENDS}}` placeholder into the Generator and
critics across both pipelines. Deliberately **not** a live or
scheduled feed — scraping ranking/algorithm behavior in real time is
fragile and platform-ToS-risky, and a silently-updating judgment
reference is exactly the kind of ungoverned drift every other write path
in this project avoids (MCP's write tools, the Chat Assistant's
`propose_*` tools, Codex/World Category batch review). Instead:

- `POST /api/v1/platform-craft-notes/research` — `{ bookId }` — starts an
  on-demand research pass as a **detached background job** and returns
  immediately (`202`) with `draftStatus: "running"` — it does not await
  the LLM call. Calls Claude with the `web_search_20260209` and
  `web_fetch_20260209` server-side tools (the same pattern `intakeChatTurn`
  already uses for reading a pasted URL during intake) to find genuinely
  current information, covering **two angles explicitly, not just one**:
  opening-chapters/contract-qualification craft (hook conventions,
  early-chapter pacing, why submissions get rejected — grounds the
  Contract Pipeline and Act 1) and sustained engagement across a full
  serialized run (trending tropes/subgenres/tags, multi-arc pacing
  conventions, why reader engagement drops off deep into a book, paywall/
  premium-placement mechanics — grounds every later Act/Part of the full
  pipeline, per "Not Contract-Pipeline-exclusive" above). The prompt used
  to only ask about the first angle, which made sense back when this fed
  only the Contract Pipeline's five-chapter outline — broadened once
  `{{PLATFORM_TRENDS}}` started feeding the whole-book pipeline too, since
  a research pass scoped only to opening-chapter hooks has little to say
  about pacing an Act 2 Part outline. Anthropic runs the searches/fetches
  itself within the call, no scraping code lives in this backend.
  Prompt-driven like every other agent role — `platform_researcher`,
  stage `"all"`.

  **Runs to completion server-side regardless of the writer's browser** —
  `startPlatformResearchJob` (`platformCraftNotes.ts`) deliberately does
  not `await` the Claude call before returning; the call is its own
  outbound connection to Anthropic with no tie to the inbound request's
  socket, so closing the tab or navigating away has no effect on it. Its
  result lands on this book's `platform_craft_notes` row
  (`draft_status`/`draft_content`/`draft_error`) when it finishes,
  picked up by the writer via a normal `GET` whenever they next check —
  same tab, a different tab, or a different device. Refuses to start a
  second job while one is already `"running"` for the book (returns the
  existing in-flight state instead) rather than double-billing an
  impatient double-click. **Nothing is saved as the real notes by this
  call** — see `PATCH` below.

  One honest limitation, not fully engineered around: if the backend
  process restarts (a redeploy) while a job is mid-flight, that job is
  lost — `draft_status` stays stuck on `"running"` forever unless
  explicitly reset via the cancel endpoint below, since there's no
  separate worker/queue with its own retry semantics, only a detached
  in-process call. The same category of tradeoff this project already
  accepts elsewhere (e.g. the MCP session map being wiped by every
  deploy).

  **Refuses to overwrite an unsaved `"ready"` draft** — if one is
  already sitting there waiting for review, this returns `409` instead
  of silently discarding it by starting a fresh pass over it. Pass
  `force: true` to discard and proceed anyway (equivalent to calling
  `research/discard` first).
- `POST /api/v1/platform-craft-notes/research/cancel` — `{ bookId }` —
  stops an in-flight pass and resets `draft_status` back to `"idle"`.
  Tracked via an in-memory `Map<bookId, AbortController>`
  (`activeResearchJobs` in `platformCraftNotes.ts`) — same single-process
  limitation as the MCP session map, so this only actually aborts the
  live Anthropic call if the same server process that started it is
  still running; otherwise (a restart happened since) it still resets
  the stored state so the writer isn't stuck looking at a permanently
  `"running"` job either way.
- `PATCH /api/v1/platform-craft-notes` — `{ bookId, content }` — the only
  way notes actually get saved, whether the content came from editing a
  research draft or writing it directly. Also resets `draft_status` back
  to `"idle"` — a draft is either accepted (folded into `content` here)
  or explicitly discarded, never left sitting as a stale "ready" banner.
- `POST /api/v1/platform-craft-notes/research/discard` — `{ bookId }` —
  discards a `"ready"`/`"failed"` draft without saving it, resetting to
  `"idle"`. Leaves the last actually-saved `content` untouched.
- `GET /api/v1/platform-craft-notes?bookId=` — the current saved notes
  plus the draft job's live state (`draftStatus`/`draftContent`/
  `draftError`/`draftUpdatedAt`), or an empty `"idle"` stub if none exist
  yet — a book with no notes isn't an error, `{{PLATFORM_TRENDS}}` just
  renders empty. **Poll this endpoint** (the same pattern already used to
  poll a Planning Engine run) to watch a research pass started above
  progress from `"running"` to `"ready"`/`"failed"`.

**Not Contract-Pipeline-exclusive** — `platform_craft_notes` is one row
per `book_id`, not per `pipeline_type`, and now feeds the full Act/Part/
Beats hierarchy too, not just the Contract Pipeline's hook-focused units:
`generator`/`pacing_critic`/`craft_critic` at `stage_1_summary`,
`act_summary`, `part_outline`, and `part_beats` all reference
`{{PLATFORM_TRENDS}}` now, the same way their Contract-Pipeline
counterparts already did — trending tropes/tags and pacing conventions
matter for planning the whole book, not only its first five chapters.
`getActivePrompt`/`interpolateTemplate` already ignore a placeholder no
template references, so `PLATFORM_TRENDS` is fetched and passed
unconditionally for EVERY `generate`/`critique`/`arbitrate` call
(`generateStage`/`runCritique`/`runArbitration` in `planningEngine.ts`)
regardless of `pipeline_type` or stage — harmless, and one fewer
stage/pipeline-specific branch to maintain.

**A second, MCP-side path for populating these notes**: `get_platform_
craft_notes`/`update_platform_craft_notes` (see MCP Server's Tools list
below) expose the same read/save actions to an MCP-connected Claude
session (Desktop/claude.ai), parallel to the app's own automated
`platform_researcher` research pass above. The difference is who does the
research and how: the app's pass runs a single, one-shot backend
`web_search`/`web_fetch`-equipped Claude call server-side; the MCP path
lets the writer instead research conversationally in a live Claude
session — using that session's own live web access, which can be more
interactive and current than a one-shot backend call — and have Claude
save what it found directly once the writer's satisfied with it. Same
direct-write reasoning as every other MCP write tool: safe specifically
because a human is steering the research and the save decision in real
time, not because the content is low-stakes. `update_platform_craft_notes`
calls the exact same `savePlatformCraftNotes` function the app's own
`PATCH /platform-craft-notes` uses — a whole-document replace, not a
merge, so the tool's description tells Claude to read the existing notes
first and send back the complete merged document, not just new findings.

### Handoff into the full pipeline

`POST /api/v1/planning/runs/:id/promote-to-full` — takes a **completed**
(`status: "done"`) contract-pipeline run and creates a brand new
`pipeline_type: "full"` run for the same book (`promoteContractRunToFull`
in `planningEngine.ts`), seeded rather than starting cold:

- Stage 1 reuses the contract run's already-approved summary directly —
  no regeneration.
- Part 1 of Act 1 (chapters 1-5) is pre-recorded as already materialized:
  `part_chapter_ranges["1-1"]` is set to `{startChapter: 1, endChapter: 5}`
  up front, and `stage_artifacts` is seeded with a display placeholder
  for Part 1's outline and the contract run's actual `hook_chapters_
  outline` JSON for Part 1's beats — real content already sitting in the
  Outliner from the Contract Pipeline's own approval, not regenerated.
- `continuity_ledger` carries over every fact already extracted from the
  five hook chapters.
- The new run starts at Act 1's Summary — genuinely generated fresh,
  informed by the Book Context now reflecting the real chapters/Codex
  entries that already exist — and `nextPosition`'s one special case
  (`planningEngine.ts`) takes it straight to **Part 2's** outline once
  Act 1's Summary is approved, skipping a Part that's already written
  rather than re-planning it.

The original contract run is left completely untouched — this creates a
new row, never mutates the contract run in place — so it stays as an
intact historical record of exactly what got the contract, independent
of whatever happens to the book afterward.

## Development Stages

1. Repository & Architectural Blueprint (this document)
2. Supabase Schema & `pgvector` Migrations
3. Core RAG Services (Embeddings, Dual-Layer Retriever, Hanami LLM Client)
4. Decoupled Express API Server
5. In-Terminal Seed & Test Runner (verifies memory/retrieval accuracy directly, no frontend required)
6. Content Management API (Codex CRUD + relationships, manuscript chunk ingestion) — closes the loop so Codex/manuscript memory can be authored and kept current, not just seeded once for testing
