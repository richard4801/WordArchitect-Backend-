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

## Development Stages

1. Repository & Architectural Blueprint (this document)
2. Supabase Schema & `pgvector` Migrations
3. Core RAG Services (Embeddings, Dual-Layer Retriever, Hanami LLM Client)
4. Decoupled Express API Server
5. In-Terminal Seed & Test Runner (verifies memory/retrieval accuracy directly, no frontend required)
