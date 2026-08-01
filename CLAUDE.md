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
entries. Scans the scene beat text for known names or aliases and injects the
matched profile(s) directly.

- Budget: **~500–800 tokens max**
- Deterministic, no embedding call required

### Layer 2 — Recent History (Linear Slip)

Pulls the trailing **1,500–2,000 words** of manuscript text immediately
preceding the user's cursor position. Guarantees continuity of scene pacing,
tone, and character positioning at the point of generation.

- Budget: **~2,000 tokens**
- Positional slice, no embedding call required

### Layer 3 — Deep Past (Vector RAG)

The scene beat is embedded via `text-embedding-3-small` and matched against
previously embedded manuscript chunks in Supabase using a cosine similarity
RPC query: `match_manuscript_chunks`. Only the **top 3** most relevant
historical paragraphs are returned.

- Budget: **~1,000 tokens max**
- The only layer that performs a live embedding + vector search round trip

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
| `entry_type` | VARCHAR(50) NOT NULL | CHECK: `character` \| `location` \| `item` \| `lore` |
| `description` | TEXT NOT NULL | injected verbatim on Layer 1 match |
| `embedding` | VECTOR(1536) | reserved for future semantic Codex lookup; not used by Layer 1's deterministic string match |
| `created_at` | TIMESTAMPTZ | default `NOW()` |

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
`match_count` (Layer 3 calls this with `match_count = 3`).

### Indexes

- `idx_codex_entries_book_id`, `idx_manuscript_chunks_book_id` — B-tree, scope every retrieval query to one book
- `idx_codex_entries_embedding`, `idx_manuscript_chunks_embedding` — HNSW (`vector_cosine_ops`), back the cosine-distance searches above

## Development Stages

1. Repository & Architectural Blueprint (this document)
2. Supabase Schema & `pgvector` Migrations
3. Core RAG Services (Embeddings, Dual-Layer Retriever, Hanami LLM Client)
4. Decoupled Express API Server
5. In-Terminal Seed & Test Runner (verifies memory/retrieval accuracy directly, no frontend required)
