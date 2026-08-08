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
cosine similarity RPC `match_manuscript_chunks`, then results are
interleaved round-robin across concepts (best-of-A, best-of-B, ...,
second-best-of-A, ...) rather than pooled and sorted by raw similarity —
otherwise a concept with generally higher-scoring matches could still
crowd out a less-dominant one when merging. Falls back to treating the
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
  clears the threshold, in round-robin priority order and deduplicated by
  chapter, `src/services/rag.ts` fetches every chunk belonging to that
  chunk's `chapter_number` and expands outward from the matched
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
| `entry_type` | VARCHAR(50) NOT NULL | CHECK: `character` \| `location` \| `item` \| `lore` \| `nation` \| `culture` \| `magic` \| `faction` \| `religion` \| `history` |
| `description` | TEXT NOT NULL | overview/summary; the only field always injected on a Layer 1 match |
| `embedding` | VECTOR(1536) | reserved for future semantic Codex lookup; not used by Layer 1's deterministic string match |
| `tier` | VARCHAR(20) | CHECK: `main` \| `supporting` \| `minor` |
| `quote`, `image_url`, `age`, `gender`, `role_in_story`, `occupation`, `location_name` | TEXT/VARCHAR | human-facing profile fields, CRUD-only — not injected into Layer 1 |
| `physical_description`, `motivations` | TEXT[] | bullet-list fields; `motivations` (top 3) is condensed into Layer 1 alongside `personality_traits` |
| `personality_traits` | VARCHAR(100)[] | condensed into Layer 1 as a short `Traits: ...` line |
| `background`, `notes` | TEXT | human-facing only, not injected into Layer 1 |
| `character_arc` | JSONB | array of `{ stage, description }`; human-facing only |
| `event_year` | VARCHAR(50) | for `history`-type entries (timeline events) |
| `created_at` | TIMESTAMPTZ | default `NOW()` |

Managed entirely through `POST/GET/PATCH/DELETE /api/v1/codex` (see below). Only
`description` + condensed `personality_traits`/`motivations` ever reach Hanami's
prompt — the richer fields exist for a human-facing Codex UI (character sheets,
worldbuilding pages) and stay out of the token budget regardless of how much
detail a writer stores.

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

### Indexes

- `idx_codex_entries_book_id`, `idx_manuscript_chunks_book_id` — B-tree, scope every retrieval query to one book
- `idx_codex_entries_embedding`, `idx_manuscript_chunks_embedding` — HNSW (`vector_cosine_ops`), back the cosine-distance searches above
- `idx_codex_relationships_book_id`, `idx_codex_relationships_from_entry`, `idx_codex_relationships_to_entry` — B-tree

## Content Management API

Endpoints that keep the Codex and manuscript memory populated and up to date
as a writer works — separate from `/generate-prose`'s read-only retrieval path.

### Codex CRUD (`src/routes/codex.ts`)

- `GET /api/v1/codex?bookId=&entryType=&tier=` — list entries for a book
- `GET /api/v1/codex/:id` — fetch one entry (full record, all fields)
- `POST /api/v1/codex` — create an entry
- `PATCH /api/v1/codex/:id` — partial update
- `DELETE /api/v1/codex/:id` — delete (cascades to its relationships)
- `GET /api/v1/codex/:id/relationships` — list relationships involving an entry (either direction)
- `POST /api/v1/codex/:id/relationships` — create a relationship from `:id` to another entry
- `DELETE /api/v1/codex/relationships/:relationshipId` — delete a relationship

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

Write (mirror the Codex CRUD routes' full field set — every optional
column `PATCH /api/v1/codex/:id` accepts, including `characterArc`, kept
in sync via a shared field list in `tools.ts` so a field present on one
path and missing from the other can't silently fail to save again; only
meant to be called when the writer has actively confirmed the change in
the conversation, never speculatively — nothing here should ever write
unsupervised):
- `create_codex_entry`, `update_codex_entry`
- `save_manuscript_scene` — ingests accepted prose into permanent
  manuscript memory via the existing `ingestManuscriptText` pipeline, so
  it's there for future generations (Claude-assisted or automatic) too

Generation:
- `generate_prose_direct` — `{ sceneBeat, compiledContext }` — see "the
  handoff problem" above. Buffers Hanami's full response and returns it
  as one result rather than streaming, since the caller is a tool result,
  not a live browser connection (`generateHanamiProse` in `llm.ts`).

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

## Development Stages

1. Repository & Architectural Blueprint (this document)
2. Supabase Schema & `pgvector` Migrations
3. Core RAG Services (Embeddings, Dual-Layer Retriever, Hanami LLM Client)
4. Decoupled Express API Server
5. In-Terminal Seed & Test Runner (verifies memory/retrieval accuracy directly, no frontend required)
6. Content Management API (Codex CRUD + relationships, manuscript chunk ingestion) — closes the loop so Codex/manuscript memory can be authored and kept current, not just seeded once for testing
