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
compiles context from three parallel layers before invoking Hanami. No layer
depends on manually authored summaries.

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

- Budget: **~1,000 tokens max**
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

## Strict Context Boundary

The **total compiled prompt payload** (Layer 1 + Layer 2 + Layer 3 +
instructions/scaffolding) **must remain strictly under 4,000 tokens**.

This is a hard cap, not a target — it exists to preserve ~28,000 tokens of
free context headroom out of Hanami's 32k window for uninterrupted prose
generation. Any retrieval or assembly logic that would exceed this budget
must truncate/drop lower-priority content rather than exceed the cap.

Priority order when trimming to fit budget: Layer 1 (Codex) > Layer 2
(Recent History) > Layer 3 (Deep Past RAG).

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

`match_manuscript_chunks(query_embedding VECTOR(1536), match_threshold FLOAT, match_count INT, target_book_id UUID) RETURNS TABLE(id UUID, raw_text TEXT, similarity FLOAT)`

Cosine distance search (`<=>` operator) scoped to `target_book_id`,
filtered by `match_threshold`, ordered by similarity descending, capped at
`match_count`. Layer 3 calls this once per expanded concept (see above)
with `match_count = 3` and `match_threshold = 0`, applying the real
threshold locally afterward.

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
Layer 1/2/3 pipeline finds, bounded by the 4,000-token budget. Claude has
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

Write (mirror the Codex CRUD routes — only meant to be called when the
writer has actively confirmed the change in the conversation, never
speculatively; nothing here should ever write unsupervised):
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
