import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { generateHanamiProse } from "../services/llm.js";
import { buildSystemPrompt } from "../routes/generateProse.js";
import { assembleContextPayload } from "../services/rag.js";
import { saveManuscriptScene } from "../services/manuscriptSceneSave.js";
import { listBannedTerms } from "../services/bannedTerms.js";
import { enforceBannedTerms } from "../services/ghostEditor.js";
import {
  startSceneDraftSession,
  recordSceneDraftIteration,
  getSceneDraftSession,
  listSceneDraftSessions,
  finishSceneDraftSession,
} from "../services/sceneDraftSessions.js";
import { diffDrafts } from "../lib/textDiff.js";
import { listCodexEntries, getCodexEntry, searchManuscript, getManuscriptChapterText } from "../services/bookContextTools.js";
import { KNOWN_CODEX_ENTRY_TYPES, VALID_NOTE_CATEGORIES } from "../types/domain.js";
import type { NoteCategory } from "../types/domain.js";
import { listWorldCategories, slugify } from "../routes/worldCategories.js";
import { listNotesForBook } from "../routes/notes.js";
import { listAgentPrompts, getAgentPromptById, createAgentPrompt, updateAgentPrompt, getActivePrompt } from "../services/agentPrompts.js";
import { getPlatformCraftNotes, savePlatformCraftNotes } from "../services/platformCraftNotes.js";
import { VALID_AGENT_ROLES, VALID_PLANNING_STAGES } from "../types/domain.js";
import type { AgentRole, PlanningStage } from "../types/domain.js";

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
// between "Claude understood this" and "Hanami wrote it." The
// start/record/get/list/finish_scene_draft_session tools go one step
// further: instead of a single generate_prose_direct handoff, Claude can
// supervise Hanami across multiple generate-critique-redirect passes on
// one scene, with progress persisted so a session survives past the
// conversation that started it.
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
          .string()
          .optional()
          .describe(
            `Optional filter by entry type — 'character' or a worldbuilding category key (common ones: ${KNOWN_CODEX_ENTRY_TYPES.join(", ")}, but a book may have custom ones too — see list_world_categories)`
          ),
      },
    },
    async ({ bookId, entryType }) => {
      try {
        const data = await listCodexEntries(bookId, entryType);
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
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
      try {
        const data = await getCodexEntry(entryId);
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "list_world_categories",
    {
      title: "List World Categories",
      description:
        "List this book's worldbuilding categories (locations, factions, lore, magic systems, or any custom category the writer has created) — each with its key, display name, color, and icon. Includes categories that only exist implicitly (an entry_type already in use on some codex_entries row but with no category metadata yet) with a derived display name, so this always reflects reality even before a category is formally created. Call this before create_codex_entry or create_world_category to see what categories already exist rather than guessing a key.",
      inputSchema: { bookId: z.string().describe("The book's ID") },
    },
    async ({ bookId }) => {
      try {
        const categories = await listWorldCategories(bookId);
        return textResult(JSON.stringify(categories, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "create_world_category",
    {
      title: "Create World Category",
      description:
        "Create a new worldbuilding category for this book (e.g. 'Ship Technology', 'Political Factions') — only call this after the writer has confirmed they want a new category, not speculatively. key is auto-derived from name (lowercase, hyphenated) if not given. Once created, use this category's key as entryType when calling create_codex_entry for entries that belong to it.",
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        name: z.string().describe("Display name, e.g. 'Ship Technology'"),
        key: z.string().optional().describe("Slug key; auto-derived from name if omitted"),
        description: z.string().optional(),
        color: z.string().optional(),
        icon: z.string().optional(),
      },
    },
    async ({ bookId, name, key, description, color, icon }) => {
      const resolvedKey = slugify(key ?? name);
      if (resolvedKey === "") {
        return errorResult("Could not derive a valid category key from name — provide one explicitly.");
      }

      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from("world_categories")
        .insert({
          book_id: bookId,
          key: resolvedKey,
          name,
          description: description ?? null,
          color: color ?? null,
          icon: icon ?? null,
        })
        .select("*")
        .single();

      if (error) {
        if (error.code === "23505") {
          return errorResult(`A category with key "${resolvedKey}" already exists for this book.`);
        }
        return errorResult(`Failed to create world category: ${error.message}`);
      }
      return textResult(JSON.stringify(data, null, 2));
    }
  );

  server.registerTool(
    "list_notes",
    {
      title: "List Notes",
      description:
        "List this book's quick notes (brainstorming captures — worldbuilding ideas, plot threads, research, inspiration) — the same notes the writer captures via the frontend's Quick Notes composer or notes modal. Pinned notes first, then most recently updated. Use this to catch up on brainstorming context from outside the current conversation before proposing new Codex entries or categories.",
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        category: z.enum(VALID_NOTE_CATEGORIES as [NoteCategory, ...NoteCategory[]]).optional(),
      },
    },
    async ({ bookId, category }) => {
      try {
        const data = await listNotesForBook(bookId, { category });
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "create_note",
    {
      title: "Create Note",
      description:
        "Capture a quick note for the writer — e.g. a brainstorming idea worth remembering that doesn't belong in the Codex yet. Only call this when the writer has actually asked you to jot something down, not speculatively as a running log of the conversation.",
      inputSchema: {
        userId: z.string().describe("The user's ID"),
        bookId: z.string().describe("The book's ID"),
        title: z.string(),
        excerpt: z.string().describe("The note's body text"),
        category: z.enum(VALID_NOTE_CATEGORIES as [NoteCategory, ...NoteCategory[]]),
        pinned: z.boolean().optional(),
      },
    },
    async ({ userId, bookId, title, excerpt, category, pinned }) => {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from("notes")
        .insert({
          user_id: userId,
          book_id: bookId,
          title,
          excerpt,
          category,
          pinned: pinned ?? false,
        })
        .select("*")
        .single();

      if (error) return errorResult(`Failed to create note: ${error.message}`);
      return textResult(JSON.stringify(data, null, 2));
    }
  );

  const truncatePreview = (text: string, max = 220) => (text.length > max ? text.slice(0, max - 1) + "…" : text);

  server.registerTool(
    "list_agent_prompts",
    {
      title: "List Agent Prompts",
      description:
        "Lists the CURRENTLY ACTIVE prompt for every Planning Engine agent role/stage on this book (generator, the 3 critics, arbitrator_panel/chat/directive, entity_extractor, ledger_extractor, platform_researcher — see CLAUDE.md's Planning Engine section for what each governs). Returns compact summaries (id, agentRole, stage, version, model, effort, authoredBy, and a short preview of each prompt's text) — not full text, to keep this call cheap. Call get_agent_prompt with a specific id once you know which one the writer wants to discuss or change.",
      inputSchema: { bookId: z.string().describe("The book's ID") },
    },
    async ({ bookId }) => {
      try {
        const prompts = await listAgentPrompts(bookId);
        const active = prompts
          .filter((p) => p.is_active)
          .map((p) => ({
            id: p.id,
            agentRole: p.agent_role,
            stage: p.stage,
            version: p.version,
            model: p.model,
            effort: p.effort,
            authoredBy: p.authored_by,
            systemPromptPreview: truncatePreview(p.system_prompt),
            userPromptTemplatePreview: truncatePreview(p.user_prompt_template),
          }));
        return textResult(JSON.stringify(active, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "get_agent_prompt",
    {
      title: "Get Agent Prompt",
      description:
        "Fetches one specific agent_prompts row's full text (systemPrompt and userPromptTemplate in full, not truncated) by its id — from list_agent_prompts, or from update_agent_prompt's own response. Use this to actually read a prompt's current wording before discussing changes to it, or to pull up an older/inactive version for comparison before reverting via activate_agent_prompt_version.",
      inputSchema: { promptId: z.string().describe("The agent_prompts row id") },
    },
    async ({ promptId }) => {
      try {
        const prompt = await getAgentPromptById(promptId);
        return textResult(JSON.stringify(prompt, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "update_agent_prompt",
    {
      title: "Update Agent Prompt",
      description:
        "Rewrites an agent's prompt (systemPrompt and/or userPromptTemplate) for a specific role/stage — the actual write action once you and the writer have talked through a change and agreed on the new wording. Only call this once that agreement is explicit, the same 'a human is actively directing this write in real time' standard every other write tool here holds to — never speculatively mid-brainstorm. This ALWAYS creates a new version (never edits existing text in place) and activates it immediately, exactly like the writer saving an edit in the Prompt Editor UI themselves — the previous version is deactivated but not deleted, so it's fully visible in list_agent_prompts (with includeInactive-style history via get_agent_prompt on its id) and instantly restorable via activate_agent_prompt_version if the change doesn't work out. The new version is tagged authoredBy 'claude' so the Prompt Editor UI flags it as AI-authored. Deliberately CANNOT change model or effort (which stays whatever the current active version already uses) — those are operational/cost settings, not prompt content, and stay writer-controlled through the Prompt Editor UI only. If systemPrompt or userPromptTemplate is omitted, that half of the prompt carries over unchanged from the current active version — pass both when you're rewriting the whole thing, or just the one half you're actually changing.",
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        agentRole: z.enum(VALID_AGENT_ROLES as [AgentRole, ...AgentRole[]]).describe("Which agent role's prompt to update"),
        stage: z
          .enum(VALID_PLANNING_STAGES as [PlanningStage, ...PlanningStage[]])
          .describe("Which stage this prompt applies to (use 'all' for a role whose prompt doesn't vary by stage)"),
        systemPrompt: z.string().optional().describe("The new system prompt text — omit to leave it unchanged from the current active version"),
        userPromptTemplate: z
          .string()
          .optional()
          .describe("The new user prompt template text (with {{PLACEHOLDER}} tokens) — omit to leave it unchanged from the current active version"),
      },
    },
    async ({ bookId, agentRole, stage, systemPrompt, userPromptTemplate }) => {
      if (systemPrompt === undefined && userPromptTemplate === undefined) {
        return errorResult("Provide at least one of systemPrompt or userPromptTemplate to change.");
      }
      try {
        const current = await getActivePrompt(bookId, agentRole, stage);
        const updated = await createAgentPrompt({
          bookId,
          agentRole,
          stage,
          systemPrompt: systemPrompt ?? current.system_prompt,
          userPromptTemplate: userPromptTemplate ?? current.user_prompt_template,
          model: current.model,
          effort: current.effort,
          authoredBy: "claude",
        });
        return textResult(
          `Saved as version ${updated.version} and activated immediately (model/effort unchanged: ${updated.model}/${updated.effort}). Previous version ${current.version} is now inactive but still available via get_agent_prompt (id ${current.id}) if you need to revert with activate_agent_prompt_version.\n\n${JSON.stringify(updated, null, 2)}`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "activate_agent_prompt_version",
    {
      title: "Activate Agent Prompt Version",
      description:
        "Reactivates an older (currently inactive) prompt version by its id, deactivating whatever is currently active for that same role/stage — an instant revert with no retyping, for when a change made via update_agent_prompt doesn't work out. Does not modify any prompt's text, model, or effort — it only changes which existing version is active.",
      inputSchema: { promptId: z.string().describe("The agent_prompts row id of the version to reactivate") },
    },
    async ({ promptId }) => {
      try {
        const activated = await updateAgentPrompt(promptId, { isActive: true });
        return textResult(JSON.stringify(activated, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "get_platform_craft_notes",
    {
      title: "Get Platform Craft Notes",
      description:
        "Fetches this book's saved Platform Craft Notes — a reference doc on what actually hooks readers, converts, and stays trending (tropes, tags, pacing/chapter-economy conventions, common rejection reasons) on serialized-fiction platforms like GoodNovel. Feeds the {{PLATFORM_TRENDS}} placeholder used by generator/pacing_critic/craft_critic across both the full Act/Part/Beats pipeline and the Contract Pipeline. Read this first before proposing an update, so you revise/extend the existing notes rather than silently overwriting research already saved.",
      inputSchema: { bookId: z.string().describe("The book's ID") },
    },
    async ({ bookId }) => {
      try {
        const notes = await getPlatformCraftNotes(bookId);
        return textResult(JSON.stringify(notes ?? { bookId, content: "", updatedAt: null }, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "update_platform_craft_notes",
    {
      title: "Update Platform Craft Notes",
      description:
        "Saves this book's Platform Craft Notes — the actual write action, once you've researched (using your own live web access in this conversation, not a backend tool) what's currently converting on serialized-fiction platforms like GoodNovel. Research BOTH angles, not just one: (1) opening-chapters/contract-qualification craft (what hooks readers immediately, early chapter-economy/pacing conventions, why submissions get rejected) — this grounds the Contract Pipeline and Act 1 specifically; and (2) sustained engagement across a full serialized run (currently trending tropes/subgenres/tags, multi-arc pacing conventions, why reader engagement drops off deep into a book, platform mechanics like paywall/premium placement) — this grounds every later Act/Part of the full pipeline, which plans an entire book, not just five chapters. This is a parallel path to the backend's own automated research pass (POST /platform-craft-notes/research in the app) — use this when the writer wants you to do the research directly in this conversation instead. content REPLACES the notes wholesale, the same as the app's save action — call get_platform_craft_notes first and pass back the complete merged document (keep what's still accurate, correct or remove what's outdated, add what's newly found), not just the new findings alone, or you'll silently delete everything not restated. Only call this once the writer has actually asked you to save what you found, not speculatively mid-research. Note: if the app has a research pass sitting unsaved and ready for the writer's own review, this call will silently replace it — check get_platform_craft_notes's draftStatus/draftContent first if you're unsure whether that's the case.",
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        content: z.string().describe("The complete Platform Craft Notes document to save, replacing whatever is currently saved"),
      },
    },
    async ({ bookId, content }) => {
      try {
        const notes = await savePlatformCraftNotes(bookId, content);
        return textResult(JSON.stringify(notes, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
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
        const matches = await searchManuscript(bookId, query);
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
      try {
        const text = await getManuscriptChapterText(bookId, chapterNumber);
        return textResult(text);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
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

  const tierSchema = z.enum(["main", "supporting", "minor", "extra"]);
  const characterArcSchema = z.array(z.object({ stage: z.string(), description: z.string() }));
  const notesSchema = z.array(
    z.object({
      title: z.string(),
      body: z.string(),
      date: z.string().optional(),
      pinned: z.boolean().optional(),
    })
  );
  const objectArraySchema = z.array(z.record(z.string(), z.unknown()));
  const plainObjectSchema = z.record(z.string(), z.unknown());

  // Every optional field codex_entries actually has, matching what
  // PATCH /api/v1/codex/:id already supports (src/routes/codex.ts). Keep
  // this and update_codex_entry's field list in sync — a field missing
  // from one but present in the other is exactly the kind of gap that
  // makes a tool silently fail to save something a writer asked for.
  const codexFieldsSchema = {
    aliases: z.array(z.string()).optional(),
    tier: tierSchema.optional(),
    quote: z.string().optional(),
    imageUrl: z.string().optional(),
    age: z.string().optional(),
    gender: z.string().optional(),
    roleInStory: z.string().optional(),
    occupation: z.string().optional(),
    locationName: z.string().optional(),
    physicalDescription: z.array(z.string()).optional(),
    personalityTraits: z.array(z.string()).optional(),
    motivations: z.array(z.string()).optional(),
    background: z.array(z.string()).optional().describe("Array of background bullet points/paragraphs"),
    characterArc: characterArcSchema.optional().describe("Array of { stage, description } objects"),
    notes: notesSchema.optional().describe("Array of { title, body, date?, pinned? } objects"),
    eventYear: z.string().optional(),
    nickname: z.string().optional(),
    epithet: z.string().optional(),
    status: z.string().optional(),
    alignment: z.string().optional(),
    povCharacter: z.boolean().optional(),
    archetype: z.string().optional(),
    favorites: z.number().optional(),
    motivation: z.string().optional(),
    goal: z.string().optional(),
    fear: z.string().optional(),
    secret: z.string().optional(),
    lifeEvents: objectArraySchema.optional().describe("Array of life-event objects — shape not strictly enforced"),
    culturalBackground: plainObjectSchema.optional().describe("Object such as { origin, upbringing, education, beliefs, languages } — shape not strictly enforced"),
    strengths: z.array(z.string()).optional(),
    weaknesses: z.array(z.string()).optional(),
    internalConflict: z.string().optional(),
  };

  function toCodexPayload(fields: Record<string, unknown>): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    const map: Record<string, string> = {
      aliases: "aliases",
      tier: "tier",
      quote: "quote",
      imageUrl: "image_url",
      age: "age",
      gender: "gender",
      roleInStory: "role_in_story",
      occupation: "occupation",
      locationName: "location_name",
      physicalDescription: "physical_description",
      personalityTraits: "personality_traits",
      motivations: "motivations",
      background: "background",
      characterArc: "character_arc",
      notes: "notes",
      eventYear: "event_year",
      nickname: "nickname",
      epithet: "epithet",
      status: "status",
      alignment: "alignment",
      povCharacter: "pov_character",
      archetype: "archetype",
      favorites: "favorites",
      motivation: "motivation",
      goal: "goal",
      fear: "fear",
      secret: "secret",
      lifeEvents: "life_events",
      culturalBackground: "cultural_background",
      strengths: "strengths",
      weaknesses: "weaknesses",
      internalConflict: "internal_conflict",
    };
    for (const [key, column] of Object.entries(map)) {
      if (fields[key] !== undefined) payload[column] = fields[key];
    }
    return payload;
  }

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
        entryType: z
          .string()
          .describe(
            `'character', or a worldbuilding category key (common ones: ${KNOWN_CODEX_ENTRY_TYPES.join(", ")}; check list_world_categories first for this book's actual custom categories, or invent a short lowercase-hyphenated key and it'll show up as a new category once used)`
          ),
        description: z.string().describe("Overview/summary — the only field always injected into generation context"),
        ...codexFieldsSchema,
      },
    },
    async ({ userId, bookId, name, entryType, description, ...rest }) => {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from("codex_entries")
        .insert({
          user_id: userId,
          book_id: bookId,
          name,
          entry_type: entryType,
          description,
          ...toCodexPayload(rest),
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
        ...codexFieldsSchema,
      },
    },
    async ({ entryId, description, ...rest }) => {
      const payload = toCodexPayload(rest);
      if (description !== undefined) payload.description = description;

      if (Object.keys(payload).length === 0) {
        return errorResult("No fields provided to update.");
      }
      payload.updated_at = new Date().toISOString();

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
        "Sends a scene beat straight to Hanami along with context YOU compile and supply — bypassing the automatic Layer 1/2/3 retrieval pipeline entirely. Compile compiledContext yourself from what you've gathered via search_manuscript, get_codex_entry, and this conversation with the writer — Hanami will write from exactly what you give it and nothing else, so make sure it's actually complete before calling this. Returns the full generated prose (not streamed). Every call is completely stateless — Hanami has no memory of any previous call, including its own prior drafts. If you're revising a draft rather than writing fresh (e.g. as part of a scene draft session), paste the previous draft verbatim into compiledContext or sceneBeat along with what to change — Hanami has no way to know a previous attempt exists otherwise. Two behavior patterns confirmed in real supervised use, worth planning around: (1) scope discipline degrades sharply past roughly one paragraph per call — a multi-paragraph/multi-beat pass is meaningfully more likely to drop or alter content outside the intended change than a single-paragraph pass, so for precise revisions, scope each call to one paragraph at a time rather than the whole scene; (2) it will invent small unestablished physical details (a scar, an object, an expression) even under a general instruction to avoid embellishment — telling it not to do this needs to be explicit and specific nearly every call, not assumed as default behavior. Neither is 100% reliable even at single-paragraph scope, so diff the result against the prior draft (diff_drafts, or the automatic diff returned by record_scene_draft_iteration) rather than trusting a scoped instruction was followed. Pass bookId whenever this generation belongs to a real book (including every call within a scene draft session) — without it, this book's banned terms (Ghost Editor) are NOT checked or enforced, unlike POST /generate-prose which always enforces them. With bookId, any paragraph containing a banned term is automatically detected and regenerated before the result is returned to you, same guarantee as the normal generation endpoint.",
      inputSchema: {
        sceneBeat: z.string().describe("The scene beat to write"),
        compiledContext: z
          .string()
          .describe("The full context you've compiled — Codex info, manuscript excerpts, and any nuance from the conversation Hanami needs to write this scene consistently"),
        bookId: z
          .string()
          .optional()
          .describe("This book's ID — when provided, the result is checked against this book's banned terms and any offending paragraph is automatically regenerated. Omit only for a generation with no real book context."),
      },
    },
    async ({ sceneBeat, compiledContext, bookId }) => {
      try {
        const systemPrompt = buildSystemPrompt(compiledContext);
        const prose = await generateHanamiProse(systemPrompt, sceneBeat);

        if (!bookId) {
          return textResult(prose);
        }

        const bannedTerms = await listBannedTerms(bookId);
        if (bannedTerms.length === 0) {
          return textResult(prose);
        }

        const { finalText, corrections } = await enforceBannedTerms({
          text: prose,
          bannedTerms: bannedTerms.map((t) => t.term),
          systemPrompt,
        });

        if (corrections.length === 0) {
          return textResult(finalText);
        }

        const rewrittenTerms = [...new Set(corrections.flatMap((c) => c.bannedTermsFound))];
        return textResult(
          `${finalText}\n\n[Ghost Editor: ${corrections.length} paragraph(s) were automatically rewritten to remove banned term(s): ${rewrittenTerms.join(", ")}]`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "start_scene_draft_session",
    {
      title: "Start Scene Draft Session",
      description:
        "Starts a supervised drafting session for one scene beat — use this instead of a single generate_prose_direct call when you intend to iterate with Hanami (generate, critique against the plot points from brainstorming, redirect, regenerate) rather than accept the first draft. Persists the plot-point checklist and progress so the session can be resumed later, even in a different conversation, via list_scene_draft_sessions / get_scene_draft_session. Returns the new session's ID — pass this to record_scene_draft_iteration after each pass.",
      inputSchema: {
        userId: z.string().describe("The user's ID"),
        bookId: z.string().describe("The book's ID"),
        sceneBeat: z.string().describe("The scene beat being drafted"),
        plotPoints: z
          .array(z.string())
          .describe("The concrete beats/moments this scene must hit, from your brainstorming with the writer — each becomes a checklist item you mark satisfied as drafts land them"),
        chapterNumber: z.number().int().optional().describe("Chapter number this scene belongs to, if known"),
        label: z.string().optional().describe("Short human-readable label for this session"),
      },
    },
    async ({ userId, bookId, sceneBeat, plotPoints, chapterNumber, label }) => {
      try {
        const session = await startSceneDraftSession({ userId, bookId, sceneBeat, plotPoints, chapterNumber, label });
        return textResult(JSON.stringify(session, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "record_scene_draft_iteration",
    {
      title: "Record Scene Draft Iteration",
      description:
        "Logs one generate-critique pass in a scene draft session: the instruction you actually gave Hanami (MUST/MUST NOT directives, bracketed beat notes — be specific, not vague), the draft it produced, your honest critique of it, which plot points it satisfied, and what's still wrong. Call this after every generate_prose_direct call you make as part of a session, not just the last one — the point is a real audit trail the writer can inspect, not a single final summary. Updates the session's current draft and checklist. The response includes diffFromPrevious — an automatic word-level diff (format: {-removed-} / {+added+}) against the draft before this pass. Read it before trusting your own satisfiedPlotPoints claim: Hanami can silently drop or alter content outside the change you asked for even at narrow scope, and this is caught by checking the diff, not by re-reading the whole draft. If you're going to revise again, take the draftText you just recorded here and paste it verbatim into your next generate_prose_direct call — Hanami is stateless and won't remember writing it, so this tool call is what carries that continuity forward, not Hanami's own memory. Consider pausing to check in with the writer after a few passes rather than iterating indefinitely without one.",
      inputSchema: {
        sessionId: z.string().describe("The scene draft session ID"),
        draftText: z.string().describe("The draft Hanami produced this pass"),
        instructionsGiven: z.string().optional().describe("The actual MUST/MUST NOT/bracketed instructions you gave Hanami for this pass"),
        critique: z.string().optional().describe("Your assessment of this draft — what it got right, what you're redirecting and why"),
        satisfiedPlotPoints: z
          .array(z.string())
          .optional()
          .describe("Plot point descriptions (must match ones from startSceneDraftSession) that this draft satisfies"),
        openIssues: z.array(z.string()).optional().describe("Current outstanding issues with the draft — replaces the previous list, not additive"),
      },
    },
    async ({ sessionId, draftText, instructionsGiven, critique, satisfiedPlotPoints, openIssues }) => {
      try {
        const result = await recordSceneDraftIteration({
          sessionId,
          draftText,
          instructionsGiven,
          critique,
          satisfiedPlotPoints,
          openIssues,
        });
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "diff_drafts",
    {
      title: "Diff Drafts",
      description:
        "Word-level diff between two pieces of text (format: {-removed-} / {+added+}, plus word-added/word-removed counts). Use this to verify a Hanami revision actually did what you asked and nothing else — e.g. diff a locked paragraph before/after a pass that was only supposed to touch a different paragraph, or diff the full scene against an earlier accepted version before finishing a session. record_scene_draft_iteration already returns this automatically against the previous draft in a session; call this tool directly for any other comparison — two arbitrary drafts, a single paragraph in isolation, or a draft against manuscript memory.",
      inputSchema: {
        oldText: z.string().describe("The earlier version"),
        newText: z.string().describe("The later version to compare against it"),
      },
    },
    async ({ oldText, newText }) => {
      try {
        const result = diffDrafts(oldText, newText);
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "get_scene_draft_session",
    {
      title: "Get Scene Draft Session",
      description:
        "Fetches a scene draft session's current state (draft, plot-point checklist, open issues) plus the full pass-by-pass history. Each iteration includes diffFromPrevious — the word-level diff against the pass before it — so resuming shows the actual history of what changed each pass, not just critique text. Use this to resume a session — including one started in a different conversation — before continuing to iterate. Hanami itself remembers none of this; if you continue revising, paste the returned current_draft verbatim into your next generate_prose_direct call so Hanami has something concrete to revise from.",
      inputSchema: { sessionId: z.string().describe("The scene draft session ID") },
    },
    async ({ sessionId }) => {
      try {
        const result = await getSceneDraftSession(sessionId);
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "list_scene_draft_sessions",
    {
      title: "List Scene Draft Sessions",
      description:
        "Lists scene draft sessions for a book (most recently updated first), without full iteration history. Use this to find an in-progress session to resume — e.g. when the writer asks to continue a scene you were working on together.",
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        status: z.enum(["in_progress", "done", "abandoned"]).optional().describe("Optional filter by status"),
      },
    },
    async ({ bookId, status }) => {
      try {
        const sessions = await listSceneDraftSessions(bookId, status);
        return textResult(JSON.stringify(sessions, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "finish_scene_draft_session",
    {
      title: "Finish Scene Draft Session",
      description:
        "Marks a scene draft session done once you and the writer are satisfied with the draft. This does not save it into permanent manuscript memory — call save_manuscript_scene separately once the writer actually accepts it, since finishing a draft session and accepting prose into canon are different moments.",
      inputSchema: {
        sessionId: z.string().describe("The scene draft session ID"),
        finalDraft: z.string().optional().describe("The final draft text, if it differs from the last recorded iteration"),
      },
    },
    async ({ sessionId, finalDraft }) => {
      try {
        const session = await finishSceneDraftSession(sessionId, finalDraft);
        return textResult(JSON.stringify(session, null, 2));
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
        "Saves accepted prose into permanent manuscript memory (chunked and embedded), so future generations — automatic or Claude-assisted — can recall it, AND appends it to that chapter's content in the rich-text editor (manuscript_chapters) so the writer can see and edit it there too — creating the chapter row if it doesn't exist yet. Appends rather than replaces if the chapter already has editor content, so this never overwrites anything the writer was editing themselves. Call this once the writer has accepted a generated or hand-written scene.",
      inputSchema: {
        userId: z.string().describe("The user's ID"),
        bookId: z.string().describe("The book's ID"),
        chapterNumber: z.number().int().describe("Chapter number this scene belongs to"),
        rawText: z.string().describe("The full scene text to save"),
      },
    },
    async ({ userId, bookId, chapterNumber, rawText }) => {
      try {
        const result = await saveManuscriptScene({ userId, bookId, chapterNumber, rawText });
        return textResult(
          `Saved ${result.chunksSaved} chunk(s) to manuscript memory, and ${result.chapterAction} chapter ${chapterNumber}'s editor content.`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
