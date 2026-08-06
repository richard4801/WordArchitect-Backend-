import type { Response } from "express";
import { getEnvVar } from "../lib/env.js";
import { DIRECTIVE_OPEN, DIRECTIVE_CLOSE } from "../lib/bracketInstructions.js";

const HANAMI_MODEL = "Sao10K-L3.1-70B-Hanami-x1";
const TEMPERATURE = 0.85;

interface InfermaticStreamChoice {
  delta?: { content?: string };
  finish_reason?: string | null;
}

interface InfermaticStreamChunk {
  choices?: InfermaticStreamChoice[];
}

// Opens the upstream Infermatic SSE stream and yields each prose token as
// it arrives. Shared by streamHanamiProse (writes tokens straight to an
// Express response as they arrive) and generateHanamiProse (buffers them
// into one string) so the SSE-parsing logic only lives in one place.
async function* streamHanamiTokens(
  systemPrompt: string,
  userPrompt: string,
  temperature: number = TEMPERATURE
): AsyncGenerator<string> {
  const baseUrl = getEnvVar("INFERMATIC_BASE_URL").replace(/\/+$/, "");
  const apiKey = getEnvVar("INFERMATIC_API_KEY");

  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: HANAMI_MODEL,
      temperature,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const errorText = await upstream.text().catch(() => upstream.statusText);
    throw new Error(`Hanami generation request failed (${upstream.status}): ${errorText}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice("data:".length).trim();
      if (payload === "[DONE]") return;

      try {
        const parsed = JSON.parse(payload) as InfermaticStreamChunk;
        const token = parsed.choices?.[0]?.delta?.content;
        if (token) yield token;
      } catch {
        // Partial/malformed SSE fragment — skip and continue on the next line.
      }
    }
  }
}

// Finds the longest suffix of `text` that's also a prefix of `pattern` —
// i.e. how much of a partial match could still complete into `pattern` if
// more text arrives. Used to hold back exactly that much when streaming,
// so a tag split across two token chunks (e.g. "<<DIREC" + "TIVE: ...")
// is never emitted piecemeal before it's known whether it's really a tag.
function longestPartialSuffixMatch(text: string, pattern: string): number {
  const max = Math.min(text.length, pattern.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(pattern.slice(0, len))) return len;
  }
  return 0;
}

// Backstop against Hanami imitating and echoing its own <<DIRECTIVE: ...>>
// tag into the actual prose (observed in testing — an RP-tuned model has a
// learned habit of bracketed OOC asides, and a fabricated tag of its own
// can slip through even with an explicit "never do this" instruction).
// Buffers only while a potential tag might be forming, so normal streaming
// is unaffected outside that rare case; a genuine tag span (open...close)
// is dropped entirely rather than passed through.
async function* stripLeakedDirectiveTags(tokens: AsyncGenerator<string>): AsyncGenerator<string> {
  let buffer = "";
  for await (const token of tokens) {
    buffer += token;

    while (true) {
      const openIndex = buffer.indexOf(DIRECTIVE_OPEN);
      if (openIndex === -1) {
        const holdBack = longestPartialSuffixMatch(buffer, DIRECTIVE_OPEN);
        if (buffer.length > holdBack) {
          yield buffer.slice(0, buffer.length - holdBack);
          buffer = buffer.slice(buffer.length - holdBack);
        }
        break;
      }

      if (openIndex > 0) {
        yield buffer.slice(0, openIndex);
        buffer = buffer.slice(openIndex);
      }

      const closeIndex = buffer.indexOf(DIRECTIVE_CLOSE);
      if (closeIndex === -1) {
        // Tag has started but hasn't fully arrived — wait for more tokens
        // rather than risk emitting a partial tag.
        break;
      }
      buffer = buffer.slice(closeIndex + DIRECTIVE_CLOSE.length);
    }
  }
  if (buffer) yield buffer;
}

// Streams Hanami prose generation chunk-by-chunk directly onto the Express
// response as it arrives — used by /generate-prose for the browser test UI.
export async function streamHanamiProse(systemPrompt: string, userPrompt: string, res: Response): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    for await (const token of stripLeakedDirectiveTags(streamHanamiTokens(systemPrompt, userPrompt))) {
      res.write(token);
    }
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
}

// Buffers the full Hanami response into one string instead of streaming it
// to an HTTP response — used by the direct-generate path (MCP tool calls,
// and any caller that needs the complete prose as a single return value
// rather than a live stream). temperature defaults to the same creative
// setting prose generation uses; callers that need strict instruction-
// following instead of creative variation (e.g. the /ask retrieval-accuracy
// route, which needs Hanami to stick to "answer only from context" rather
// than embellish) should pass a lower value explicitly.
export async function generateHanamiProse(
  systemPrompt: string,
  userPrompt: string,
  temperature?: number
): Promise<string> {
  let full = "";
  for await (const token of stripLeakedDirectiveTags(streamHanamiTokens(systemPrompt, userPrompt, temperature))) {
    full += token;
  }
  return full;
}
