import { diffWordsWithSpace } from "diff";

export interface TextDiffResult {
  diffText: string;
  wordsAdded: number;
  wordsRemoved: number;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// Word-level diff (not line-level — prose isn't reliably line-structured
// within a paragraph, and the failure mode this exists to catch is a
// silently dropped clause or an unexpected inserted detail, not a
// line-boundary change). {-removed-} / {+added+} is unambiguous, greppable
// plain text — readable directly in a tool result without needing markup
// rendering. Built specifically because supervising Hanami across passes
// otherwise means manually eyeballing two full drafts side by side to
// catch drift outside the intended change, which is slow and error-prone
// by hand — confirmed in real use, where a dropped clause only got caught
// because a human happened to notice it.
export function diffDrafts(oldText: string, newText: string): TextDiffResult {
  const parts = diffWordsWithSpace(oldText, newText);

  let diffText = "";
  let wordsAdded = 0;
  let wordsRemoved = 0;

  for (const part of parts) {
    if (part.added) {
      diffText += `{+${part.value}+}`;
      wordsAdded += countWords(part.value);
    } else if (part.removed) {
      diffText += `{-${part.value}-}`;
      wordsRemoved += countWords(part.value);
    } else {
      diffText += part.value;
    }
  }

  return { diffText, wordsAdded, wordsRemoved };
}
