import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { generateEmbedding } from "../services/embedding.js";
import { generateHanamiProse } from "../services/llm.js";
import { buildSystemPrompt } from "../routes/generateProse.js";
import { assembleContextPayload } from "../services/rag.js";
import { ingestManuscriptText } from "../services/manuscriptIngest.js";
import { VALID_CODEX_ENTRY_TYPES } from "../types/domain.js";
import type { CodexEntryType, ManuscriptChunkMatch } from "../types/domain.js";

const SEARCH_MATCH_COUNT = 8;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

// Registers every tool an MCP client (e.g. Claude via a custom connector)
// can call against this book's Codex and manuscript memory. Design intent
// (see CLAUDE.md's MCP Server section): read tools give Claude enough to
// brainstorm with real, comprehensive understanding instead of a single
// similarity-search snippet; write tools only ever fire when a human is
// actively directing the conversation, so nothing lands in the Codex
// unsupervised; generate_prose_direct is the payoff — it hands Hanami
// exactly the context Claude and the writer already agreed on, bypassing
// the automatic Layer 1/2/3 pipeline entirely so nothing gets lost
// between "Claude understood this" and "Hanami wrote it."
export function registerWordArchitectTools(server: McpServer): void {
  server.registerTool(
    "list_codex_entries",
    {
      title: "List Codex Entries",
      description:
        "List every Codex entry (characters, locations, items, lore, etc.) for a book. Use this first to see what's already tracked before searching the manuscript or proposing new entries.",
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        entryType: z
          .enum(VALID_CODEX_ENTRY_TYPES as [CodexEntryType, ...CodexEntryType[]])
          .optional()
          .describe("Optional filter by entry type"),
      },
    },
    async ({ bookId, entryType }) => {
      const supabase = getSupabaseClient();
      let query = supabase.from("codex_entries").select("*").eq("book_id", bookId);
      if (entryType) query = query.eq("entry_type", entryType);

      const { data, error } = await query.order("name", { ascending: true });
      if (error) return errorResult(`Failed to list codex entries: ${error.message}`);
      return textResult(JSON.stringify(data, null, 2));
    }
  );

  server.registerTool(
    "get_codex_entry",
    {
      title: "Get Codex Entry",
      description: "Fetch one Codex entry's full record by ID, including every field (not just what Layer 1 would inject).",
      inputSchema: { entryId: z.string().describe("The codex_entries row ID") },
    },
    async ({ entryId }) => {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.from("codex_entries").select("*").eq("id", entryId).maybeSingle();
      if (error) return errorResult(`Failed to fetch codex entry: ${error.message}`);
      if (!data) return errorResult(`No codex entry found with id ${entryId}`);
      return textResult(JSON.stringify(data, null, 2));
    }
  );

  server.registerTool(
    "search_manuscript",
    {
      title: "Search Manuscript",
      description:
        `Semantic search over this book's ingested manuscript. Returns up to ${SEARCH_MATCH_COUNT} matching passages ranked by similarity, with chapter/scene position and full text — no relevance cutoff is applied, so use your own judgment about which results actually matter. Call this multiple times with different phrasings if the first pass doesn't surface what you need; unlike the automatic /generate-prose pipeline, you aren't limited to one shot.`,
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        query: z.string().describe("What to search for — a concept, event, object, or phrase, described as it might actually read in prose"),
      },
    },
    async ({ bookId, query }) => {
      try {
        const embedding = await generateEmbedding(query);
        const supabase = getSupabaseClient();
        const { data, error } = await supabase.rpc("match_manuscript_chunks", {
          query_embedding: embedding,
          match_threshold: 0,
          match_count: SEARCH_MATCH_COUNT,
          target_book_id: bookId,
        });
        if (error) return errorResult(`Manuscript search failed: ${error.message}`);
        const matches = (data ?? []) as ManuscriptChunkMatch[];
        return textResult(JSON.stringify(matches, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "get_manuscript_chapter",
    {
      title: "Get Manuscript Chapter",
      description:
        "Fetch every stored chunk of a specific chapter, in order, concatenated into the full chapter text. Use this when you need literal chapter content rather than a similarity-matched excerpt — e.g. to verify exactly how a scene played out.",
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        chapterNumber: z.number().int().describe("The chapter number"),
      },
    },
    async ({ bookId, chapterNumber }) => {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from("manuscript_chunks")
        .select("scene_order, raw_text")
        .eq("book_id", bookId)
        .eq("chapter_number", chapterNumber)
        .order("scene_order", { ascending: true });

      if (error) return errorResult(`Failed to fetch chapter: ${error.message}`);
      if (!data || data.length === 0) return errorResult(`No manuscript chunks found for chapter ${chapterNumber}`);
      return textResult(data.map((row) => row.raw_text).join("\n\n"));
    }
  );

  server.registerTool(
    "preview_automatic_context",
    {
      title: "Preview Automatic Context",
      description:
        "Runs the same automatic Layer 1/2/3 context compilation /generate-prose would use for a given scene beat, without calling Hanami. Useful as a reference point — see what the automatic pipeline would find before deciding whether you can do better with search_manuscript and get_codex_entry.",
      inputSchema: {
        userId: z.string().describe("The user's ID"),
        bookId: z.string().describe("The book's ID"),
        sceneBeat: z.string().describe("The scene beat to compile context for"),
      },
    },
    async ({ userId, bookId, sceneBeat }) => {
      try {
        const { payload } = await assembleContextPayload({
          userId,
          bookId,
          userSceneBeat: sceneBeat,
          recentHistoryText: "",
        });
        return textResult(payload || "(empty — no Codex, history, or manuscript memory matched automatically)");
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "create_codex_entry",
    {
      title: "Create Codex Entry",
      description:
        "Create a new Codex entry. Only call this after the writer has confirmed in conversation that they want it created — this writes directly to their Codex, so never call it speculatively.",
      inputSchema: {
        userId: z.string().describe("The user's ID"),
        bookId: z.string().describe("The book's ID"),
        name: z.string().describe("The entry's name"),
        entryType: z.enum(VALID_CODEX_ENTRY_TYPES as [CodexEntryType, ...CodexEntryType[]]),
        description: z.string().describe("Overview/summary — the only field always injected into generation context"),
        aliases: z.array(z.string()).optional(),
        personalityTraits: z.array(z.string()).optional(),
        motivations: z.array(z.string()).optional(),
      },
    },
    async ({ userId, bookId, name, entryType, description, aliases, personalityTraits, motivations }) => {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from("codex_entries")
        .insert({
          user_id: userId,
          book_id: bookId,
          name,
          entry_type: entryType,
          description,
          aliases: aliases ?? null,
          personality_traits: personalityTraits ?? null,
          motivations: motivations ?? null,
        })
        .select("*")
        .single();

      if (error) return errorResult(`Failed to create codex entry: ${error.message}`);
      return textResult(JSON.stringify(data, null, 2));
    }
  );

  server.registerTool(
    "update_codex_entry",
    {
      title: "Update Codex Entry",
      description:
        "Update fields on an existing Codex entry. Only call this after the writer has confirmed the change in conversation — this writes directly to their Codex.",
      inputSchema: {
        entryId: z.string().describe("The codex_entries row ID"),
        description: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        personalityTraits: z.array(z.string()).optional(),
        motivations: z.array(z.string()).optional(),
        background: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async ({ entryId, description, aliases, personalityTraits, motivations, background, notes }) => {
      const payload: Record<string, unknown> = {};
      if (description !== undefined) payload.description = description;
      if (aliases !== undefined) payload.aliases = aliases;
      if (personalityTraits !== undefined) payload.personality_traits = personalityTraits;
      if (motivations !== undefined) payload.motivations = motivations;
      if (background !== undefined) payload.background = background;
      if (notes !== undefined) payload.notes = notes;

      if (Object.keys(payload).length === 0) {
        return errorResult("No fields provided to update.");
      }

      const supabase = getSupabaseClient();
      const { data, error } = await supabase.from("codex_entries").update(payload).eq("id", entryId).select("*").maybeSingle();
      if (error) return errorResult(`Failed to update codex entry: ${error.message}`);
      if (!data) return errorResult(`No codex entry found with id ${entryId}`);
      return textResult(JSON.stringify(data, null, 2));
    }
  );

  server.registerTool(
    "generate_prose_direct",
    {
      title: "Generate Prose (Direct)",
      description:
        "Sends a scene beat straight to Hanami along with context YOU compile and supply — bypassing the automatic Layer 1/2/3 retrieval pipeline entirely. Compile compiledContext yourself from what you've gathered via search_manuscript, get_codex_entry, and this conversation with the writer — Hanami will write from exactly what you give it and nothing else, so make sure it's actually complete before calling this. Returns the full generated prose (not streamed).",
      inputSchema: {
        sceneBeat: z.string().describe("The scene beat to write"),
        compiledContext: z
          .string()
          .describe("The full context you've compiled — Codex info, manuscript excerpts, and any nuance from the conversation Hanami needs to write this scene consistently"),
      },
    },
    async ({ sceneBeat, compiledContext }) => {
      try {
        const systemPrompt = buildSystemPrompt(compiledContext);
        const prose = await generateHanamiProse(systemPrompt, sceneBeat);
        return textResult(prose);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "save_manuscript_scene",
    {
      title: "Save Manuscript Scene",
      description:
        "Saves accepted prose into permanent manuscript memory (chunked and embedded), so future generations — automatic or Claude-assisted — can recall it. Call this once the writer has accepted a generated or hand-written scene.",
      inputSchema: {
        userId: z.string().describe("The user's ID"),
        bookId: z.string().describe("The book's ID"),
        chapterNumber: z.number().int().describe("Chapter number this scene belongs to"),
        rawText: z.string().describe("The full scene text to save"),
      },
    },
    async ({ userId, bookId, chapterNumber, rawText }) => {
      try {
        const chunks = await ingestManuscriptText({ userId, bookId, chapterNumber, rawText });
        return textResult(`Saved ${chunks.length} chunk(s) to manuscript memory.`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
