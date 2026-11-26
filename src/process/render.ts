import {
  PROCESS_VERSION,
  ROLES,
  STEPS,
  CALL_TEMPLATE,
  CALL_PRINCIPLES,
  CORRECTION_KINDS,
  HANAMI_BEHAVIOUR,
  CRAFT_RULES,
  SAVING_RULES,
  CORRECTIONS,
  LIMITS,
} from "./drafting.js";
import { SKILLS } from "../skills/registry.js";

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

// The short version every MCP client receives at connect (no skill needed).
export function renderInstructions(): string {
  const steps = STEPS.map((s) => `${s.n}. ${s.title}.${s.enforced ? " [enforced]" : ""}`).join("\n");
  return `WordArchitect drafting process v${PROCESS_VERSION}. Follow it for every chapter; call get_drafting_process for the full text and get_chapter_workflow { bookId, chapterNumber } to see where a chapter stands and the next required step (a new session resumes there).

${steps}

Non-negotiable:
- The manuscript is the source of truth. Query it (search_manuscript, get_manuscript_chapter, get_codex_entry) on every name and thing mentioned before acting or answering; a name missing from the Codex is looked up in the manuscript. Action tools refuse until every name has a lookup.
- Nothing goes to Hanami until the author has seen the exact prompts and said Go; record it with record_prompt_approval (their words, quoted) and pass approvalId to generate_prose_direct. One beat per call.
- Reviews are run by subagents you launch, never by you: request_reviews returns one launch prompt per reviewer; spawn one subagent per prompt and do not edit what they are given. Saving needs a review of the exact final text.
- The book's rulings (list_book_rulings) outrank every craft rule. Report every change you make to Hanami's text.`;
}

export function renderProcessMarkdown(): string {
  const roles = ROLES.map((r) => `| ${r.party} | ${r.role} |`).join("\n");
  const steps = STEPS.map(
    (s) =>
      `### ${s.n}. ${s.title}\n\n${s.rule}\n\n- Source: ${s.source}${s.tools.length ? `\n- Tools: ${s.tools.map((t) => `\`${t}\``).join(", ")}` : ""}${s.enforced ? `\n- Enforced by the backend: ${s.enforced}` : ""}`
  ).join("\n\n");
  const kinds = CORRECTION_KINDS.map((k) => `| ${k.kind} | ${k.when} |`).join("\n");
  const behaviour = HANAMI_BEHAVIOUR.map((b) => `| ${b.behaviour} | ${b.response} |`).join("\n");
  const reviewers = SKILLS.map((s) => `| ${s.title} | \`${s.key}\` | ${s.maxLevel} |`).join("\n");
  return `# How Claude drafts chapters with Hanami (process v${PROCESS_VERSION})

Served by the WordArchitect backend from one source (\`src/process/drafting.ts\`). The MCP connect instructions, the \`get_drafting_process\` tool, this document and the downloadable skill files are all rendered from it.

## 1. Who does what

| Party | Role |
| --- | --- |
${roles}

## 2. The standing workflow

\`get_chapter_workflow { bookId, chapterNumber }\` shows which of these steps are done for a chapter, what the author approved and in what words, every Hanami call made under it, and the next required step.

${steps}

## 3. How a Hanami call is built

\`\`\`
${CALL_TEMPLATE}
\`\`\`

${bullets(CALL_PRINCIPLES)}

## 4. What to do with what comes back

| Kind of change | When |
| --- | --- |
${kinds}

Every change of each kind is reported to the author and logged with \`record_scene_draft_iteration\`.

## 5. Hanami behaviour to plan around

| Behaviour | What to do |
| --- | --- |
${behaviour}

## 6. The reviewers

\`request_reviews\` picks the reviewers that apply to the target (stage table) and returns a launch prompt for each. Only the gatekeeper can BLOCK (hard contradictions with the manuscript, a core prose failure, a broken author ruling); every other finding is a FLAG (shown, stored, not blocking) or a NOTE.

| Reviewer | Key | Highest level |
| --- | --- | --- |
${reviewers}

## 7. Craft rules applied to every call and fix

${bullets(CRAFT_RULES)}

## 8. Saving

${bullets(SAVING_RULES)}

## 9. Corrections since the 26 Nov document

${bullets(CORRECTIONS)}

## 10. Limits, stated plainly

${bullets(LIMITS)}
`;
}

// ---------------------------------------------------------------------------
// Claude-side skill files, generated from the same source. The names match
// the skills they replace, so uploading one swaps the old version out.
// ---------------------------------------------------------------------------

export interface SkillFile {
  name: string;
  description: string;
  render: () => string;
}

function frontMatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n`;
}

export const SKILL_FILES: SkillFile[] = [
  {
    name: "hanami-drafting",
    description:
      "The method for producing manuscript prose with Hanami through the WordArchitect connector: manuscript context, beat cards, reviews, the recorded Go, the generation call, corrections, and saving. Use whenever prose is written or revised for the book, a beat card is built, Hanami output is corrected, the author comments on a draft, or anything mentions Hanami, WordArchitect, generate_prose_direct, scene draft sessions or saving to the manuscript.",
    render() {
      return `${frontMatter(this.name, this.description)}
# Hanami drafting (WordArchitect process v${PROCESS_VERSION})

The backend holds the current process and enforces most of it. This file is a thin pointer so it never goes stale:

1. At the start of any drafting work, call \`get_drafting_process\` on the WordArchitect connector and follow what it returns. If its version differs from v${PROCESS_VERSION}, the backend's version wins; download the current skill files from \`GET /api/v1/skills\`.
2. For a chapter already in progress, call \`get_chapter_workflow { bookId, chapterNumber }\` and continue from its "Next required step".
3. When a tool refuses, it says exactly what is missing (a manuscript lookup, a card review, the author's Go, a review of the final text). Do that step; never work around a refusal.

${renderInstructions()}
`;
    },
  },
  {
    name: "story-concept-gatekeeper",
    description:
      "Run every beat card, outline and drafted chapter for a WordArchitect book through the backend's independent reviewers (the gatekeeper's continuity and line audit plus the craft skills), each run by a separate subagent, before presenting it to the author.",
    render() {
      return `${frontMatter(this.name, this.description)}
# Gatekeeper and craft reviewers (launcher)

The gatekeeper now lives in the WordArchitect backend, alongside the craft reviewers. The backend writes each reviewer's brief and checks its verdict; you only launch them.

1. Call \`request_reviews\` with \`{ userId, bookId, text, targetType, chapterNumber }\`. targetType is \`beat_card\` for a card, \`prose_scene\` or \`prose_chapter\` for assembled prose, \`prose_fragment\` for a short passage. For a Planning Engine unit use \`request_planning_reviews { userId, runId }\`.
2. For EACH launch prompt it returns, spawn one subagent (Opus) and give it that prompt exactly as returned. Do not add to it, summarise it or answer for it. Launch them in parallel.
3. Each subagent calls \`get_review_brief\` and \`submit_review_verdict\` itself. When they are done, call \`get_skill_review { reviewId }\`.
4. Show the author every BLOCK and FLAG. Apply the fixes the author agrees with, and review the final text again before saving (the save checks the text matches what was reviewed).
5. A BLOCK stops the save. Only the author can override it, with their reason in their own words (\`writerOverride\`).

Never review the work yourself in place of a subagent, and never submit a verdict yourself.
`;
    },
  },
  {
    name: "manuscript-context",
    description:
      "Ensures Claude and every subagent seek context from the WordArchitect manuscript before doing anything: before answering a question about the story, building a card, writing a prompt, reviewing or saving. Use at the start of every conversation involving the manuscript.",
    render() {
      return `${frontMatter(this.name, this.description)}
# Manuscript context

The manuscript is the source of truth. Memory, summaries and earlier conversation are suspect until checked against it.

- Before doing anything, query the WordArchitect backend on everything mentioned: every person, place, object and past event. Use \`search_manuscript\` (several phrasings), \`get_manuscript_chapter\` for the chapters where the last appearance matters and the chapter before the one being written, and \`get_codex_entry\` for Codex entries.
- If a name is not in the Codex, look it up in the manuscript; never skip it. If the manuscript has never mentioned it, it is invented or new: ask the author.
- A character's claim is not a fact: search later chapters for a reveal before treating it as true.
- Run at least three differently phrased searches before calling anything unsupported. Ask the author only when the manuscript genuinely doesn't answer.
- The book's rulings (\`list_book_rulings\`) outrank craft advice.

The backend enforces this: every lookup is logged, and \`generate_prose_direct\`, \`start_scene_draft_session\`, \`request_reviews\` and \`save_manuscript_scene\` refuse until every name in the text has a lookup in the last 6 hours, listing the ones missing.
`;
    },
  },
];

export function getSkillFile(name: string): SkillFile | undefined {
  return SKILL_FILES.find((s) => s.name === name);
}
