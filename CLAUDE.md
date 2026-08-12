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
produce it again, checked on every `/generate-prose` call.

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
| `entry_type` | VARCHAR(50) NOT NULL | CHECK: `character` \| `location` \| `item` \| `lore` \| `nation` \| `culture` \| `magic` \| `faction` \| `religion` \| `history` |
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
| | `synced_to_memory_at` | TIMESTAMPTZ | null until the first sync (see below); lets a UI show "has unsynced edits" by comparing against `updated_at` |
| | `created_at`, `updated_at` | TIMESTAMPTZ | |
| `manuscript_scenes` | `id` | UUID PK | |
| | `chapter_id` | UUID NOT NULL | FK → `manuscript_chapters(id)` ON DELETE CASCADE |
| | `title` | VARCHAR(255) NOT NULL | |
| | `order_index` | INT NOT NULL | default `0` |
| | `created_at` | TIMESTAMPTZ | default `NOW()` |

`manuscript_scenes` is a writer-authored navigation marker within a
chapter, not to be confused with `manuscript_chunks.scene_order` — a
RAG chunk position assigned automatically during ingestion.

No foreign key to `books(id)` on `manuscript_parts`/`manuscript_chapters`
— same reasoning as `codex_entries`/`manuscript_chunks` (see `013_books.sql`):
a real `book_id` already in use may not yet have a corresponding `books`
row, and a FK here would block legitimate writes for it. `part_id` and
`chapter_id` above *are* real foreign keys, since those referenced tables
are wholly new with no pre-existing data to conflict with.

### Indexes

- `idx_codex_entries_book_id`, `idx_manuscript_chunks_book_id` — B-tree, scope every retrieval query to one book
- `idx_codex_entries_embedding`, `idx_manuscript_chunks_embedding` — HNSW (`vector_cosine_ops`), back the cosine-distance searches above
- `idx_codex_relationships_book_id`, `idx_codex_relationships_from_entry`, `idx_codex_relationships_to_entry` — B-tree
- `idx_manuscript_parts_book_id`, `idx_manuscript_chapters_book_id`, `idx_manuscript_chapters_part_id`, `idx_manuscript_scenes_chapter_id` — B-tree

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
  every keystroke/pause costs nothing beyond a normal database write
- `DELETE /api/v1/manuscript/chapters/:id` — deletes only this chapter's
  editor content and its scene markers (cascades). Does **not** touch
  `manuscript_chunks` — content already synced into Deep Past memory
  stays retrievable even if its editor row is later removed, the same
  non-cascading principle as `DELETE /books/:id`

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

**Scenes:**
- `GET /api/v1/manuscript/chapters/:chapterId/scenes`
- `POST /api/v1/manuscript/chapters/:chapterId/scenes` — `{ title, orderIndex? }`
- `PATCH /api/v1/manuscript/scenes/:id`
- `DELETE /api/v1/manuscript/scenes/:id`

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

## Development Stages

1. Repository & Architectural Blueprint (this document)
2. Supabase Schema & `pgvector` Migrations
3. Core RAG Services (Embeddings, Dual-Layer Retriever, Hanami LLM Client)
4. Decoupled Express API Server
5. In-Terminal Seed & Test Runner (verifies memory/retrieval accuracy directly, no frontend required)
6. Content Management API (Codex CRUD + relationships, manuscript chunk ingestion) — closes the loop so Codex/manuscript memory can be authored and kept current, not just seeded once for testing
