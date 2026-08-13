import Anthropic from "@anthropic-ai/sdk";
import { getEnvVar } from "../lib/env.js";
import { listCodexEntries, getCodexEntry, searchManuscript, getManuscriptChapterText } from "./bookContextTools.js";
import { listWorldCategories } from "../routes/worldCategories.js";
import { listNotesForBook } from "../routes/notes.js";
import type { ChatMessage, ChatPersona, ChatToolCallLogEntry } from "../types/domain.js";

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOOL_ITERATIONS = 6;
const MAX_OUTPUT_TOKENS = 2048;

let client: Anthropic | undefined;
function getAnthropicClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: getEnvVar("ANTHROPIC_API_KEY") });
  }
  return client;
}

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
    "This chat is for discussion, brainstorming, and advice — not for writing manuscript prose into the book. If the writer wants actual prose generated or written into a chapter, tell them to use the book's normal prose generation flow instead of trying to do that here.",
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
];

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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export interface RunChatTurnResult {
  text: string;
  toolCalls: ChatToolCallLogEntry[];
}

// Runs one conversational turn: sends the message history plus the new
// user message to Claude with read-only book-context tools available,
// executing any tool calls it makes (against this book's real Codex/
// manuscript/notes data) and feeding results back until it produces a
// final text answer or MAX_TOOL_ITERATIONS is exceeded. Deliberately
// read-only tools only — unlike the MCP server's write tools (which only
// ever fire when a human is actively directing a conversation turn by
// turn), this loop runs multiple tool calls autonomously within a single
// turn with no human confirmation in between, so giving it write access
// here would mean unsupervised writes to the Codex.
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
