# Idea: live Ghost Editor in the WordArchitect Mac app

Recorded 26 Nov 2026, from the author. Not scheduled; a note for later.

## The idea

WordArchitect's web app becomes a Mac app, with Claude Code running on the machine and connected straight into
WordArchitect. On the word-processing page, after a draft is written:

- every banned word or phrase in the document is highlighted, like a marker pen;
- the author watches in real time as WordArchitect works through them: each highlight is rewritten in place, re-checked,
  and cleared once the system is satisfied (or left marked if it couldn't be fixed).

## What the backend already has toward it

- The Ghost Editor (`src/services/ghostEditor.ts`, rebuilt 26 Nov) already works one marked spot at a time: it finds
  every occurrence (`findAllBannedSpans`), rewrites only the sentence holding it, re-checks against the full list, and
  records each spot's before/after, attempts, engine and log (`spots` in the correction report). That per-spot
  structure is exactly what a live highlighter needs.

## What it would still need

- **Run on a saved document, not only on a fresh generation.** Today the Ghost Editor runs inside `/generate-prose`
  and `generate_prose_direct`. The page would need an endpoint that takes a chapter (or a selection) and cleans it.
- **Stream progress.** An event per spot (`found` → `rewriting` → `fixed` / `unresolved`, with character offsets), for
  example over Server-Sent Events, which `/generate-prose` already uses, so the page can move each highlight as it changes.
- **Offsets that survive edits.** If the author types while it runs, spot positions shift; the page and backend need to
  agree on how to re-anchor a spot (e.g. by the sentence text plus paragraph id, not raw offsets).
- **Writing back.** A cleaned sentence lands in `manuscript_chapters.paragraphs` (the editor's source of truth), and the
  chapter's retrieval memory goes stale until the existing sync-to-memory action runs.
