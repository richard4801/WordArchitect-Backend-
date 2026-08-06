// Inline, positional directives a writer can drop straight into a scene
// beat — e.g. "he opens the door (describe the cold air first) and steps
// in" — instead of only being able to give chapter-wide instructions.
// Deliberately () only: every other bracket type ([], {}, <>) is left as
// plain text with no special meaning, so a character's own use of
// brackets in dialogue or narration is never misread as a directive.
const BRACKET_INSTRUCTION_PATTERN = /\(([^()]+)\)/g;

export interface MarkedBeat {
  text: string;
  instructionCount: number;
}

// The tag itself. `<<DIRECTIVE: ...>>` rather than the more obvious
// `[INSTRUCTION: ...]` — testing found Hanami would occasionally imitate a
// bracket-style tag and echo a fabricated one of its own into the output
// (it's an RP-tuned model with a learned habit of bracketed OOC asides,
// and a single-bracket tag matches that pattern closely enough to trigger
// it). Double angle brackets are further from that learned convention.
// This is a mitigation, not a guarantee — see stripLeakedDirectiveTags in
// llm.ts for the actual backstop that removes any tag-shaped text that
// still leaks through before it reaches the writer.
const DIRECTIVE_OPEN = "<<DIRECTIVE:";
const DIRECTIVE_CLOSE = ">>";

// Rewrites each (parenthetical) note into an explicit, unambiguous
// directive tag rather than leaving it as plain prose Hanami could try to
// narrate or quote verbatim. Kept exactly where the writer placed it in
// the beat, since the point is to scope the instruction to that specific
// moment in the scene, not the whole chapter — that's what the existing
// chapter-level MUST/MUST NOT fields are for.
export function markBracketedInstructions(sceneBeat: string): MarkedBeat {
  let instructionCount = 0;
  const text = sceneBeat.replace(BRACKET_INSTRUCTION_PATTERN, (_match, inner: string) => {
    const trimmed = inner.trim();
    if (!trimmed) return "";
    instructionCount += 1;
    return `${DIRECTIVE_OPEN} ${trimmed}${DIRECTIVE_CLOSE}`;
  });
  return { text, instructionCount };
}

export { DIRECTIVE_OPEN, DIRECTIVE_CLOSE };
