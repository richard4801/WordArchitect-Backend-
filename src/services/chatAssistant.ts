import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "../lib/anthropicClient.js";
import { listCodexEntries, getCodexEntry, searchManuscript, getManuscriptChapterText } from "./bookContextTools.js";
import { listWorldCategories } from "../routes/worldCategories.js";
import { listNotesForBook } from "../routes/notes.js";
import { VALID_NOTE_CATEGORIES } from "../types/domain.js";
import type { ChatMessage, ChatPersona, ChatToolCallLogEntry } from "../types/domain.js";

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOOL_ITERATIONS = 6;
const MAX_OUTPUT_TOKENS = 2048;

// One short instruction per persona, layered onto a shared base prompt —
// the five cards on the AI Assistant page are the same underlying loop
// and the same tool access, just a different creative focus.
const PERSONA_INSTRUCTIONS: Record<ChatPersona, string> = {
  general: "You're a general-purpose creative writing assistant for this book — help with whatever the writer brings up.",
  story_assistant:
    "You specialize in plot, story structure, and pacing. Help the writer think through what happens next, where tension is flagging, and how open threads connect.",
  character_coach:
    "You specialize in character depth — motivations, relationships, arcs, and consistency. Help the writer develop richer, more internally consistent characters.",
  worldbuilding_guide:
    "You specialize in worldbuilding — cultures, history, magic/technology systems, geography, factions. Help the writer build a richer, more internally consistent world.",
  writing_editor:
    "You specialize in prose craft — style, tone, clarity, line-level editing. When asked to improve a passage, propose specific rewritten text, not just abstract advice.",
  brainstormer:
    "You specialize in rapid idea generation — names, twists, scene ideas, creative alternatives. Offer several distinct options rather than a single answer when brainstorming.",
};

function buildChatSystemPrompt(persona: ChatPersona): string {
  const personaInstruction = PERSONA_INSTRUCTIONS[persona] ?? PERSONA_INSTRUCTIONS.general;
  return [
    "You are the in-app AI Assistant for WordArchitect, a novel-writing platform. You're chatting directly with the writer about their book.",
    personaInstruction,
    "You have read-only tools to look up this book's real Characters, Worldbuilding entries, Notes, and manuscript text. Use them whenever a question depends on details you don't already have from earlier in this conversation — don't invent or guess at established facts, and don't re-call a tool for something already established earlier in this same conversation.",
    "You also have propose_* tools (propose_create_codex_entry, propose_update_codex_entry, propose_create_world_category, propose_create_note, propose_save_manuscript_scene). Calling one does NOT save anything — it drafts a change and shows it to the writer in the app for them to explicitly confirm or reject before it's ever written. Only call a propose_* tool after the writer has actually asked for or clearly agreed to that specific change in this conversation — never speculatively, and never as a way to 'try something out.' Immediately after calling one, briefly restate in your reply exactly what you proposed (the key fields, not the full JSON) so the writer knows precisely what they're being asked to confirm.",
    "This chat is for discussion, brainstorming, and advice — not for writing manuscript prose into the book. If the writer wants actual prose generated or written into a chapter, tell them to use the book's normal prose generation flow instead of trying to do that here. propose_save_manuscript_scene is only for saving prose the writer has already accepted as final, not for drafting new prose.",
    "Ground every factual claim about the book in what the tools actually return. If you don't know something and the tools don't surface it, say so plainly rather than inventing details.",
  ].join("\n\n");
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_codex_entries",
    description:
      "List every Codex entry (characters, locations, items, lore, etc.) for this book. Use this first to see what's already tracked before assuming something isn't established.",
    input_schema: {
      type: "object",
      properties: {
        entryType: {
          type: "string",
          description: "Optional filter — 'character' or a worldbuilding category key (see list_world_categories for this book's actual categories)",
        },
      },
    },
  },
  {
    name: "get_codex_entry",
    description: "Fetch one Codex entry's full record by ID, including every field.",
    input_schema: {
      type: "object",
      properties: { entryId: { type: "string" } },
      required: ["entryId"],
    },
  },
  {
    name: "search_manuscript",
    description:
      "Semantic search over this book's ingested manuscript. Returns matching passages ranked by similarity, with chapter/scene position and full text.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for — a concept, event, object, or phrase, described as it might actually read in prose" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_manuscript_chapter",
    description: "Fetch a specific chapter's full text, in order. Use when you need literal content rather than a similarity-matched excerpt.",
    input_schema: {
      type: "object",
      properties: { chapterNumber: { type: "integer" } },
      required: ["chapterNumber"],
    },
  },
  {
    name: "list_world_categories",
    description: "List this book's worldbuilding categories (locations, factions, magic systems, or any custom category the writer has created).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_notes",
    description: "List this book's brainstorming notes — quick captures the writer has jotted down outside the Codex.",
    input_schema: {
      type: "object",
      properties: { category: { type: "string", description: "Optional filter, e.g. 'Plot', 'Character', 'World Building'" } },
    },
  },
  // --- propose_* tools: none of these write to the database. Each one
  // stages a proposed change (logged in chat_messages.tool_calls, the same
  // transparency record every tool call already gets) for the writer to
  // review and explicitly confirm in the UI, which then calls the real
  // CRUD endpoint directly — see the Chat Assistant section of CLAUDE.md
  // for the full confirm-gated write flow and why it exists.
  {
    name: "propose_create_codex_entry",
    description:
      "Draft a new Codex entry (character, location, item, lore, etc.) for the writer to review. Does NOT save anything — stages a proposal the writer must explicitly confirm in the app before it's written to their Codex. Only call this after the writer has actually asked for or clearly agreed to creating this entry, never speculatively.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The entry's name" },
        entryType: {
          type: "string",
          description: "'character', or a worldbuilding category key — call list_world_categories first to see this book's actual categories rather than guessing",
        },
        description: { type: "string", description: "Overview/summary — the only field always injected into generation context" },
        fields: {
          type: "object",
          description:
            "Any other optional Codex fields to set — matches whatever POST /api/v1/codex accepts (aliases, tier, personalityTraits, motivations, background, etc.). Omit fields you have nothing to propose for.",
        },
      },
      required: ["name", "entryType", "description"],
    },
  },
  {
    name: "propose_update_codex_entry",
    description:
      "Draft an update to an existing Codex entry's fields, for the writer to review. Does NOT save anything until the writer confirms in the app. Only call this after the writer has confirmed the specific change in conversation.",
    input_schema: {
      type: "object",
      properties: {
        entryId: { type: "string", description: "The codex_entries row ID (from get_codex_entry / list_codex_entries)" },
        description: { type: "string" },
        fields: { type: "object", description: "Other fields to update — matches whatever PATCH /api/v1/codex/:id accepts." },
      },
      required: ["entryId"],
    },
  },
  {
    name: "propose_create_world_category",
    description:
      "Draft a new worldbuilding category (e.g. 'Ship Technology') for the writer to review. Does NOT save anything until confirmed. key is auto-slugified from name if omitted.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        key: { type: "string" },
        description: { type: "string" },
        color: { type: "string" },
        icon: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "propose_create_note",
    description:
      "Draft a quick brainstorming note for the writer to review. Does NOT save anything until confirmed. Only propose this when the writer has actually asked something be jotted down, not as a running log of the conversation.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        excerpt: { type: "string", description: "The note's body text" },
        category: { type: "string", enum: VALID_NOTE_CATEGORIES, description: "One of the book's fixed note categories" },
        pinned: { type: "boolean" },
      },
      required: ["title", "excerpt", "category"],
    },
  },
  {
    name: "propose_save_manuscript_scene",
    description:
      "Draft saving an accepted scene into permanent manuscript memory and the chapter editor, for the writer to review. Does NOT save anything until confirmed — use this once the writer has actually accepted a piece of prose (generated or hand-written) as final for a chapter, not for drafting new prose.",
    input_schema: {
      type: "object",
      properties: {
        chapterNumber: { type: "integer" },
        rawText: { type: "string", description: "The full accepted scene text" },
      },
      required: ["chapterNumber", "rawText"],
    },
  },
];

// propose_* tools deliberately never touch Supabase — see the propose_*
// entries in TOOLS above and the Chat Assistant section of CLAUDE.md. This
// just validates the shape Claude sent and acknowledges the proposal was
// received; the real payload is already captured in the tool_calls log
// that gets persisted with the assistant's message (see runChatTurn
// below), which is what the frontend reads to render the confirm/reject
// card and, on confirm, calls the real CRUD endpoint with directly.
function proposalAck(action: string): { status: string; note: string } {
  return {
    status: "drafted_pending_confirmation",
    note: `This ${action} has been drafted and shown to the writer for review. Nothing has been saved — it only takes effect if the writer confirms it in the app.`,
  };
}

async function executeTool(name: string, input: Record<string, unknown>, bookId: string): Promise<unknown> {
  switch (name) {
    case "list_codex_entries":
      return listCodexEntries(bookId, typeof input.entryType === "string" ? input.entryType : undefined);
    case "get_codex_entry":
      if (typeof input.entryId !== "string") throw new Error("entryId is required");
      return getCodexEntry(input.entryId);
    case "search_manuscript":
      if (typeof input.query !== "string") throw new Error("query is required");
      return searchManuscript(bookId, input.query);
    case "get_manuscript_chapter":
      if (typeof input.chapterNumber !== "number") throw new Error("chapterNumber is required");
      return getManuscriptChapterText(bookId, input.chapterNumber);
    case "list_world_categories":
      return listWorldCategories(bookId);
    case "list_notes":
      return listNotesForBook(bookId, { category: typeof input.category === "string" ? input.category : undefined });
    case "propose_create_codex_entry":
      if (typeof input.name !== "string" || typeof input.entryType !== "string" || typeof input.description !== "string") {
        throw new Error("name, entryType, and description are required");
      }
      return proposalAck("Codex entry creation");
    case "propose_update_codex_entry":
      if (typeof input.entryId !== "string") throw new Error("entryId is required");
      return proposalAck("Codex entry update");
    case "propose_create_world_category":
      if (typeof input.name !== "string") throw new Error("name is required");
      return proposalAck("worldbuilding category creation");
    case "propose_create_note":
      if (typeof input.title !== "string" || typeof input.excerpt !== "string" || typeof input.category !== "string") {
        throw new Error("title, excerpt, and category are required");
      }
      return proposalAck("note creation");
    case "propose_save_manuscript_scene":
      if (typeof input.chapterNumber !== "number" || typeof input.rawText !== "string") {
        throw new Error("chapterNumber and rawText are required");
      }
      return proposalAck("saving this scene into manuscript memory and the chapter editor");
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export interface RunChatTurnResult {
  text: string;
  toolCalls: ChatToolCallLogEntry[];
}

// Runs one conversational turn: sends the message history plus the new
// user message to Claude with this book's read-only context tools plus
// the propose_* write tools available, executing any tool calls it makes
// and feeding results back until it produces a final text answer or
// MAX_TOOL_ITERATIONS is exceeded. This loop runs multiple tool calls
// autonomously within a single turn with no human confirmation in
// between — unlike the MCP server, where a human directs each write
// turn by turn via an external client — so real writes never happen
// here. propose_* tools only ever stage a change (see proposalAck above);
// the actual write happens later, outside this loop entirely, when the
// writer confirms in the UI and the frontend calls the real CRUD
// endpoint directly. That keeps "nothing writes unsupervised" true even
// though this loop now has write-shaped tools available to it.
export async function runChatTurn(params: {
  persona: ChatPersona;
  bookId: string;
  history: ChatMessage[];
  userMessage: string;
}): Promise<RunChatTurnResult> {
  const { persona, bookId, history, userMessage } = params;
  const anthropic = getAnthropicClient();
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  messages.push({ role: "user", content: userMessage });

  const toolCallLog: ChatToolCallLogEntry[] = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: buildChatSystemPrompt(persona),
      tools: TOOLS,
      messages,
    });

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { text: text || "(no response)", toolCalls: toolCallLog };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const input = (block.input ?? {}) as Record<string, unknown>;
      toolCallLog.push({ tool: block.name, input });
      try {
        const result = await executeTool(block.name, input, bookId);
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result ?? null),
        });
      } catch (err) {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: toolResultBlocks });
  }

  throw new Error("Chat assistant exceeded the maximum number of tool-call rounds without a final answer.");
}
