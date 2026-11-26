import { createHash } from "node:crypto";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { getSkillReview, overallFromItems, supabaseReviewStore, type ReviewStore } from "./skillReview.js";

// The recorded "Go" (author's ruling, 26 Nov). Go stays a chat rule: Claude
// shows the author the exact Hanami prompts and asks; there is no app button.
// What the backend adds is a record: when the author says Go, Claude calls
// record_prompt_approval with the beats and the author's words, quoted, and
// generate_prose_direct refuses any call that isn't covered by one.
//
// Scope (decided 26 Nov, "card beats + reruns"): a call is covered when its
// sceneBeat is one of the approved beats (whitespace-normalized hash match),
// or when it is a declared narrow rerun of an approved beat (rerunOfBeat +
// rerunReason, logged with the full prompt). A new beat or a changed fact
// needs a new Go. compiledContext is stored for the author to see but not
// matched: its "story so far" anchor is the accepted prose of the previous
// beat, which can't exist yet when the author approves the card.
//
// What it can't do, stated plainly: the backend can't prove the author said
// the words Claude quotes, and Claude could label a new beat as a rerun. Both
// are stored and listed by get_chapter_workflow for the author to check.

// A beat matches when its words match: every run of whitespace (line breaks
// included) collapses to one space, so re-wrapping a prompt doesn't void a Go.
export function beatHash(sceneBeat: string): string {
  return createHash("sha256").update(sceneBeat.replace(/\s+/g, " ").trim(), "utf8").digest("hex");
}

export interface ApprovedBeat {
  index: number;
  label: string;
  sceneBeat: string;
  compiledContext: string;
  hash: string;
}

export interface PromptApprovalRow {
  id: string;
  book_id: string;
  user_id: string;
  chapter_number: number;
  card_review_id: string | null;
  beats: ApprovedBeat[];
  writer_approval: string;
  created_at: string;
}

export interface ApprovalCallRow {
  id: string;
  approval_id: string;
  beat_index: number;
  kind: "approved" | "rerun";
  scene_beat: string;
  compiled_context: string;
  rerun_reason: string | null;
  created_at: string;
}

export interface ApprovalStore {
  insertApproval(row: Omit<PromptApprovalRow, "id" | "created_at">): Promise<PromptApprovalRow>;
  getApproval(id: string): Promise<PromptApprovalRow | null>;
  listApprovals(bookId: string, chapterNumber: number): Promise<PromptApprovalRow[]>;
  insertCall(row: Omit<ApprovalCallRow, "id" | "created_at">): Promise<ApprovalCallRow>;
  listCalls(approvalIds: string[]): Promise<ApprovalCallRow[]>;
}

export const supabaseApprovalStore: ApprovalStore = {
  async insertApproval(row) {
    const { data, error } = await getSupabaseClient().from("prompt_approvals").insert(row).select("*").single();
    if (error) throw new Error(`Failed to record the approval: ${error.message}`);
    return data as PromptApprovalRow;
  },
  async getApproval(id) {
    const { data, error } = await getSupabaseClient().from("prompt_approvals").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`Failed to load the approval: ${error.message}`);
    return (data as PromptApprovalRow | null) ?? null;
  },
  async listApprovals(bookId, chapterNumber) {
    const { data, error } = await getSupabaseClient()
      .from("prompt_approvals")
      .select("*")
      .eq("book_id", bookId)
      .eq("chapter_number", chapterNumber)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Failed to list approvals: ${error.message}`);
    return (data ?? []) as PromptApprovalRow[];
  },
  async insertCall(row) {
    const { data, error } = await getSupabaseClient().from("prompt_approval_calls").insert(row).select("*").single();
    if (error) throw new Error(`Failed to log the call: ${error.message}`);
    return data as ApprovalCallRow;
  },
  async listCalls(approvalIds) {
    if (approvalIds.length === 0) return [];
    const { data, error } = await getSupabaseClient()
      .from("prompt_approval_calls")
      .select("*")
      .in("approval_id", approvalIds)
      .order("created_at");
    if (error) throw new Error(`Failed to list calls: ${error.message}`);
    return (data ?? []) as ApprovalCallRow[];
  },
};

export class PromptApprovalError extends Error {}

export function isCardReviewGateEnabled(): boolean {
  return (process.env.CARD_REVIEW_GATE ?? "on").toLowerCase() !== "off";
}

// ---------------------------------------------------------------------------
// record_prompt_approval
// ---------------------------------------------------------------------------

export interface RecordApprovalParams {
  userId: string;
  bookId: string;
  chapterNumber: number;
  cardReviewId?: string | null | undefined;
  beats: { label: string; sceneBeat: string; compiledContext: string }[];
  writerApproval: string;
  // The author's reason for going ahead over a BLOCKED or incomplete card
  // review, in their own words. Stored on the review.
  writerOverride?: string | null | undefined;
}

export async function recordPromptApproval(
  params: RecordApprovalParams,
  deps: { store?: ApprovalStore; reviews?: ReviewStore; cardGate?: boolean } = {}
): Promise<{ approval: PromptApprovalRow; note: string }> {
  const store = deps.store ?? supabaseApprovalStore;
  const reviews = deps.reviews ?? supabaseReviewStore;
  const cardGate = deps.cardGate ?? isCardReviewGateEnabled();

  const quote = params.writerApproval.trim();
  if (!quote) {
    throw new PromptApprovalError(
      "Not recorded: writerApproval is empty. Show the author the exact prompts and ask; when they say Go, pass their words here, quoted exactly."
    );
  }
  if (quote.length > 1000) {
    throw new PromptApprovalError("Not recorded: writerApproval is the author's own words of approval, quoted, not a summary or the prompts themselves (keep it under 1,000 characters).");
  }
  if (params.beats.length === 0) throw new PromptApprovalError("Not recorded: at least one beat is required.");
  const empty = params.beats.findIndex((b) => !b.sceneBeat.trim());
  if (empty >= 0) throw new PromptApprovalError(`Not recorded: beat ${empty} has an empty sceneBeat.`);

  let note = "";
  let cardReviewId: string | null = params.cardReviewId?.trim() || null;
  if (cardGate) {
    if (!cardReviewId) {
      throw new PromptApprovalError(
        "Not recorded: the beat card hasn't been reviewed. Call request_reviews with targetType beat_card and the card text, run the reviewers, show the author the result, then pass that review id as cardReviewId."
      );
    }
    let review;
    let items;
    try {
      ({ review, items } = await getSkillReview(cardReviewId, { store: reviews }));
    } catch (err) {
      throw new PromptApprovalError(`Not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (review.book_id !== params.bookId) throw new PromptApprovalError("Not recorded: that card review belongs to a different book.");
    if (review.target_type !== "beat_card") {
      throw new PromptApprovalError(`Not recorded: review ${review.id} is a ${review.target_type} review, not a beat_card review.`);
    }
    if (review.chapter_number !== null && review.chapter_number !== params.chapterNumber) {
      throw new PromptApprovalError(`Not recorded: that card review is for chapter ${review.chapter_number}, not ${params.chapterNumber}.`);
    }
    const overall = overallFromItems(items);
    if (overall === "pending") {
      throw new PromptApprovalError("Not recorded: the card review still has reviewers without a verdict. Wait for every subagent to submit.");
    }
    if (overall === "blocked" || overall === "incomplete") {
      const reason = params.writerOverride?.trim() || review.override_reason?.trim();
      if (!reason) {
        throw new PromptApprovalError(
          `Not recorded: the card review is ${overall.toUpperCase()}. Fix the card and review it again, or, only if the author decides to go ahead anyway, pass writerOverride with the author's reason in their own words.`
        );
      }
      if (params.writerOverride?.trim() && !review.override_reason) {
        await reviews.updateReview(review.id, { override_reason: reason, overridden_at: new Date().toISOString() });
      }
      note = ` Recorded OVER a ${overall} card review; author override: "${reason}".`;
    } else {
      note = ` Card review ${review.id}: ${overall}.`;
    }
  } else {
    cardReviewId = cardReviewId ?? null;
    note = " (Card review gate is switched off: CARD_REVIEW_GATE=off.)";
  }

  const beats: ApprovedBeat[] = params.beats.map((b, index) => ({
    index,
    label: b.label.trim() || `Beat ${index + 1}`,
    sceneBeat: b.sceneBeat,
    compiledContext: b.compiledContext,
    hash: beatHash(b.sceneBeat),
  }));
  const approval = await store.insertApproval({
    book_id: params.bookId,
    user_id: params.userId,
    chapter_number: params.chapterNumber,
    card_review_id: cardReviewId,
    beats,
    writer_approval: quote,
  });
  return { approval, note: note.trim() };
}

// ---------------------------------------------------------------------------
// The check generate_prose_direct runs before sending anything to Hanami.
// ---------------------------------------------------------------------------

export interface CoveredCall {
  approval: PromptApprovalRow;
  beat: ApprovedBeat;
  kind: "approved" | "rerun";
}

export async function checkCallIsApproved(
  params: { bookId: string; approvalId: string; sceneBeat: string; compiledContext: string; rerunOfBeat?: number | undefined; rerunReason?: string | undefined },
  deps: { store?: ApprovalStore } = {}
): Promise<CoveredCall> {
  const store = deps.store ?? supabaseApprovalStore;
  const approval = await store.getApproval(params.approvalId.trim());
  if (!approval) {
    throw new PromptApprovalError(
      `Not sent: no approval with id ${params.approvalId}. Show the author the exact prompts, ask for their Go, and call record_prompt_approval with their words quoted.`
    );
  }
  if (approval.book_id !== params.bookId) throw new PromptApprovalError("Not sent: that approval belongs to a different book.");

  const list = approval.beats.map((b) => `${b.index}: ${b.label}`).join("; ");
  let beat: ApprovedBeat | undefined;
  let kind: "approved" | "rerun";
  if (params.rerunOfBeat !== undefined) {
    beat = approval.beats.find((b) => b.index === params.rerunOfBeat);
    if (!beat) throw new PromptApprovalError(`Not sent: approval ${approval.id} has no beat ${params.rerunOfBeat}. Its beats are ${list}.`);
    if (!params.rerunReason?.trim()) {
      throw new PromptApprovalError(
        "Not sent: a rerun needs rerunReason (what was broken in the pass, or the author's comment it answers). It is logged with the prompt for the author to see."
      );
    }
    kind = "rerun";
  } else {
    const hash = beatHash(params.sceneBeat);
    beat = approval.beats.find((b) => b.hash === hash);
    if (!beat) {
      throw new PromptApprovalError(
        `Not sent: this sceneBeat is not one the author approved under ${approval.id} (chapter ${approval.chapter_number}; beats ${list}). If it is a narrow rerun of one of those beats, pass rerunOfBeat with its index and rerunReason. A new beat, or a beat whose facts changed, needs a new Go: show the author the prompt and call record_prompt_approval again.`
      );
    }
    kind = "approved";
  }
  await store.insertCall({
    approval_id: approval.id,
    beat_index: beat.index,
    kind,
    scene_beat: params.sceneBeat,
    compiled_context: params.compiledContext,
    rerun_reason: kind === "rerun" ? params.rerunReason!.trim() : null,
  });
  return { approval, beat, kind };
}

export function isGoGateEnabled(): boolean {
  return (process.env.GO_GATE ?? "on").toLowerCase() !== "off";
}
