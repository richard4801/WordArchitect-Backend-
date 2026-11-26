import { getSupabaseClient } from "../lib/supabaseClient.js";
import { READ_WINDOW_HOURS } from "./manuscriptFirst.js";
import { supabaseApprovalStore, type ApprovalCallRow, type PromptApprovalRow } from "./promptApproval.js";
import type { OverallStatus, SkillReviewRow } from "../skills/types.js";

// Per-chapter progress, kept server-side so a new session resumes where the
// last one stopped (docs/process/SYSTEM_DESIGN.md section 3). It is DERIVED
// from what the gates already record (manuscript reads, skill reviews, the
// recorded Go and its calls, draft sessions, the chapter's saved content),
// not a second table that could drift from them.

export type StepStatus = "done" | "in_progress" | "todo" | "needs_author";

export interface WorkflowStep {
  id: string;
  title: string;
  status: StepStatus;
  detail: string;
}

export interface WorkflowFacts {
  chapterNumber: number;
  recentReads: number;
  cardReviews: Pick<SkillReviewRow, "id" | "overall_status" | "override_reason" | "created_at">[];
  approvals: Pick<PromptApprovalRow, "id" | "writer_approval" | "beats" | "created_at" | "card_review_id">[];
  calls: Pick<ApprovalCallRow, "approval_id" | "beat_index" | "kind" | "rerun_reason" | "created_at">[];
  draftSessions: { id: string; status: string; iteration_count: number; label: string | null }[];
  proseReviews: Pick<SkillReviewRow, "id" | "overall_status" | "override_reason" | "target_type" | "created_at">[];
  savedWordCount: number;
}

function reviewDone(status: OverallStatus, override: string | null): boolean {
  return status === "passed" || status === "flagged" || ((status === "blocked" || status === "incomplete") && !!override);
}

export function computeWorkflow(f: WorkflowFacts): { steps: WorkflowStep[]; nextStep: string } {
  const steps: WorkflowStep[] = [];
  const saved = f.savedWordCount > 0;

  steps.push({
    id: "manuscript_context",
    title: "Manuscript context first",
    status: f.recentReads > 0 || saved ? "done" : "todo",
    detail: `${f.recentReads} manuscript lookup(s) for this book in the last ${READ_WINDOW_HOURS} hours. Every name in a card, prompt or draft needs its own lookup; the action tools name any that are missing.`,
  });

  const card = f.cardReviews[0];
  steps.push({
    id: "card_review",
    title: "Beat card reviewed",
    status: !card ? (saved ? "done" : "todo") : card.overall_status === "pending" ? "in_progress" : reviewDone(card.overall_status, card.override_reason) ? "done" : "needs_author",
    detail: card
      ? `Latest card review ${card.id}: ${card.overall_status}${card.override_reason ? ` (author override: "${card.override_reason}")` : ""}.`
      : "No beat_card review for this chapter yet.",
  });

  const go = f.approvals[0];
  steps.push({
    id: "go",
    title: "Author's Go on the prompts",
    status: go ? "done" : saved ? "done" : "todo",
    detail: go
      ? `Approval ${go.id} (${go.beats.length} beat(s): ${go.beats.map((b) => b.label).join("; ")}), author's words: "${go.writer_approval}".`
      : "No recorded Go for this chapter yet.",
  });

  const approved = f.calls.filter((c) => c.kind === "approved").length;
  const reruns = f.calls.filter((c) => c.kind === "rerun").length;
  const beatsSent = new Set(f.calls.map((c) => `${c.approval_id}:${c.beat_index}`)).size;
  const totalBeats = go ? go.beats.length : 0;
  const goCallBeats = go ? new Set(f.calls.filter((c) => c.approval_id === go.id).map((c) => c.beat_index)).size : 0;
  const openSessions = f.draftSessions.filter((s) => s.status === "in_progress");
  steps.push({
    id: "drafting",
    title: "Hanami drafting, one beat per call",
    status: saved ? "done" : !go ? "todo" : goCallBeats >= totalBeats ? "done" : f.calls.length > 0 ? "in_progress" : "todo",
    detail: `${f.calls.length} Hanami call(s) under recorded approvals (${approved} approved prompt(s), ${reruns} rerun(s)); ${beatsSent} distinct beat(s) sent${go ? `, ${goCallBeats} of ${totalBeats} from the latest approval` : ""}. Draft sessions: ${f.draftSessions.length ? f.draftSessions.map((s) => `${s.id} ${s.status} (${s.iteration_count} pass(es))`).join(", ") : "none"}.`,
  });

  const prose = f.proseReviews[0];
  steps.push({
    id: "prose_review",
    title: "Assembled chapter reviewed",
    status: !prose ? (saved ? "done" : "todo") : prose.overall_status === "pending" ? "in_progress" : reviewDone(prose.overall_status, prose.override_reason) ? "done" : "needs_author",
    detail: prose ? `Latest prose review ${prose.id} (${prose.target_type}): ${prose.overall_status}.` : "No prose review for this chapter yet.",
  });

  steps.push({
    id: "saved",
    title: "Saved when the author says so",
    status: saved ? "done" : "todo",
    detail: saved ? `Chapter ${f.chapterNumber} has ${f.savedWordCount} words saved.` : `Chapter ${f.chapterNumber} has no saved content yet.`,
  });

  const nextStep = describeNext(steps, f, openSessions.length > 0);
  return { steps, nextStep };
}

function describeNext(steps: WorkflowStep[], f: WorkflowFacts, openSession: boolean): string {
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  const n = f.chapterNumber;
  if (byId.saved!.status === "done") {
    return openSession
      ? `Chapter ${n} is saved. Write the pinned ledger note (with the TIMING) and call finish_scene_draft_session on the open session.`
      : `Chapter ${n} is saved. If the pinned ledger note (with the TIMING) isn't written yet, write it.`;
  }
  if (byId.manuscript_context!.status !== "done") {
    return "Read the manuscript first: search_manuscript / get_manuscript_chapter for where the story stands, the POV character's current state and everyone in the scene (every name you will use).";
  }
  const card = byId.card_review!;
  if (card.status === "todo") return `Build the beat card for chapter ${n}, then call request_reviews with targetType beat_card and chapterNumber ${n}, and launch one subagent per launch prompt.`;
  if (card.status === "in_progress") return "Wait for every card reviewer subagent to submit its verdict (get_skill_review shows which are pending).";
  if (card.status === "needs_author") return "The card review is BLOCKED or incomplete: fix the card and review it again, or show the author and record their override reason.";
  if (byId.go!.status !== "done") {
    return "Show the author the exact Hanami prompts (compiledContext + sceneBeat per beat) and ask. When they say Go, call record_prompt_approval with their words quoted and the card review id.";
  }
  if (byId.drafting!.status !== "done") {
    return "Send the approved beats to Hanami one at a time with generate_prose_direct (approvalId; rerunOfBeat + rerunReason for a narrow rerun), correct what comes back, and log each pass with record_scene_draft_iteration.";
  }
  const prose = byId.prose_review!;
  if (prose.status === "todo") return `Assemble the whole chapter, then call request_reviews with targetType prose_chapter and chapterNumber ${n}, and launch one subagent per launch prompt.`;
  if (prose.status === "in_progress") return "Wait for every prose reviewer subagent to submit its verdict.";
  if (prose.status === "needs_author") return "The prose review is BLOCKED or incomplete: fix the text and review again, or show the author and pass their reason as writerOverride when saving.";
  return `Present the whole chapter to the author once. Save only when they say so: check the slot is empty (get_manuscript_chapter), give a specific title, POV name on the first line, end with * * *, then save_manuscript_scene with the review id.`;
}

export async function gatherWorkflowFacts(bookId: string, chapterNumber: number): Promise<WorkflowFacts> {
  const supabase = getSupabaseClient();
  const since = new Date(Date.now() - READ_WINDOW_HOURS * 3600_000).toISOString();
  const [reads, reviews, approvals, sessions, chapter] = await Promise.all([
    supabase.from("manuscript_reads").select("id", { count: "exact", head: true }).eq("book_id", bookId).gte("created_at", since),
    supabase
      .from("skill_reviews")
      .select("id, overall_status, override_reason, target_type, created_at")
      .eq("book_id", bookId)
      .eq("chapter_number", chapterNumber)
      .order("created_at", { ascending: false })
      .limit(50),
    supabaseApprovalStore.listApprovals(bookId, chapterNumber),
    supabase
      .from("scene_draft_sessions")
      .select("id, status, iteration_count, label")
      .eq("book_id", bookId)
      .eq("chapter_number", chapterNumber)
      .order("updated_at", { ascending: false }),
    supabase.from("manuscript_chapters").select("paragraphs").eq("book_id", bookId).eq("number", chapterNumber).maybeSingle(),
  ]);
  for (const r of [reads, reviews, sessions, chapter]) if (r.error) throw new Error(`Failed to read chapter workflow: ${r.error.message}`);
  const calls = await supabaseApprovalStore.listCalls(approvals.map((a) => a.id));
  const all = (reviews.data ?? []) as Pick<SkillReviewRow, "id" | "overall_status" | "override_reason" | "target_type" | "created_at">[];
  const paragraphs = ((chapter.data?.paragraphs ?? []) as { text?: string }[]).map((p) => p.text ?? "").join(" ");
  return {
    chapterNumber,
    recentReads: reads.count ?? 0,
    cardReviews: all.filter((r) => r.target_type === "beat_card"),
    approvals,
    calls,
    draftSessions: (sessions.data ?? []) as WorkflowFacts["draftSessions"],
    proseReviews: all.filter((r) => r.target_type !== "beat_card" && r.target_type !== "planning_unit"),
    savedWordCount: paragraphs.trim() ? paragraphs.trim().split(/\s+/).length : 0,
  };
}

export async function getChapterWorkflow(bookId: string, chapterNumber: number) {
  const facts = await gatherWorkflowFacts(bookId, chapterNumber);
  const { steps, nextStep } = computeWorkflow(facts);
  return { bookId, chapterNumber, steps, nextStep, approvals: facts.approvals, calls: facts.calls };
}

// One line for tool results: "Next required step: ...". Never throws.
export async function nextStepLine(bookId: string, chapterNumber: number | null | undefined): Promise<string> {
  if (chapterNumber === null || chapterNumber === undefined) return "";
  try {
    const { nextStep } = computeWorkflow(await gatherWorkflowFacts(bookId, chapterNumber));
    return `Next required step (chapter ${chapterNumber}): ${nextStep}`;
  } catch {
    return "";
  }
}

export function describeWorkflow(w: Awaited<ReturnType<typeof getChapterWorkflow>>): string {
  const mark: Record<StepStatus, string> = { done: "[x]", in_progress: "[~]", todo: "[ ]", needs_author: "[!]" };
  const lines = [`Chapter ${w.chapterNumber} workflow:`];
  for (const s of w.steps) lines.push(`${mark[s.status]} ${s.title}: ${s.detail}`);
  if (w.calls.length) {
    lines.push("", "Hanami calls under recorded approvals:");
    for (const c of w.calls) lines.push(`- ${c.created_at} approval ${c.approval_id} beat ${c.beat_index} ${c.kind}${c.rerun_reason ? ` (reason: ${c.rerun_reason})` : ""}`);
  }
  lines.push("", `Next required step: ${w.nextStep}`);
  return lines.join("\n");
}
