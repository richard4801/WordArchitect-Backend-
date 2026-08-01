// Heuristic token estimator (~4 chars/token, a standard approximation for
// English prose under GPT-family tokenizers). Avoids pulling in a full
// tokenizer just to enforce soft per-layer budgets during context assembly.
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
}
