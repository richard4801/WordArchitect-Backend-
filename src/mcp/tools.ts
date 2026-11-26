import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { generateHanamiProse } from "../services/llm.js";
import { buildSystemPrompt } from "../routes/generateProse.js";
import { assembleContextPayload, buildVoiceSection } from "../services/rag.js";
import { saveManuscriptScene } from "../services/manuscriptSceneSave.js";
import { editManuscriptChapterContent, ManuscriptChapterNotFoundError } from "../routes/manuscriptChapters.js";
import { listCollaborationLearnings, addCollaborationLearning } from "../routes/collaborationLearnings.js";
import { getWritingVoiceProfile } from "../services/writingVoice.js";
import { listBannedTerms, addBannedTerm, removeBannedTerm } from "../services/bannedTerms.js";
import { enforceBannedTerms, MAX_REGENERATION_ATTEMPTS, MAX_SPOT_ATTEMPTS } from "../services/ghostEditor.js";
import { enforceNarration } from "../services/narrationEditor.js";
import { getBookNarrationSetting } from "../services/narrationSetting.js";
import { appendNarrationReminder, isNarrationEnforcementEnabled, describeNarration } from "../lib/narration.js";
import {
  startSceneDraftSession,
  recordSceneDraftIteration,
  getSceneDraftSession,
  listSceneDraftSessions,
  finishSceneDraftSession,
} from "../services/sceneDraftSessions.js";
import { diffDrafts } from "../lib/textDiff.js";
import { requestReviews, getReviewBrief, submitReviewVerdict, getSkillReview, checkReviewForAcceptance, describeReview, SkillReviewGateError } from "../services/skillReview.js";
import { scanForSlop, formatSlopScanNote } from "../skills/antiSlopScan.js";
import { recordManuscriptRead, manuscriptFirstRefusal } from "../services/manuscriptFirst.js";
import { recordPromptApproval, checkCallIsApproved, isGoGateEnabled, PromptApprovalError } from "../services/promptApproval.js";
import { getChapterWorkflow, describeWorkflow, nextStepLine } from "../services/chapterWorkflow.js";
import { renderProcessMarkdown, renderInstructions } from "../process/render.js";
import { PROCESS_VERSION } from "../process/drafting.js";
import { listBookRulings, addBookRuling, retireBookRuling, RULING_CATEGORIES } from "../services/bookRulings.js";
import { getPlanningRun as loadPlanningRunForReview, currentUnitKey, parentArtifactFor, formatLedger } from "../services/planningEngine.js";
import { listCodexEntries, getCodexEntry, searchManuscript, getManuscriptChapterText } from "../services/bookContextTools.js";
import { KNOWN_CODEX_ENTRY_TYPES, VALID_NOTE_CATEGORIES } from "../types/domain.js";
import type { NoteCategory } from "../types/domain.js";
import { listWorldCategories, slugify } from "../routes/worldCategories.js";
import { listBookLinksForBook, createBookLink, getPendingChaptersForLink } from "../routes/bookLinks.js";
import { listNotesForBook } from "../routes/notes.js";
import { listAgentPrompts, getAgentPromptById, createAgentPrompt, updateAgentPrompt, getActivePrompt } from "../services/agentPrompts.js";
import { getPlatformCraftNotes, savePlatformCraftNotes } from "../services/platformCraftNotes.js";
import {
  createPlanningRun,
  listPlanningRuns,
  getPlanningRun,
  generateStage,
  runCritique,
  approveStage,
  setPlanningDirective,
  editPlanningArtifact,
} from "../services/planningEngine.js";
import { VALID_PIPELINE_TYPES } from "../types/domain.js";
import type { PipelineType } from "../types/domain.js";
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
        const row = data as { book_id?: string; name?: string } | null;
        if (row?.book_id) await recordManuscriptRead({ bookId: row.book_id, tool: "get_codex_entry", entryName: row.name ?? null });
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
    "list_book_links",
    {
      title: "List Book Links",
      description:
        "Every relationship this book participates in, either direction — 'outgoing' means this book IS the link's fromBookId (e.g. it's a sequel or translation OF something else); 'incoming' means this book IS the link's toBookId (e.g. something else is a sequel or translation of it). Call this before create_book_link to check whether a relationship already exists, and to find the link id needed for get_pending_chapters.",
      inputSchema: { bookId: z.string().describe("The book's ID") },
    },
    async ({ bookId }) => {
      try {
        const links = await listBookLinksForBook(bookId);
        return textResult(JSON.stringify(links, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "create_book_link",
    {
      title: "Create Book Link",
      description:
        "Creates a directed relationship between two books — only call once the writer has confirmed the connection, not speculatively. Direction: fromBookId is the DERIVED book (the sequel, or the translation); toBookId is what it relates to (the original). Example — a Spanish translation: { fromBookId: <the translated book's id>, toBookId: <the original book's id>, linkType: 'translation_of', language: 'es' }. Example — a sequel: { fromBookId: <the sequel's id>, toBookId: <the original's id>, linkType: 'sequel_of' }. linkType is open-ended, not a fixed list — use 'sequel_of' or 'translation_of' for these two known cases, or invent a new descriptive value for a relationship neither covers. A book can only have ONE link of a given linkType — creating a second of the same type for the same fromBookId returns an error instead of replacing it; delete the existing one first if it needs to change.",
      inputSchema: {
        fromBookId: z.string().describe("The derived book's id (the sequel, or the translation)"),
        toBookId: z.string().describe("The original book's id that fromBookId relates to"),
        linkType: z.string().describe("e.g. 'sequel_of' or 'translation_of' — open-ended, not a fixed enum"),
        language: z.string().optional().describe("Only meaningful for translation_of, e.g. 'es' or 'Spanish'"),
      },
    },
    async ({ fromBookId, toBookId, linkType, language }) => {
      try {
        const link = await createBookLink({ fromBookId, toBookId, linkType, language: language ?? null });
        return textResult(JSON.stringify(link, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "get_pending_chapters",
    {
      title: "Get Pending Chapters For Book Link",
      description:
        "For a book link (get its id from list_book_links or the create_book_link response), returns every chapter with real drafted content in the SOURCE book (the link's toBookId) that has no corresponding chapter yet in the DERIVED book (the link's fromBookId). For a translation_of link, this is exactly 'what's new to translate since I last checked in' — the right thing to call at the start of a scheduled daily (or any periodic) translation session. Also returns sourceBookStatus, so the session knows when to stop checking entirely: once the source book's status is 'completed' and pendingChapters comes back empty, there is nothing left to ever come back for. There is no separate 'mark as translated' step or tool — once a chapter is translated, save it into the derived book with save_manuscript_scene using the SAME chapter number; that new chapter row is what removes it from this list on the next check.",
      inputSchema: { linkId: z.string().describe("The book_links row id") },
    },
    async ({ linkId }) => {
      try {
        const result = await getPendingChaptersForLink(linkId);
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
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

  server.registerTool(
    "get_collaboration_learnings",
    {
      title: "Get Collaboration Learnings",
      description:
        "Read this writer's growing, cross-book record of what's been learned actually working with them and with Hanami — a Hanami behavior pattern discovered during a supervised scene-draft session, a stated writing preference, a continuity miss worth remembering, anything worth not re-learning from scratch next time. Scoped to the writer (userId), not one book — applies across every project they have. Check this before a scene-draft session, before generate_prose_direct, or at the start of a brainstorming conversation, the same way you'd check preview_automatic_context or get_platform_craft_notes first. Conventional categories so far: hanami_behavior, writer_preference, continuity_flag, craft_note — but any category string is accepted.",
      inputSchema: {
        userId: z.string().describe("The writer's user ID"),
        category: z.string().optional().describe("Filter to one category, e.g. 'hanami_behavior'. Omit to get everything."),
      },
    },
    async ({ userId, category }) => {
      try {
        const learnings = await listCollaborationLearnings(userId, { category });
        return textResult(JSON.stringify(learnings, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "get_writing_voice",
    {
      title: "Get Writing Voice",
      description:
        "This writer's own prose voice, pasted once (POST /api/v1/writing-voice) and distilled into a compact, actionable style profile — sentence rhythm, dialogue conventions, POV/tense, pacing, tics to use or avoid. You don't need to call this before generate_prose_direct — passing userId there already fetches and injects this profile server-side automatically, the same way userId auto-enforces banned terms. This tool is for inspection: reading the profile back to discuss it with the writer, confirming one is actually set, or diagnosing why a generation doesn't sound like them (check extractionError — a failed analysis call leaves styleProfile at its last-good value, or null if there's never been a successful one). Returns null styleProfile if the writer hasn't pasted a sample yet.",
      inputSchema: { userId: z.string().describe("The writer's user ID") },
    },
    async ({ userId }) => {
      try {
        const profile = await getWritingVoiceProfile(userId);
        return textResult(JSON.stringify(profile ?? { userId, styleProfile: null }, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "record_collaboration_learning",
    {
      title: "Record Collaboration Learning",
      description:
        "Append a new entry to this writer's collaboration learnings — call this whenever you notice something worth remembering for next time: a Hanami behavior pattern (e.g. it dropped a clause during a revision, it invented an unestablished detail despite being told not to), a preference the writer stated (e.g. 'don't open chapters with weather', 'I want shorter beats'), a continuity thing that got missed, or any other craft/collaboration lesson. Unlike every other MCP write tool, this does NOT require the writer to have confirmed it first — it's your own operational memory, not new writer-facing canon (the same exemption this project's Planning Engine continuity ledger already has, see CLAUDE.md). Append-only in spirit: add a new entry rather than trying to edit an old one, even if it supersedes something you recorded before. bookId is optional provenance (which book this came up on) — omit it for a general Hanami pattern that isn't book-specific.",
      inputSchema: {
        userId: z.string().describe("The writer's user ID"),
        bookId: z.string().optional().describe("Optional — which book this was learned on, if book-specific"),
        category: z
          .string()
          .describe("A short category label, e.g. 'hanami_behavior', 'writer_preference', 'continuity_flag', 'craft_note', or your own"),
        lesson: z.string().describe("The lesson itself, stated concretely enough to be useful cold, with no assumed context"),
      },
    },
    async ({ userId, bookId, category, lesson }) => {
      try {
        const learning = await addCollaborationLearning({ userId, bookId: bookId ?? null, category, lesson });
        return textResult(JSON.stringify(learning, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
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
        await recordManuscriptRead({ bookId, tool: "search_manuscript", query });
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
        "Fetch every stored chunk of a specific chapter, in order, concatenated into the full chapter text, plus that chapter's editor title (manuscript_chapters.title, null if this chapter has no editor row yet). Use this when you need literal chapter content rather than a similarity-matched excerpt — e.g. to verify exactly how a scene played out.",
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        chapterNumber: z.number().int().describe("The chapter number"),
      },
    },
    async ({ bookId, chapterNumber }) => {
      try {
        const result = await getManuscriptChapterText(bookId, chapterNumber);
        await recordManuscriptRead({ bookId, tool: "get_manuscript_chapter", chapterNumber });
        return textResult(JSON.stringify(result, null, 2));
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
    "list_banned_terms",
    {
      title: "List Banned Terms",
      description:
        "Lists every word or phrase this writer has banned. Bans apply to ALL of the writer's books, not just one. Every generate_prose_direct call already enforces them automatically (the Ghost Editor rewrites any paragraph that contains one), so you never need to pass them to Hanami yourself.",
      inputSchema: { userId: z.string().describe("The writer's user ID") },
    },
    async ({ userId }) => {
      try {
        const terms = await listBannedTerms(userId);
        if (terms.length === 0) return textResult("This writer has no banned terms.");
        return textResult(`${terms.length} banned term(s):\n${terms.map((t) => `- "${t.term}"`).join("\n")}`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "ban_term",
    {
      title: "Ban a Term",
      description:
        "Bans a word or phrase for this writer, across ALL their books, from the next Hanami call on. Only call this when the writer has asked for the ban in this conversation, with the exact wording they want banned. Matching is case-insensitive and by substring, so banning \"delve\" also catches \"delved\" but not \"delving\": ban each form the writer wants gone. Banning a term that is already banned is a harmless no-op.",
      inputSchema: {
        userId: z.string().describe("The writer's user ID"),
        bookId: z.string().describe("The book currently open (stored as provenance only; the ban covers every book)"),
        term: z.string().describe("The exact word or phrase to ban"),
      },
    },
    async ({ userId, bookId, term }) => {
      try {
        const { term: row, alreadyExisted } = await addBannedTerm({ userId, bookId, term });
        return textResult(alreadyExisted ? `"${row.term}" was already banned. Nothing changed.` : `Banned "${row.term}" for this writer, across all their books.`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "unban_term",
    {
      title: "Unban a Term",
      description: "Removes a word or phrase from this writer's banned list. Only call this when the writer has asked for it in this conversation. Matches the term case-insensitively.",
      inputSchema: {
        userId: z.string().describe("The writer's user ID"),
        term: z.string().describe("The banned word or phrase to remove, as listed by list_banned_terms"),
      },
    },
    async ({ userId, term }) => {
      try {
        const wanted = term.trim().toLowerCase();
        const match = (await listBannedTerms(userId)).find((t) => t.term.toLowerCase() === wanted);
        if (!match) return errorResult(`"${term}" is not on this writer's banned list. Call list_banned_terms to see the exact entries.`);
        await removeBannedTerm(match.id);
        return textResult(`Removed "${match.term}" from the banned list.`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "get_drafting_process",
    {
      title: "Get Drafting Process",
      description:
        "Returns the full, current drafting process (who does what, the 12 steps and which the backend enforces, how a Hanami call is built, how to correct what comes back, Hanami's known behaviour, the reviewers, the craft rules, saving, and what changed since the author's 26 Nov document). Call it at the start of any drafting work; it outranks any older copy of the process you may have.",
      inputSchema: {},
    },
    async () => textResult(renderProcessMarkdown())
  );

  server.registerTool(
    "get_chapter_workflow",
    {
      title: "Get Chapter Workflow",
      description:
        "Where a chapter stands in the drafting process, kept server-side so a new session resumes where the last stopped: manuscript lookups, the beat card's review, the author's recorded Go (with their words), every Hanami call made under it (approved prompt or rerun, with the reason), draft sessions, the prose review, and whether it's saved. Ends with the next required step. Call it when picking a chapter back up, and whenever you're unsure what comes next.",
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        chapterNumber: z.number().int().describe("The chapter"),
      },
    },
    async ({ bookId, chapterNumber }) => {
      try {
        return textResult(describeWorkflow(await getChapterWorkflow(bookId, chapterNumber)));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "record_prompt_approval",
    {
      title: "Record the Author's Go",
      description:
        "Records the author's Go on the exact Hanami prompts for a chapter's beats. Call it ONLY after you have shown the author every prompt (compiledContext and sceneBeat per beat) and they have said Go in this conversation; writerApproval is their words, quoted exactly, never your paraphrase and never assumed. Requires the beat card's completed review (cardReviewId from request_reviews with targetType beat_card); a BLOCKED or incomplete card review needs writerOverride with the author's own reason. Returns the approvalId that generate_prose_direct requires. The beats are matched by sceneBeat (compiledContext is stored for the author to see but may change between beats as accepted prose becomes the anchor). A new beat or a changed fact needs a new Go. The backend cannot prove the author said the words you quote: they are stored and shown back to the author, so quote exactly.",
      inputSchema: {
        userId: z.string().describe("The writer's user ID"),
        bookId: z.string().describe("The book's ID"),
        chapterNumber: z.number().int().describe("The chapter these beats are for"),
        cardReviewId: z.string().optional().describe("The reviewId of the beat card's review (request_reviews, targetType beat_card). Required unless the card-review gate is switched off."),
        beats: z
          .array(
            z.object({
              label: z.string().describe("Short label, e.g. 'M1 The hall empties'"),
              sceneBeat: z.string().describe("The exact sceneBeat shown to the author"),
              compiledContext: z.string().describe("The exact compiledContext shown to the author"),
            })
          )
          .min(1)
          .describe("Every prompt the author approved, in order. Index 0 is the first."),
        writerApproval: z.string().describe("The author's own words of approval, quoted exactly (e.g. \"Go\")"),
        writerOverride: z.string().optional().describe("Only when the card review is BLOCKED or incomplete and the author chose to go ahead: their reason, in their words"),
      },
    },
    async ({ userId, bookId, chapterNumber, cardReviewId, beats, writerApproval, writerOverride }) => {
      try {
        const { approval, note } = await recordPromptApproval({ userId, bookId, chapterNumber, cardReviewId, beats, writerApproval, writerOverride });
        return textResult(
          [
            `approvalId: ${approval.id}`,
            `Recorded the author's Go ("${approval.writer_approval}") on ${approval.beats.length} beat(s) for chapter ${chapterNumber}: ${approval.beats.map((b) => `${b.index} ${b.label}`).join("; ")}. ${note}`,
            "Next required step: send the beats to Hanami ONE AT A TIME with generate_prose_direct, passing this approvalId; for a narrow rerun of a beat pass rerunOfBeat (its index) and rerunReason. Log each pass with record_scene_draft_iteration.",
          ].join("\n")
        );
      } catch (err) {
        if (err instanceof PromptApprovalError) return errorResult(err.message);
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerPrompt(
    "chapter_workflow",
    {
      title: `Drafting process v${PROCESS_VERSION}`,
      description: "The WordArchitect drafting process: the steps for every chapter, which the backend enforces, and how to build a Hanami call.",
    },
    () => ({
      messages: [{ role: "user", content: { type: "text", text: `${renderInstructions()}\n\n${renderProcessMarkdown()}` } }],
    })
  );

  server.registerTool(
    "generate_prose_direct",
    {
      title: "Generate Prose (Direct)",
      description:
        "Sends a scene beat straight to Hanami along with context YOU compile and supply — bypassing the automatic Layer 1/2/3 retrieval pipeline entirely. Compile compiledContext yourself from what you've gathered via search_manuscript, get_codex_entry, and this conversation with the writer — Hanami will write from exactly what you give it and nothing else, so make sure it's actually complete before calling this. Returns the full generated prose (not streamed). Every call is completely stateless — Hanami has no memory of any previous call, including its own prior drafts. If you're revising a draft rather than writing fresh (e.g. as part of a scene draft session), paste the previous draft verbatim into compiledContext or sceneBeat along with what to change — Hanami has no way to know a previous attempt exists otherwise. Two behavior patterns confirmed in real supervised use, worth planning around: (1) scope discipline degrades sharply past roughly one paragraph per call — a multi-paragraph/multi-beat pass is meaningfully more likely to drop or alter content outside the intended change than a single-paragraph pass, so for precise revisions, scope each call to one paragraph at a time rather than the whole scene; (2) it will invent small unestablished physical details (a scar, an object, an expression) even under a general instruction to avoid embellishment — telling it not to do this needs to be explicit and specific nearly every call, not assumed as default behavior. Neither is 100% reliable even at single-paragraph scope, so diff the result against the prior draft (diff_drafts, or the automatic diff returned by record_scene_draft_iteration) rather than trusting a scoped instruction was followed. userId is REQUIRED (not optional) — without it, this writer's banned terms (Ghost Editor) would NOT be checked and their Writing Voice profile would NOT be applied, both silently, with no error to signal it; this was a real, extended gap in practice until the parameter was made mandatory, so there is no way to skip it. With userId, any paragraph containing a term this writer has banned (across ANY of their books — banned terms are scoped per-writer, not per-book) is automatically detected and regenerated before the result is returned to you, same guarantee as the normal generation endpoint — if a term survives 3 regeneration attempts, the response says so explicitly rather than implying success. This writer's Writing Voice style profile (if they've pasted a sample) is also automatically fetched and injected into the system prompt server-side — you don't need to call get_writing_voice or fold anything into compiledContext yourself for this. Worth calling get_collaboration_learnings for this writer before a real drafting session — it may already have Hanami quirks or writer preferences specific to them beyond the general patterns listed above. bookId is ALSO REQUIRED: it is how this book's narration switch (point of view + tense, set on the book itself) is looked up. When the book has one, the backend injects the rule into the prompt, restates it right before the scene beat, then checks the returned prose and rewrites any paragraph that slips (wrong tense, wrong person) — you do not need to write 'first person, past tense' into compiledContext yourself, and you should not have to re-check it by eye. If a paragraph still breaks the setting after the retries, the response says so with a WARNING instead of implying success. approvalId is ALSO REQUIRED (the recorded Go): before the first Hanami call for a card, show the author the exact prompts and ask; when they say Go, call record_prompt_approval with the beats and their words quoted, and pass the returned approvalId here. The call is refused unless sceneBeat is one of the approved beats; for a narrow rerun of an approved beat (a broken paragraph, an author's comment) pass rerunOfBeat with the beat's index and rerunReason. A new beat or a changed fact needs a new Go. Every call is logged for the author (get_chapter_workflow).",
      inputSchema: {
        sceneBeat: z.string().describe("The scene beat to write"),
        compiledContext: z
          .string()
          .describe("The full context you've compiled — Codex info, manuscript excerpts, and any nuance from the conversation Hanami needs to write this scene consistently"),
        userId: z
          .string()
          .describe(
            "The writer's user ID — required. Enforces this writer's banned terms (Ghost Editor, across ALL their books) and injects their Writing Voice style profile, both automatically. Previously optional; made mandatory because an omitted userId silently skipped both checks with no error, which is exactly what happened in practice."
          ),
        bookId: z
          .string()
          .describe(
            "The book's ID — required. Looks up this book's narration switch (point of view + tense) so the backend can inject and enforce it automatically. Required for the same reason userId is: an optional parameter gating a guarantee is a silent-failure trap."
          ),
        approvalId: z
          .string()
          .describe("Required. The id record_prompt_approval returned when the author said Go on these prompts."),
        rerunOfBeat: z
          .number()
          .int()
          .optional()
          .describe("Only for a narrow rerun of an approved beat: that beat's index in the approval. The rerun's prompt is logged for the author."),
        rerunReason: z
          .string()
          .optional()
          .describe("Required with rerunOfBeat: what was broken in the pass, or the author's comment the rerun answers."),
      },
    },
    async ({ sceneBeat, compiledContext, userId, bookId, approvalId, rerunOfBeat, rerunReason }) => {
      try {
        const refusal = await manuscriptFirstRefusal("Sending this to Hanami", bookId, `${sceneBeat}\n\n${compiledContext}`);
        if (refusal) return errorResult(refusal);
        let goNote = "";
        if (isGoGateEnabled()) {
          try {
            const covered = await checkCallIsApproved({ bookId, approvalId, sceneBeat, compiledContext, rerunOfBeat, rerunReason });
            goNote = `[Go: chapter ${covered.approval.chapter_number}, beat ${covered.beat.index} "${covered.beat.label}", ${covered.kind === "rerun" ? "rerun (logged)" : "approved prompt"}; author's words: "${covered.approval.writer_approval}"]`;
          } catch (err) {
            if (err instanceof PromptApprovalError) return errorResult(err.message);
            throw err;
          }
        }
        const voiceProfile = await getWritingVoiceProfile(userId);
        const voiceSection = buildVoiceSection(voiceProfile?.style_profile ?? null);
        const effectiveContext = voiceSection ? [voiceSection, compiledContext].join("\n\n---\n\n") : compiledContext;

        // The book's narration switch, if configured: standard wording goes
        // into the system prompt and is echoed at the end of the user turn,
        // and the finished prose is verified below. Null = book has no
        // (or only a partial) POV/tense setting, nothing is added or checked.
        const narration = await getBookNarrationSetting(bookId);
        const systemPrompt = buildSystemPrompt(effectiveContext, narration);
        const userMessage = narration ? appendNarrationReminder(sceneBeat, narration) : sceneBeat;
        let prose = await generateHanamiProse(systemPrompt, userMessage);

        let narrationNote = "";
        if (narration && isNarrationEnforcementEnabled()) {
          const narrationResult = await enforceNarration({ text: prose, setting: narration, systemPrompt, userMessage });
          prose = narrationResult.finalText;
          const fixed = narrationResult.corrections.filter((c) => c.resolved);
          const unresolved = narrationResult.corrections.filter((c) => !c.resolved);
          const parts: string[] = [];
          if (fixed.length > 0) {
            parts.push(
              `${fixed.length} correction(s) were automatically made to keep the narration in ${describeNarration(narration)}.`
            );
          }
          if (unresolved.length > 0) {
            parts.push(
              `WARNING: ${unresolved.length} passage(s) still break the narration setting (${describeNarration(narration)}) after ${MAX_REGENERATION_ATTEMPTS} rewrite attempts and were returned as-is. Review them yourself before showing this draft to the writer.`
            );
          }
          if (parts.length > 0) narrationNote = `[Narration check: ${parts.join(" ")}]`;
        }
        // Skill 07's free deterministic half runs on every draft: a regex scan,
        // not a verdict. The real anti-slop review (and every other skill) runs
        // through request_reviews, which save_manuscript_scene requires.
        const slopNoteFor = (text: string) => formatSlopScanNote(scanForSlop(text));
        const withNarrationNote = (text: string) => {
          const notes = [narrationNote, slopNoteFor(text), goNote].filter(Boolean);
          return notes.length ? `${text}\n\n${notes.join("\n\n")}` : text;
        };

        const bannedTerms = await listBannedTerms(userId);
        if (bannedTerms.length === 0) {
          return textResult(withNarrationNote(prose));
        }

        const { finalText, corrections } = await enforceBannedTerms({
          text: prose,
          bannedTerms: bannedTerms.map((t) => t.term),
          systemPrompt,
        });

        if (corrections.length === 0) {
          return textResult(withNarrationNote(finalText));
        }

        const resolvedCorrections = corrections.filter((c) => c.resolved);
        const unresolvedCorrections = corrections.filter((c) => !c.resolved);
        const notes: string[] = [];
        if (resolvedCorrections.length > 0) {
          const rewrittenTerms = [...new Set(resolvedCorrections.flatMap((c) => c.bannedTermsFound))];
          const spots = resolvedCorrections.flatMap((c) => c.spots ?? []).filter((f) => f.resolved);
          const byHanami = spots.filter((f) => f.engine === "hanami").length;
          notes.push(
            `${spots.length || resolvedCorrections.length} sentence(s) were automatically rewritten to remove banned term(s): ${rewrittenTerms.join(", ")}${byHanami ? ` (${byHanami} by Hanami after the Sonnet editor declined)` : ""}.`
          );
        }
        if (unresolvedCorrections.length > 0) {
          const stillPresentTerms = [...new Set(unresolvedCorrections.flatMap((c) => c.bannedTermsFound))];
          notes.push(
            `WARNING: ${unresolvedCorrections.length} paragraph(s) still contain banned term(s) after up to ${MAX_SPOT_ATTEMPTS} rewrite attempts per sentence and were returned as-is: ${stillPresentTerms.join(", ")}. Review these paragraphs yourself before showing this draft to the writer.`
          );
        }

        const slopNote = slopNoteFor(finalText);
        return textResult(
          [finalText, `[Ghost Editor: ${notes.join(" ")}]`, narrationNote, slopNote, goNote].filter(Boolean).join("\n\n")
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
        const refusal = await manuscriptFirstRefusal("Starting this draft session", bookId, `${sceneBeat}\n\n${plotPoints.join("\n")}`);
        if (refusal) return errorResult(refusal);
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
        "Marks a scene draft session done once you and the writer are satisfied with the draft. This does not save it into permanent manuscript memory — call save_manuscript_scene separately once the writer actually accepts it, since finishing a draft session and accepting prose into canon are different moments. If this session surfaced a real Hanami behavior pattern or a writer preference worth remembering for next time, call record_collaboration_learning before wrapping up — a multi-pass session is exactly where those tend to show up.",
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
    "request_reviews",
    {
      title: "Request Skill Reviews",
      description:
        "Starts the independent reviews of a piece of text and returns one launch prompt per applicable reviewer skill. Reviews are NOT run by you: for each launch prompt, spawn a SEPARATE subagent (Opus) with that prompt verbatim. Each subagent fetches its own brief from the backend (get_review_brief), judges the text, and submits its own verdict (submit_review_verdict); you never see or edit the brief, and you must never write or submit a verdict yourself — the work must not grade itself. The backend builds the context each reviewer gets (Codex entries named in the text, the end of the previous chapter, this chapter's planned beats, the author's pinned notes, the narration setting); you supply only the text and where it sits. save_manuscript_scene requires the returned reviewId, refuses while any review is still pending, and checks that the saved text is exactly the reviewed text. Run this on the final text after your last edit. Show the author every FLAG before saving.",
      inputSchema: {
        userId: z.string().describe("The writer's user ID"),
        bookId: z.string().describe("The book's ID"),
        text: z.string().describe("The exact text to review — the same text you intend to save"),
        targetType: z
          .enum(["beat_card", "prose_fragment", "prose_scene", "prose_chapter"])
          .describe("beat_card: a chapter card (POV, time, place, cast, hard facts, the moments in order, rules), reviewed before the author says Go; prose_fragment: a paragraph or a few; prose_scene: one scene; prose_chapter: a whole chapter"),
        chapterNumber: z.number().int().optional().describe("Chapter this text belongs to — strongly recommended: it is how reviewers get the previous chapter's ending and this chapter's beats"),
        sceneDraftSessionId: z.string().optional().describe("The scene draft session this text came from, if any (for the record)"),
      },
    },
    async ({ userId, bookId, text, targetType, chapterNumber, sceneDraftSessionId }) => {
      try {
        const refusal = await manuscriptFirstRefusal("Requesting reviews", bookId, text);
        if (refusal) return errorResult(refusal);
        const { review, items, launches } = await requestReviews({
          userId,
          bookId,
          text,
          targetType,
          chapterNumber: chapterNumber ?? null,
          sceneDraftSessionId: sceneDraftSessionId ?? null,
        });
        const skipped = items.filter((i) => i.status === "not_applicable").map((i) => `${i.brief.title} (${i.reason})`);
        const body = [
          `reviewId: ${review.id}`,
          `${launches.length} reviewer(s) to launch. Spawn ONE separate subagent per prompt below, passing the prompt verbatim; run them in parallel. Do not review the text yourself and do not submit verdicts yourself.`,
          ...launches.map((l, n) => `\n--- Reviewer ${n + 1}: ${l.title} (briefId ${l.briefId}) ---\n${l.prompt}`),
          skipped.length ? `\nNot applicable here: ${skipped.join("; ")}.` : "",
          targetType === "beat_card"
            ? `\nWhen every subagent has replied, call get_skill_review with reviewId ${review.id}, apply the fixes to the card and report them to the author. Then show the author the exact Hanami prompts; when they say Go, call record_prompt_approval with cardReviewId ${review.id}.`
            : `\nWhen every subagent has replied, call get_skill_review with reviewId ${review.id} and show the author the verdicts. Then save_manuscript_scene with skillReviewId ${review.id}.`,
        ];
        return textResult(body.filter(Boolean).join("\n"));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "request_planning_reviews",
    {
      title: "Request Skill Reviews of a Planning Unit",
      description:
        "Starts the independent skill reviews of a Planning Engine run's CURRENT unit (Core Summary, Act summary, Part outline or beats) and returns one launch prompt per applicable skill, exactly like request_reviews: spawn ONE separate subagent per prompt, verbatim; each fetches its own brief and submits its own verdict. The backend supplies the unit's draft, the Book Vision, the parent unit and the continuity ledger. This complements critique_planning_unit's three critics; it does not replace them, and approving the unit is not gated on it.",
      inputSchema: {
        userId: z.string().describe("The writer's user ID"),
        runId: z.string().describe("The planning_runs row ID"),
      },
    },
    async ({ userId, runId }) => {
      try {
        const run = await loadPlanningRunForReview(runId);
        const unit = currentUnitKey(run);
        const artifact = run.stage_artifacts[unit];
        if (!artifact) return errorResult(`The run's current unit (${unit}) has no draft yet. Generate it first.`);
        const stage = run.current_stage as import("../types/domain.js").RealPlanningStage;
        const extraContext = [
          "# Book Vision (the approved Core Summary)",
          run.stage_artifacts["stage_1_summary"] ?? "(none yet)",
          "",
          "# Parent unit (what this unit expands)",
          parentArtifactFor(run) || "(none)",
          "",
          "# Continuity ledger (hard facts so far)",
          formatLedger(run.continuity_ledger) || "(empty)",
        ].join("\n");
        const { review, items, launches } = await requestReviews({
          userId,
          bookId: run.book_id,
          text: artifact,
          targetType: "planning_unit",
          planningRunId: run.id,
          planningUnit: unit,
          planningStage: stage,
          extraContext,
        });
        const skipped = items.filter((i) => i.status === "not_applicable").map((i) => i.brief.title);
        return textResult(
          [
            `reviewId: ${review.id} (unit ${unit})`,
            `${launches.length} reviewer(s) to launch. Spawn ONE separate subagent per prompt, verbatim, in parallel. Do not review or submit verdicts yourself.`,
            ...launches.map((l, n) => `\n--- Reviewer ${n + 1}: ${l.title} (briefId ${l.briefId}) ---\n${l.prompt}`),
            skipped.length ? `\nNot applicable at ${stage}: ${skipped.join("; ")}.` : "",
            `\nWhen every subagent has replied, call get_skill_review with reviewId ${review.id} and show the author the findings alongside the critics'.`,
          ]
            .filter(Boolean)
            .join("\n")
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "list_book_rulings",
    {
      title: "List the Author's Rulings",
      description:
        "Lists the author's standing rulings for this book (house rules, banned patterns, voice rulings, e.g. \"no dashes except cut-off dialogue\", \"never quote past dialogue in a memory\"). They outrank every craft rule, every reviewer sees them, and the gatekeeper can BLOCK on a violation. Read these before building a card or a Hanami prompt.",
      inputSchema: { bookId: z.string().describe("The book's ID") },
    },
    async ({ bookId }) => {
      try {
        const rulings = await listBookRulings(bookId);
        if (rulings.length === 0) return textResult("No rulings recorded for this book yet.");
        return textResult(rulings.map((r) => `- [${r.category}] ${r.ruling}${r.source ? ` (${r.source})` : ""} — id ${r.id}`).join("\n"));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "add_book_ruling",
    {
      title: "Record an Author Ruling",
      description:
        "Records a standing ruling the author has just made for this book, in their own terms, so every reviewer and every future session holds to it. Only call this when the author has made the ruling in this conversation; never invent one. Include where it came from (a chapter, or 'author, <date>').",
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        ruling: z.string().describe("The ruling, stated plainly"),
        category: z.enum(RULING_CATEGORIES).optional().describe("house_rule | banned_pattern | voice | ruling"),
        source: z.string().optional().describe("Where it came from, e.g. 'ch573' or 'author, 26 Nov'"),
      },
    },
    async ({ bookId, ruling, category, source }) => {
      try {
        const r = await addBookRuling({ bookId, ruling, category: category ?? "ruling", source: source ?? null });
        return textResult(`Recorded: [${r.category}] ${r.ruling}`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "retire_book_ruling",
    {
      title: "Retire an Author Ruling",
      description: "Retires a ruling the author has withdrawn (it stays in the history, no longer applied). Only when the author asks. Use the id from list_book_rulings.",
      inputSchema: { rulingId: z.string().describe("The ruling's id") },
    },
    async ({ rulingId }) => {
      try {
        await retireBookRuling(rulingId);
        return textResult("Ruling retired.");
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "get_review_brief",
    {
      title: "Get Review Brief",
      description:
        "For a REVIEWER SUBAGENT only: fetches your brief (rubric, criteria, the backend-built context, the exact text, and how to submit) by the briefId in your launch prompt. A drafting session should never call this — reviewing your own draft defeats the review.",
      inputSchema: { briefId: z.string().describe("The briefId from your launch prompt") },
    },
    async ({ briefId }) => {
      try {
        return textResult(await getReviewBrief(briefId));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "submit_review_verdict",
    {
      title: "Submit Review Verdict",
      description:
        "For a REVIEWER SUBAGENT only: submits your verdict for a brief. The backend checks that every criterion is answered and that every evidence quote appears verbatim in the reviewed text; if not, it tells you what to fix and you submit again (3 attempts). An accepted verdict is final and can't be replaced. If you decline to review, submit {\"refused\": true, \"reason\": \"...\"} — never stay silent, since an unsubmitted review blocks the save. A drafting session must never call this.",
      inputSchema: {
        briefId: z.string().describe("The briefId from your launch prompt"),
        verdict: z.string().describe("Your verdict as a JSON string, in the shape your brief specifies"),
        reviewerModel: z.string().optional().describe("The model you are running on, e.g. 'Opus 5.5'"),
      },
    },
    async ({ briefId, verdict, reviewerModel }) => {
      try {
        const out = await submitReviewVerdict({ briefId, verdict, reviewerModel: reviewerModel ?? null });
        if (!out.accepted) {
          return errorResult(`Verdict NOT accepted (${out.attemptsLeft} attempt(s) left). Fix these and submit again:\n- ${(out.errors ?? []).join("\n- ")}`);
        }
        const note = out.errors?.length ? ` Recorded as reviewer_error after too many invalid submissions: ${out.errors.slice(0, 2).join(" ")}` : "";
        return textResult(`Verdict recorded: ${out.item.status}. Overall review status now: ${out.overall}.${note}`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "get_skill_review",
    {
      title: "Get Skill Review",
      description:
        "Fetches one review by id: overall status (pending / passed / flagged / blocked / incomplete), each reviewer's status, its BLOCK and FLAG findings with exact quotes and fix shapes, which model ran it, and any author override. Show the author every FLAG and BLOCK.",
      inputSchema: { reviewId: z.string().describe("The review id from request_reviews") },
    },
    async ({ reviewId }) => {
      try {
        const { review, items } = await getSkillReview(reviewId);
        return textResult(`${describeReview(review, items)}\n\n${JSON.stringify(items.map((i) => ({ skill: i.skill, status: i.status, reason: i.reason, reviewerModel: i.reviewer_model, verdict: i.verdict })), null, 2)}`);
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
        "Saves accepted prose into permanent manuscript memory (chunked and embedded), so future generations — automatic or Claude-assisted — can recall it, AND appends it to that chapter's content in the rich-text editor (manuscript_chapters) so the writer can see and edit it there too — creating the chapter row if it doesn't exist yet. Appends rather than replaces if the chapter already has editor content, so this never overwrites anything the writer was editing themselves. Call this once the writer has accepted a generated or hand-written scene. skillReviewId is REQUIRED: the reviewId from request_reviews on the exact rawText, after every reviewer subagent has submitted. The save is refused while any review is pending, if the review belongs to another book, or if it was run on different text (content hash). FLAGs never block (show them to the author). A BLOCK, or a review a reviewer couldn't complete, refuses the save unless writerOverride carries the author's own reason (stored and shown to the author). Never invent an override the author didn't give.",
      inputSchema: {
        userId: z.string().describe("The user's ID"),
        bookId: z.string().describe("The book's ID"),
        chapterNumber: z.number().int().describe("Chapter number this scene belongs to"),
        rawText: z.string().describe("The full scene text to save"),
        skillReviewId: z
          .string()
          .describe(
            "Required. The reviewId returned by request_reviews for this exact rawText. Required (not optional) because an optional gate is a silent-failure trap (LEARNINGS 2026-10-20)."
          ),
        writerOverride: z
          .string()
          .optional()
          .describe(
            "Only when the review is BLOCKED or incomplete AND the author has decided to keep the text anyway: the author's reason, in their words. Stored on the review and shown back to them."
          ),
        chapterTitle: z
          .string()
          .optional()
          .describe(
            "Optional title for this chapter. Only used if this call is what creates the chapter (chapterNumber has no existing manuscript_chapters row yet) — ignored if the chapter already exists, since an existing chapter's title is never overwritten by a later saved scene."
          ),
      },
    },
    async ({ userId, bookId, chapterNumber, rawText, skillReviewId, writerOverride, chapterTitle }) => {
      try {
        const refusal = await manuscriptFirstRefusal("Saving this scene", bookId, rawText);
        if (refusal) return errorResult(refusal);
        let gateNote: string;
        try {
          const gate = await checkReviewForAcceptance({ bookId, text: rawText, skillReviewId, writerOverride: writerOverride ?? null });
          gateNote = gate.note;
        } catch (err) {
          if (err instanceof SkillReviewGateError) return errorResult(err.message);
          throw err;
        }
        const result = await saveManuscriptScene({
          userId,
          bookId,
          chapterNumber,
          rawText,
          chapterTitle: chapterTitle ?? null,
        });
        const next = await nextStepLine(bookId, chapterNumber);
        return textResult(
          [`Saved ${result.chunksSaved} chunk(s) to manuscript memory, and ${result.chapterAction} chapter ${chapterNumber}'s editor content. ${gateNote}`, next].filter(Boolean).join("\n\n")
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "edit_manuscript_chapter",
    {
      title: "Edit Manuscript Chapter",
      description:
        "Replaces (not appends) an already-saved chapter's editor content (manuscript_chapters.paragraphs) with corrected full text — the counterpart to save_manuscript_scene's append-only behavior, for fixing something already saved (a typo, a dropped clause, a factual correction) rather than adding a new scene. Fetch the chapter's current text with get_manuscript_chapter first, make your correction, and send back the COMPLETE corrected chapter text here, not just the changed portion — this replaces every paragraph. Does NOT touch manuscript_chunks (Deep Past retrieval memory); the correction stays stale there until the writer syncs via the app's existing sync-to-memory action, the same as any other editor edit. Fails if no chapter row exists yet for this bookId+chapterNumber — use save_manuscript_scene to create one first. Regenerates every paragraph object from scratch, so any existing inline comment threads on this chapter are not preserved across the edit. Only call this once the writer has actively confirmed the correction, never speculatively.",
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        chapterNumber: z.number().int().describe("Chapter number to edit — must already have a manuscript_chapters row"),
        rawText: z.string().describe("The COMPLETE corrected chapter text, replacing everything currently saved for this chapter"),
      },
    },
    async ({ bookId, chapterNumber, rawText }) => {
      try {
        const result = await editManuscriptChapterContent(bookId, chapterNumber, rawText);
        return textResult(`Replaced chapter ${chapterNumber}'s editor content with ${result.paragraphCount} paragraph(s).`);
      } catch (err) {
        if (err instanceof ManuscriptChapterNotFoundError) return errorResult(err.message);
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // Planning Engine supervision — lets an MCP-connected Claude session act
  // as the Arbitrator directly, in live conversation with the writer,
  // instead of relying only on the automated arbitrator_panel Sonnet call
  // or the app's own chat-interview flow. The critics stay automated (see
  // critique_planning_unit below) — what moves here is synthesis and
  // enforcement: reading the critics' findings and the current draft,
  // deciding what genuinely needs to change, writing the directive, and
  // verifying after regeneration that it actually landed, the same
  // generate-critique-redirect discipline already proven for Hanami via
  // the scene-draft-session tools above. See CLAUDE.md's Planning Engine
  // section for the full generate/critique/arbitrate/approve cycle these
  // tools drive the same steps of.
  //
  // Cost note, stated plainly in each write tool's description below:
  // generate_planning_unit and critique_planning_unit still bill this
  // backend's own Anthropic API key exactly like clicking the equivalent
  // button in the app — only the Arbitrator's reasoning moves off that
  // bill, since it happens in this live session instead of as an
  // automated call.

  server.registerTool(
    "create_planning_run",
    {
      title: "Create Planning Run",
      description:
        "Starts a brand-new Planning Engine run for a book, in the intake conversation (status: intake_active) — NOT Stage 1 generation yet, and no LLM call happens here. Once created, DON'T reach for a separate intake-chat tool — there isn't one, and you don't need it: just have the intake conversation directly with the writer in THIS session (premise, POV/conflict, romantic dynamic, tone, hard limits — whatever a Core Summary needs), for free, since that's just live conversation. Once you have enough to write a strong creative brief, compile it yourself and call set_planning_directive with it — that flips the run to 'generating' and opens Stage 1 exactly the same way the app's own intake-finalize does, no separate tool needed for that either.",
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        userId: z.string().describe("The user's ID"),
        pipelineType: z
          .enum(VALID_PIPELINE_TYPES as [PipelineType, ...PipelineType[]])
          .optional()
          .describe("'full' (default) for the whole-book Act/Part/Beats hierarchy, or 'contract' for the 5-chapter contract-qualification track"),
      },
    },
    async ({ bookId, userId, pipelineType }) => {
      try {
        const run = await createPlanningRun(pipelineType ? { bookId, userId, pipelineType } : { bookId, userId });
        return textResult(JSON.stringify(run, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "list_planning_runs",
    {
      title: "List Planning Runs",
      description:
        "Lists a book's Planning Engine runs (both pipeline_type: 'full' and 'contract'), most recently updated first. Use this to find the run to supervise — a book can have more than one run (e.g. a completed contract-pipeline run and an in-progress full-pipeline run).",
      inputSchema: {
        bookId: z.string().describe("The book's ID"),
        status: z.string().optional().describe("Optional filter, e.g. 'awaiting_user_review'"),
      },
    },
    async ({ bookId, status }) => {
      try {
        const runs = await listPlanningRuns(bookId);
        const filtered = status ? runs.filter((r) => r.status === status) : runs;
        return textResult(JSON.stringify(filtered, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "get_planning_run",
    {
      title: "Get Planning Run",
      description:
        "Fetches a Planning Engine run's full current state: which unit it's on (current_stage/current_act/current_part/current_beat_chunk), that unit's current draft (stage_artifacts), the critics' findings (panel_reviews) and any automated arbitrator_synthesis if arbitrate has already run for it, the continuity ledger, and status. Read this before deciding what the Generator's current draft still needs — this is the same information the app's own review screen shows.",
      inputSchema: { runId: z.string().describe("The planning_runs row ID") },
    },
    async ({ runId }) => {
      try {
        const run = await getPlanningRun(runId);
        return textResult(JSON.stringify(run, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "generate_planning_unit",
    {
      title: "Generate Planning Unit",
      description:
        "Runs one Generator call for the run's current unit — a real, billed call against this backend's Anthropic API key, the same cost as pressing 'Generate' in the app. If final_delta_directive is set on the run (e.g. via set_planning_directive below), the Generator treats it as a revision of the previous draft and is instructed to verify every numbered item in it is genuinely resolved. Call get_planning_run afterward to read the new draft.",
      inputSchema: { runId: z.string().describe("The planning_runs row ID") },
    },
    async ({ runId }) => {
      try {
        const run = await generateStage(runId);
        return textResult(JSON.stringify(run, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "critique_planning_unit",
    {
      title: "Critique Planning Unit",
      description:
        "Runs the automated 3-critic pass (Continuity, Pacing & Chapter-Economy, Craft & Suspense) against the run's current draft — real, billed calls against this backend's Anthropic API key, fired in parallel, same cost as pressing 'Critique' in the app. This stays automated deliberately; it's the input your own arbitration reasoning works from, not something to replace. Call get_planning_run afterward to read panel_reviews.",
      inputSchema: { runId: z.string().describe("The planning_runs row ID") },
    },
    async ({ runId }) => {
      try {
        const run = await runCritique(runId);
        return textResult(JSON.stringify(run, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "set_planning_directive",
    {
      title: "Set Planning Directive (Act as Arbitrator)",
      description:
        "Two uses, same underlying action (set the run's final_delta_directive and flip status to 'generating' directly, no LLM call on this side since the reasoning already happened in this conversation):\n\n(1) REVISION, the usual case: after reading the critics' findings (critique_planning_unit) and the current draft (get_planning_run), write your own synthesis of what genuinely needs to change — not a rubber stamp, and not everything every critic said if some of it is wrong or contradictory, the same judgment call the automated Arbitrator makes. Call generate_planning_unit next to regenerate, then diff_drafts (or your own read) to verify each item actually landed before deciding whether to iterate again or call approve_planning_unit.\n\n(2) INTAKE HANDOFF, right after create_planning_run: once you've had the intake conversation directly with the writer in this session (no separate tool for that — it's just conversation) and have enough for a strong creative brief, call this with the compiled brief as `directive`. This does exactly what the app's own intake-finalize does (same final_delta_directive + status: 'generating' write) and opens Stage 1 — then generate_planning_unit produces the actual Core Summary.\n\nIn both cases, write `directive` as a NUMBERED CHECKLIST of discrete, individually-verifiable items for a revision (a first-time creative brief can read as normal prose instead, since there's no prior draft to verify against yet) — every Generator prompt in this pipeline is specifically hardened to treat a checklist-shaped revision directive as binding and to verify each item before returning, so a vague or prose-shaped revision directive gets followed less reliably.",
      inputSchema: {
        runId: z.string().describe("The planning_runs row ID"),
        directive: z.string().describe("For a revision: a numbered checklist. For an intake handoff: the compiled creative brief."),
      },
    },
    async ({ runId, directive }) => {
      try {
        const run = await setPlanningDirective(runId, directive);
        return textResult(JSON.stringify(run, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "edit_planning_artifact",
    {
      title: "Edit Planning Artifact (Direct Fix)",
      description:
        "Directly overwrites the CURRENT unit's draft content — no LLM call, no cost, bypasses the Generator entirely. Use this for a small, trivial, or purely mechanical fix you can just make yourself (a typo, a dropped clause, a wrong name, a numbers-don't-add-up error, one weak beat in an otherwise solid chunk) instead of spending a generate_planning_unit call and hoping a full regeneration doesn't drift elsewhere. This is a scalpel, not the default path — if the draft has a real structural or substantive problem, that's still what set_planning_directive + generate_planning_unit is for.\n\nRead the current draft first via get_planning_run (it's at stage_artifacts for the run's current unit). For a plain-text unit (stage_1_summary, act_summary) `content` is just the corrected prose. For a JSON-contract unit — part_outline (`{startChapter, endChapter, outline}`), part_beats/hook_chapters_outline (`{chapters: [{chapterNumber, title?, beats: [{title, outlineText}]}]}`), or codex_documentation (`{entries: [{name, entryType, description, aliases?, tier?, personalityTraits?, motivations?}]}`) — `content` must be that exact JSON shape, serialized as a string: read the current artifact, parse it, make your targeted change, and send back the complete corrected JSON, not a diff or partial patch. Getting the shape wrong won't corrupt anything silently — it just surfaces as a clear error the next time approve_planning_unit tries to parse it.\n\nDoes not touch the run's status, panel_reviews, or final_delta_directive — it's a pure content overwrite. If the unit already has critic reviews on file, they now describe the pre-edit draft; call critique_planning_unit again first if you want a fresh read against your edit before approving, or just approve_planning_unit directly if the fix was small enough that you're confident it didn't invalidate the critique.",
      inputSchema: {
        runId: z.string().describe("The planning_runs row ID"),
        content: z
          .string()
          .describe(
            "The complete corrected artifact content for the run's current unit — plain text for stage_1_summary/act_summary, or the full JSON contract serialized as a string for part_outline/part_beats/hook_chapters_outline/codex_documentation."
          ),
      },
    },
    async ({ runId, content }) => {
      try {
        const run = await editPlanningArtifact(runId, content);
        return textResult(JSON.stringify(run, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "approve_planning_unit",
    {
      title: "Approve Planning Unit",
      description:
        "The human review gate's approve action — call this once you and the writer are genuinely satisfied the current unit's draft resolved everything, not before. On a part_outline, records the Part's committed chapter range; on a part_beats/hook_chapters_outline chunk, also materializes it into the Outliner and reconciles the continuity ledger. Advances the run to the next unit in the fixed Act→Part→Beats sequence (or marks it done once complete) — call get_planning_run afterward to see the new current unit and continue supervising it, checking in with the writer periodically rather than working through the whole remaining book unsupervised in one pass.",
      inputSchema: { runId: z.string().describe("The planning_runs row ID") },
    },
    async ({ runId }) => {
      try {
        const run = await approveStage(runId);
        return textResult(JSON.stringify(run, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
