export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word, case-insensitive check for whether any of the given
// name/alias candidates appears in text. Used by Layer 1's scene beat
// matching (rag.ts).
export function textMentionsAnyOf(text: string, candidates: (string | null | undefined)[]): boolean {
  return candidates.filter(Boolean).some((candidate) => {
    const pattern = new RegExp(`\\b${escapeRegExp(candidate as string)}\\b`, "i");
    return pattern.test(text);
  });
}
