import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "../lib/anthropicClient.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { getActivePrompt, interpolateTemplate } from "./agentPrompts.js";
import { extractFinalText } from "../lib/anthropicContent.js";
import type { PlatformCraftNotes } from "../types/domain.js";

// A per-book reference doc feeding {{PLATFORM_TRENDS}} into the Contract
// Pipeline's hook-focused generator/critics (see planningEngine.ts). This
// is deliberately NOT a live/automatic feed — see CLAUDE.md's Contract
// Pipeline section for why: scraping ranking/algorithm behavior in real
// time is fragile and platform-ToS-risky, and a silently-updating
// judgment reference is exactly the kind of ungoverned drift this
// project avoids everywhere else. Instead this is a one row per book
// doc, refreshed only when the writer explicitly asks for a research pass
// and only saved once they've reviewed the draft.
//
// The research pass itself runs as a detached background job (see
// startPlatformResearchJob below), not inline in the HTTP request that
// starts it — a real Claude + web_search/web_fetch call can run for a
// while, and the writer shouldn't need to keep a browser tab open and
// connected for the entire duration just to get the result. Its progress
// lives on this same row (draft_status/draft_content/draft_error) so
// GET /platform-craft-notes, polled the same way the Planning Engine's
// run is already polled, picks the result up whenever the writer next
// checks — same tab, a different tab, or a different device entirely.

function toPlatformCraftNotes(data: Record<string, unknown>): PlatformCraftNotes {
  return {
    bookId: data.book_id as string,
    content: (data.content as string) ?? "",
    updatedAt: (data.updated_at as string) ?? null,
    draftStatus: (data.draft_status as PlatformCraftNotes["draftStatus"]) ?? "idle",
    draftContent: (data.draft_content as string) ?? null,
    draftError: (data.draft_error as string) ?? null,
    draftUpdatedAt: (data.draft_updated_at as string) ?? null,
  };
}

export async function getPlatformCraftNotes(bookId: string): Promise<PlatformCraftNotes | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("platform_craft_notes").select("*").eq("book_id", bookId).maybeSingle();
  if (error) throw new Error(`Failed to load platform craft notes: ${error.message}`);
  if (!data) return null;
  return toPlatformCraftNotes(data);
}

// The only thing that actually saves the real notes, whether the content
// came from editing a research draft or writing it directly. Also clears
// the draft fields back to "idle" — a draft is either accepted (folded
// into `content` here) or explicitly discarded by the writer, never left
// sitting around as a stale "ready" banner after being acted on.
export async function savePlatformCraftNotes(bookId: string, content: string): Promise<PlatformCraftNotes> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("platform_craft_notes")
    .upsert(
      {
        book_id: bookId,
        content,
        updated_at: new Date().toISOString(),
        draft_status: "idle",
        draft_content: null,
        draft_error: null,
      },
      { onConflict: "book_id" }
    )
    .select("*")
    .single();
  if (error) throw new Error(`Failed to save platform craft notes: ${error.message}`);
  return toPlatformCraftNotes(data);
}

// Discards a "ready" or "failed" draft without saving it — resets to
// "idle" so the UI's banner clears. Leaves `content` (the last actually
// saved notes) untouched.
export async function discardPlatformResearchDraft(bookId: string): Promise<PlatformCraftNotes> {
  return setDraftState(bookId, { draft_status: "idle", draft_content: null, draft_error: null });
}

async function setDraftState(
  bookId: string,
  patch: { draft_status: string; draft_content?: string | null; draft_error?: string | null }
): Promise<PlatformCraftNotes> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("platform_craft_notes")
    .upsert({ book_id: bookId, ...patch, draft_updated_at: new Date().toISOString() }, { onConflict: "book_id" })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to update platform research draft state: ${error.message}`);
  return toPlatformCraftNotes(data);
}

// Matches planningEngine.ts's callAgent default — a real generative call
// with adaptive thinking enabled can spend its entire budget on thinking
// before emitting visible text if max_tokens is too low (confirmed live
// elsewhere in this project); reusing the same safe default here rather
// than re-learning that lesson with a smaller number.
const DEFAULT_MAX_TOKENS = 16000;

// Tracks the AbortController for whichever research job is currently
// in flight per book, so cancelPlatformResearchJob below can actually
// stop it rather than just hoping it finishes. In-memory, single-process
// only — the same limitation this project already accepts for the MCP
// session map (src/routes/mcp.ts): fine on Render's single instance, and
// a process restart naturally kills any in-flight call anyway (its
// result then has no controller to be found by, so cancel degrades to
// "just reset the stored state," which is still the right outcome).
const activeResearchJobs = new Map<string, AbortController>();

// The actual research call — Claude with server-side web_search/web_fetch
// tools, the same pattern intakeChatTurn already uses for reading a
// pasted URL (planningEngine.ts) so the backend never scrapes HTML
// itself. Prompt content is fully writer-owned via the Prompt Editor like
// every other agent role — role "platform_researcher", stage "all". Not
// exported — always run through startPlatformResearchJob below, which is
// what actually persists the result.
async function runResearch(bookId: string, existingContent: string, signal: AbortSignal): Promise<string> {
  const prompt = await getActivePrompt(bookId, "platform_researcher", "all");
  const userMessage = interpolateTemplate(prompt.user_prompt_template, { EXISTING_NOTES: existingContent });

  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create(
    {
      model: prompt.model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: prompt.system_prompt,
      thinking: { type: "adaptive" },
      output_config: { effort: prompt.effort },
      // Server-side tools — Anthropic runs the searches/fetches itself
      // within this same call, no client-side execution loop needed. Not in
      // the SDK's plain Tool type (that's for custom tools with an
      // input_schema), hence the through-unknown cast — same pattern
      // intakeChatTurn already uses for web_fetch in planningEngine.ts.
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 8 } as unknown as Anthropic.Tool,
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 } as unknown as Anthropic.Tool,
      ],
      messages: [{ role: "user", content: userMessage }],
    },
    { signal }
  );

  const text = extractFinalText(response.content);

  if (!text) {
    throw new Error(
      `Platform craft notes research returned no text output (stop_reason: ${response.stop_reason}). This usually means max_tokens was exhausted by thinking before any visible output.`
    );
  }

  return text;
}

// Starts an on-demand research pass and returns immediately with
// draft_status "running" — the actual Claude call is NOT awaited here.
// It keeps running server-side after this function (and the HTTP request
// that called it) returns, because the outstanding call to Anthropic is
// its own independent connection with no tie to the inbound request's
// socket — closing the writer's browser tab has no effect on it. Its
// result lands back on this book's platform_craft_notes row when it
// finishes; the writer picks it up via a normal GET whenever they next
// check, not by keeping a connection open.
//
// Refuses to start a second job while one is already "running" for this
// book — returns the existing in-flight state instead — so an impatient
// double-click doesn't fire (and pay for) two concurrent research calls.
//
// Also refuses to start when there's an unsaved "ready" draft already
// waiting for review, unless `force` is passed — starting a new pass
// overwrites draft_content, and a writer who never got to see/save the
// previous result losing it silently is exactly the kind of thing this
// guard exists to prevent. force: true discards that draft and proceeds
// (equivalent to calling discardPlatformResearchDraft first).
export async function startPlatformResearchJob(bookId: string, force = false): Promise<PlatformCraftNotes> {
  const existing = await getPlatformCraftNotes(bookId);
  if (existing?.draftStatus === "running") {
    return existing;
  }
  if (existing?.draftStatus === "ready" && !force) {
    throw new Error(
      "An unsaved research draft is already waiting for review for this book — save or discard it before running research again, or pass force to discard it and start a fresh pass."
    );
  }

  const controller = new AbortController();
  activeResearchJobs.set(bookId, controller);

  const started = await setDraftState(bookId, { draft_status: "running", draft_content: null, draft_error: null });

  // Deliberately not awaited — this is the detached background job.
  void runResearch(bookId, existing?.content ?? "", controller.signal)
    .then((draft) => setDraftState(bookId, { draft_status: "ready", draft_content: draft, draft_error: null }))
    .catch((error) => {
      // Cancellation is handled entirely by cancelPlatformResearchJob's
      // own write (draft_status back to "idle") — persisting "failed"
      // here on top of that would clobber an intentional cancel into
      // looking like an error. Anything else is a real failure.
      const isAbort = error instanceof Error && error.name === "AbortError";
      if (isAbort) {
        console.log(`platform research job for book ${bookId} was cancelled`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("platform research job failed:", message);
      return setDraftState(bookId, { draft_status: "failed", draft_error: message }).catch((persistError) => {
        console.error("failed to persist platform research job failure:", persistError);
      });
    })
    .finally(() => {
      // Only clear if this job's controller is still the registered one —
      // a later job for the same book could have already replaced it.
      if (activeResearchJobs.get(bookId) === controller) {
        activeResearchJobs.delete(bookId);
      }
    });

  return started;
}

// Stops an in-flight research pass. Only effective if this same process
// is still the one running it (see activeResearchJobs above) — if no
// controller is found (the process restarted since the job started, or
// nothing is actually running for this book), this still resets
// draft_status back to "idle" so the writer isn't stuck looking at a
// permanently "running" state either way.
export async function cancelPlatformResearchJob(bookId: string): Promise<PlatformCraftNotes> {
  const controller = activeResearchJobs.get(bookId);
  if (controller) {
    activeResearchJobs.delete(bookId);
    controller.abort();
  }
  return setDraftState(bookId, { draft_status: "idle", draft_content: null, draft_error: null });
}
