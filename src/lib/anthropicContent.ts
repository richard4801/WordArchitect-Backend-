import type Anthropic from "@anthropic-ai/sdk";

// When a call uses server-side tools (web_search/web_fetch), a single
// response.content array can interleave the model's own "thinking out
// loud between tool calls" text blocks with the tool_use/tool_result
// blocks — e.g. "Let me search for X first" before a search, "Now let
// me check Y" before a fetch — alongside the real final answer. Naively
// joining every text block (`.filter(type === "text").join("\n")`)
// includes all of that narration verbatim in what's shown to the writer.
//
// Confirmed live: a platform_researcher run came back with visible
// "Good, got useful results this time. Let me do more targeted
// searches..." / "Tool budget is exhausted; let me mine the full text
// I already retrieved." lines prepended to the actual document, despite
// an explicit system-prompt instruction not to narrate — the instruction
// alone isn't reliable enough. This extracts only the text blocks that
// come after the LAST tool-related block — the model's genuine final
// answer — discarding every interstitial narration block before it.
// Falls back to every text block (the old behavior) when there's no
// tool use in the response at all, so a plain non-tool call is
// unaffected.
export function extractFinalText(content: Anthropic.ContentBlock[]): string {
  let lastToolBlockIndex = -1;
  content.forEach((block, i) => {
    if (block.type !== "text") lastToolBlockIndex = i;
  });

  return content
    .slice(lastToolBlockIndex + 1)
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
