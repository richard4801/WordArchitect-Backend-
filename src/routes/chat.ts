import { Router, type Request, type Response } from "express";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { runChatTurn } from "../services/chatAssistant.js";
import { VALID_CHAT_PERSONAS } from "../types/domain.js";
import type { ChatMessage, ChatPersona } from "../types/domain.js";

export const chatRouter = Router();

const TITLE_MAX_LENGTH = 60;

function deriveTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  if (trimmed.length <= TITLE_MAX_LENGTH) return trimmed;
  return trimmed.slice(0, TITLE_MAX_LENGTH - 1).trimEnd() + "…";
}

// POST /api/v1/chat — sends one message in a conversation, creating the
// session first if sessionId is omitted. Runs the full tool-calling loop
// (src/services/chatAssistant.ts) synchronously and returns the finished
// assistant reply — not streamed, since a chat turn here can involve
// several tool round trips before Claude produces a final answer, unlike
// Hanami's single-pass token stream.
chatRouter.post("/chat", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const bookId = typeof body.bookId === "string" ? body.bookId.trim() : "";
  const message = typeof body.message === "string" ? body.message : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : undefined;
  const requestedPersona = typeof body.persona === "string" ? body.persona : undefined;

  if (!userId) {
    res.status(400).json({ error: "userId is required and must be a non-empty string." });
    return;
  }
  if (!bookId) {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }
  if (!message.trim()) {
    res.status(400).json({ error: "message is required and must be a non-empty string." });
    return;
  }
  if (requestedPersona !== undefined && !VALID_CHAT_PERSONAS.includes(requestedPersona as ChatPersona)) {
    res.status(400).json({ error: `persona must be one of: ${VALID_CHAT_PERSONAS.join(", ")}.` });
    return;
  }

  const supabase = getSupabaseClient();

  try {
    let session: { id: string; persona: ChatPersona; title: string | null };

    if (sessionId) {
      const { data, error } = await supabase
        .from("chat_sessions")
        .select("id, persona, title")
        .eq("id", sessionId)
        .maybeSingle();
      if (error) throw new Error(`Failed to load chat session: ${error.message}`);
      if (!data) {
        res.status(404).json({ error: `No chat session found with id ${sessionId}.` });
        return;
      }
      session = data;
    } else {
      const persona = (requestedPersona as ChatPersona) ?? "general";
      const { data, error } = await supabase
        .from("chat_sessions")
        .insert({ user_id: userId, book_id: bookId, persona, title: deriveTitle(message) })
        .select("id, persona, title")
        .single();
      if (error) throw new Error(`Failed to create chat session: ${error.message}`);
      session = data;
    }

    const { data: historyRows, error: historyErr } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("session_id", session.id)
      .order("created_at", { ascending: true });
    if (historyErr) throw new Error(`Failed to load chat history: ${historyErr.message}`);

    const { error: userMsgErr } = await supabase
      .from("chat_messages")
      .insert({ session_id: session.id, role: "user", content: message });
    if (userMsgErr) throw new Error(`Failed to save message: ${userMsgErr.message}`);

    const result = await runChatTurn({
      persona: session.persona,
      bookId,
      history: (historyRows ?? []) as ChatMessage[],
      userMessage: message,
    });

    const { data: assistantMessage, error: assistantMsgErr } = await supabase
      .from("chat_messages")
      .insert({
        session_id: session.id,
        role: "assistant",
        content: result.text,
        tool_calls: result.toolCalls.length > 0 ? result.toolCalls : null,
      })
      .select("*")
      .single();
    if (assistantMsgErr) throw new Error(`Failed to save assistant reply: ${assistantMsgErr.message}`);

    await supabase.from("chat_sessions").update({ updated_at: new Date().toISOString() }).eq("id", session.id);

    res.status(201).json({ sessionId: session.id, message: assistantMessage });
  } catch (error) {
    console.error("chat turn failed:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Failed to run chat turn. Please try again." });
  }
});

// GET /api/v1/chat/sessions?bookId=&userId= — for a "Recent Conversations"
// list. Most recently updated first.
chatRouter.get("/chat/sessions", async (req: Request, res: Response) => {
  const bookId = req.query.bookId;
  if (typeof bookId !== "string" || bookId.trim() === "") {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }

  const supabase = getSupabaseClient();
  let query = supabase.from("chat_sessions").select("*").eq("book_id", bookId);
  if (typeof req.query.userId === "string" && req.query.userId.trim() !== "") {
    query = query.eq("user_id", req.query.userId);
  }

  const { data, error } = await query.order("updated_at", { ascending: false });
  if (error) {
    res.status(502).json({ error: "Failed to list chat sessions." });
    return;
  }
  res.json({ sessions: data });
});

// GET /api/v1/chat/sessions/:id — full message history, for resuming or
// viewing a past conversation.
chatRouter.get("/chat/sessions/:id", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data: session, error: sessionErr } = await supabase
    .from("chat_sessions")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();
  if (sessionErr) {
    res.status(502).json({ error: "Failed to fetch chat session." });
    return;
  }
  if (!session) {
    res.status(404).json({ error: `No chat session found with id ${req.params.id}.` });
    return;
  }

  const { data: messages, error: messagesErr } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("session_id", req.params.id)
    .order("created_at", { ascending: true });
  if (messagesErr) {
    res.status(502).json({ error: "Failed to fetch chat messages." });
    return;
  }

  res.json({ session, messages });
});

// PATCH /api/v1/chat/sessions/:id — rename a conversation.
chatRouter.patch("/chat/sessions/:id", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.title !== "string" || body.title.trim() === "") {
    res.status(400).json({ error: "title is required and must be a non-empty string." });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("chat_sessions")
    .update({ title: body.title, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select("*")
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to update chat session." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No chat session found with id ${req.params.id}.` });
    return;
  }
  res.json({ session: data });
});

// DELETE /api/v1/chat/sessions/:id — cascades to its messages.
chatRouter.delete("/chat/sessions/:id", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("chat_sessions")
    .delete()
    .eq("id", req.params.id)
    .select("id")
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to delete chat session." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No chat session found with id ${req.params.id}.` });
    return;
  }
  res.status(204).end();
});
