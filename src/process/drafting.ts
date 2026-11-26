// The drafting process, as one versioned source of truth. Ported from the
// author's "How Claude Drafts Your Chapters with Hanami" (docs/process/
// claude-hanami-drafting-process.pdf, 26 Nov 2026), with the facts that have
// changed since corrected (see CORRECTIONS below). Everything a connected
// Claude is told about the process is rendered from this file:
//   - the MCP `instructions` every client receives at connect,
//   - the MCP prompt `chapter_workflow` and the tool `get_drafting_process`,
//   - GET /api/v1/process (the human document),
//   - GET /api/v1/skills/:name/download (the Claude-side SKILL.md files).
// Book-specific rules (house rules, banned patterns, voice rulings) are NOT
// here: they are data in book_rulings, shown to every reviewer.
// Bump PROCESS_VERSION whenever any of this changes.

export const PROCESS_VERSION = "2026-11-26.1";

export interface ProcessStep {
  n: number;
  id: string;
  title: string;
  rule: string;
  source: string;
  tools: string[];
  // What the backend refuses if this step is skipped (empty = Claude's
  // discipline, not enforced).
  enforced: string;
}

export const ROLES: { party: string; role: string }[] = [
  { party: "The author", role: "Author and final authority. Gives the plot and rulings, approves cards and Hanami prompts (\"Go\"), comments on drafts, edits directly, and says when to save." },
  { party: "Claude (the drafting session)", role: "Researches the manuscript, builds the card, writes the Hanami prompts, sends them one beat at a time, corrects what comes back, assembles the chapter, answers comments, and saves with a ledger note." },
  { party: "Hanami", role: "The prose model behind generate_prose_direct (Sao10K-L3.1-70B-Hanami-x1 on Infermatic). Writes the first draft of every passage from the prompts it is given. Stateless: it remembers nothing between calls." },
  { party: "Reviewer subagents", role: "Independent reviewers (the gatekeeper and the craft skills), each a subagent the drafting Claude launches but does not control. Each fetches its own brief from the backend and submits a verdict the backend validates." },
  { party: "WordArchitect (the backend)", role: "Holds the manuscript, Codex, notes, rulings and draft sessions; runs Hanami calls; enforces banned terms (Ghost Editor), the narration switch, the manuscript-first gate, the recorded Go and the review gate." },
];

export const STEPS: ProcessStep[] = [
  {
    n: 1,
    id: "manuscript_context",
    title: "Manuscript context first",
    rule: "Before carding, drafting or answering anything about the story, query the manuscript on everything mentioned: where the story stands, the POV character's current state, every person, place and object in the scene. The manuscript is the source of truth; memory and summaries are suspect. A name not in the Codex is looked up in the manuscript, not skipped. Search three phrasings before calling anything unsupported. A character's claim is not a fact.",
    source: "Author rulings, 18 Nov and 26 Nov",
    tools: ["search_manuscript", "get_manuscript_chapter", "get_codex_entry", "list_book_rulings"],
    enforced: "generate_prose_direct, start_scene_draft_session, request_reviews and save_manuscript_scene refuse until every name in the text has a lookup in the last 6 hours, and list the missing ones (and any name the manuscript has never mentioned).",
  },
  {
    n: 2,
    id: "timeline",
    title: "Timeline and travel times",
    rule: "Check the timeline and the pinned ledger notes so the day, the time of day and who is where all hold.",
    source: "Process, 26 Nov",
    tools: ["list_notes", "search_manuscript"],
    enforced: "",
  },
  {
    n: 3,
    id: "plot_check",
    title: "Plot check with the author",
    rule: "Lay out what the page supports, a rough shape, and the questions the checks raise. Flag plot problems the moment you see them and offer ideas.",
    source: "Author preference",
    tools: [],
    enforced: "",
  },
  {
    n: 4,
    id: "card",
    title: "Beat card (MOMENT pattern)",
    rule: "POV, time, place, who is present, who is off the page, likely length, the hard facts Hanami must hold, the moments M1, M2, ... in order, the card's own rules, and the items still open. The card is for the author and for Claude; Hanami never sees it, only prompts built from it.",
    source: "Process, 26 Nov",
    tools: [],
    enforced: "",
  },
  {
    n: 5,
    id: "card_review",
    title: "Reviewers on the card",
    rule: "Call request_reviews with targetType beat_card and the chapter number, then launch one subagent per launch prompt. Apply the fixes to the card and report each one to the author.",
    source: "Process, 26 Nov; reviewers run as subagents (author, 26 Nov)",
    tools: ["request_reviews", "get_skill_review"],
    enforced: "record_prompt_approval refuses without a completed beat_card review for the chapter (a BLOCK or incomplete review needs the author's override reason).",
  },
  {
    n: 6,
    id: "go",
    title: "Show the author the exact prompts and wait for Go",
    rule: "Nothing goes to Hanami until the author has seen the exact prompts (compiledContext and sceneBeat for every beat) and said Go. Then call record_prompt_approval with the beats and the author's words, quoted exactly. A new beat or a changed fact needs a new Go.",
    source: "Author rule; recorded Go decided 26 Nov",
    tools: ["record_prompt_approval"],
    enforced: "generate_prose_direct requires approvalId and refuses a sceneBeat that is not an approved beat or a declared rerun of one (rerunOfBeat + rerunReason). The author's quote and every call are listed by get_chapter_workflow.",
  },
  {
    n: 7,
    id: "one_beat",
    title: "Feed Hanami one beat at a time",
    rule: "Never the whole chapter in one call. Give shape, not script, so Hanami finds its own words; dialogue already on the page or set by the author is quoted exactly.",
    source: "Author rules",
    tools: ["generate_prose_direct", "start_scene_draft_session"],
    enforced: "",
  },
  {
    n: 8,
    id: "correct",
    title: "Correct what comes back",
    rule: "Mechanical fixes, narrow reruns of single paragraphs, and your own stitches where nothing else works. Rule 8b: don't throw away a good pass; rerun only when a pass is broken throughout. Report every change, including your own lines, and log each pass with record_scene_draft_iteration.",
    source: "Author rule 8b",
    tools: ["generate_prose_direct", "record_scene_draft_iteration", "diff_drafts"],
    enforced: "",
  },
  {
    n: 9,
    id: "assemble",
    title: "Assemble and present the whole chapter once",
    rule: "Present the chapter whole, not in bits.",
    source: "Author rule",
    tools: [],
    enforced: "",
  },
  {
    n: 10,
    id: "prose_review",
    title: "Reviewers on the prose",
    rule: "Call request_reviews with targetType prose_chapter (or prose_scene) on the exact assembled text and launch one subagent per launch prompt. Apply the fixes and report them. Any edit after a review needs a fresh review of the final text.",
    source: "Process, 26 Nov",
    tools: ["request_reviews", "get_skill_review"],
    enforced: "save_manuscript_scene requires skillReviewId for the exact text being saved (content hash).",
  },
  {
    n: 11,
    id: "author_read",
    title: "The author reads and comments",
    rule: "Put the draft where the author reads and comments. Answer each comment in its own thread; report what changed.",
    source: "Process, 26 Nov",
    tools: [],
    enforced: "",
  },
  {
    n: 12,
    id: "save",
    title: "Save when the author says so",
    rule: "Check the chapter slot is empty (get_manuscript_chapter), give it a specific title (never a generic one), put the POV name on the first line and end with * * *. Save, write a pinned ledger note that includes the TIMING, then finish the draft session.",
    source: "Author rules",
    tools: ["get_manuscript_chapter", "save_manuscript_scene", "create_note", "finish_scene_draft_session"],
    enforced: "save_manuscript_scene refuses while a review is pending, if the text differs from what was reviewed, or on a BLOCKED/incomplete review without the author's override reason.",
  },
];

export const CALL_TEMPLATE = `compiledContext:
Narrator: <POV name>, <first/third> person (<I, me / he, she>), <PAST/PRESENT> TENSE (<three example verbs>).
[who they are, where they are, what they know right now]
[hard facts for this beat, stated as facts]
No dashes. Figures of speech only if fresh. Never use <the book's banned words>.
No invented names, hair or eye colours. No one-line paragraphs.
[colour note: whose moment this is; give their angle]

Story so far:
[the last paragraph or two of ACCEPTED prose, verbatim]   <- the anchor

sceneBeat:
Continue, <tense>, <person>, <N> paragraphs, then STOP.
[the beat as shape: what happens and what the narrator notices, in order]
STOP <exact stop point>. <what must NOT happen yet>

Also pass: userId, bookId, approvalId (and rerunOfBeat + rerunReason for a rerun).`;

export const CALL_PRINCIPLES: string[] = [
  "One beat per call. Hanami's scope discipline drops sharply past about one paragraph's worth of instruction.",
  "An anchor in real prose. End compiledContext with actual accepted sentences, not a summary; a summary as \"story so far\" makes it run on into new scenes.",
  "The beat goes in sceneBeat, never buried in compiledContext (it then treats the beat as already done and writes past it).",
  "Explicit STOP and \"not yet\" lines, e.g. \"STOP on him knowing her. Do not describe any smell yet.\"",
  "Facts stated as facts (\"She is STILL FULLY CLOTHED\"); without them Hanami moves events early.",
  "Shape, not script: what happens and what the narrator notices; the wording is Hanami's.",
  "Restate the bans every call: Hanami invents small physical details unless told not to, every time.",
  "Spell out person and tense in compiledContext even when the book's narration switch is set; the switch also injects and verifies it, but the anchor is what holds it.",
];

export const CORRECTION_KINDS: { kind: string; when: string }[] = [
  { kind: "Mechanical fix", when: "A word, a clause, tense or punctuation is wrong but the passage works." },
  { kind: "Narrow rerun", when: "One paragraph is broken, or the author asked for a rewrite of one paragraph (generate_prose_direct with rerunOfBeat + rerunReason)." },
  { kind: "Full rerun of a beat", when: "The pass is broken throughout (rule 8b)." },
  { kind: "Claude stitch", when: "Hanami won't produce the line after a rerun, or a short bridge is needed. Always reported to the author." },
  { kind: "Author's edits", when: "The author edits directly; their text is used verbatim." },
];

export const HANAMI_BEHAVIOUR: { behaviour: string; response: string }[] = [
  { behaviour: "Runs past the stop line into invented plot", response: "Discard; add a hard limit and an explicit STOP." },
  { behaviour: "Invents named characters", response: "Discard; beat in sceneBeat, anchored in prose; \"no invented names\" every call." },
  { behaviour: "Tense and person drift", response: "Spell out the tense with example verbs; convert by hand when the content is good." },
  { behaviour: "Echoes the prompt (bracket notes come back as prose)", response: "Reject; rephrase the beat as plain shape." },
  { behaviour: "Invents physical detail (hair, eyes, scars, objects)", response: "Cut, and restate the ban every call." },
  { behaviour: "Breaks facts on the page", response: "Rerun with the facts stated; or cut." },
  { behaviour: "Stock phrases and stale similes", response: "Cut or make plain (the anti-slop reviewer and the scan note on every draft flag them)." },
  { behaviour: "Tells the conclusion", response: "Cut; show it through the body instead." },
  { behaviour: "Won't make a character admit something", response: "Claude stitch, reported to the author." },
];

export const CRAFT_RULES: string[] = [
  "Person and tense as the book sets them. No dashes, except a dash for cut-off dialogue; ellipses for trailing words.",
  "No stock phrases. Figures of speech only if fresh (the author reversed the blanket simile ban).",
  "No invented eye or hair colours, names or history. A POV character can't name places nobody told them about, and can't see a look, only what a face does.",
  "Secrets show as shape until another character's mouth lands them; the narrator doesn't conclude a reveal for the reader.",
  "A blow needs a trigger and the other person's reaction, written through the body. Every turn gets a beat of stillness.",
  "No filler that re-narrates. Recognition is a process. Each POV colours the moment; don't re-run another POV's scene.",
  "Chapters of about 800 to 1,300 words; splits are welcome.",
  "The book's own rulings (list_book_rulings) rank above every craft rule: author rulings > manuscript facts > craft > market.",
];

export const SAVING_RULES: string[] = [
  "Slot check: get_manuscript_chapter returns no content for the chapter before saving.",
  "A specific title, never a generic one; the POV name on the first line; end with * * *.",
  "Save the author's edited text verbatim with save_manuscript_scene (skillReviewId of the final text).",
  "A pinned ledger note with the TIMING, the beats, the rulings made, the next step and carry-forward rules.",
  "Mark the draft session done with finish_scene_draft_session.",
];

// What changed since the PDF was written (26 Nov), so a session working from
// an old copy is corrected.
export const CORRECTIONS: string[] = [
  "Hanami is Sao10K-L3.1-70B-Hanami-x1 on Infermatic (api.totalgpt.ai), called at temperature 1.3 with the provider's sampler preset (min_p 0.02, top_p 0.95, top_k 40, repetition penalty 1.05). The model name is not in the tool's response; it is fixed in the backend.",
  "generate_prose_direct requires bookId as well as userId. With bookId, the book's narration switch (POV + tense, when both are set on the book) is injected and the result is checked and corrected automatically.",
  "\"No similes\" is replaced by \"figures of speech only if fresh\".",
  "The gatekeeper and the craft skills now run as backend-defined reviewers: request_reviews returns one launch prompt per skill; launch one subagent per prompt; each subagent calls get_review_brief and submit_review_verdict itself.",
  "Banned terms are fixed sentence by sentence by a backend editor (Ghost Editor) before the text reaches you; the response says what it changed and warns about anything it couldn't fix.",
  "Every Hanami call needs a recorded Go (record_prompt_approval) and every save needs a review of the exact text.",
];

export const LIMITS: string[] = [
  "The backend proves an agent asked the manuscript, not that it used the answer.",
  "The backend can't prove the author said the words quoted as their Go; it stores the quote for the author to check.",
  "A reviewer subagent could in principle be faked by the drafting session; the server-built brief, the verbatim-quote check and the stored record make that hard and visible, not impossible.",
];
