import type { Response } from "express";
import { getEnvVar } from "../lib/env.js";

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

// Streams Hanami prose generation chunk-by-chunk directly onto the Express
// response as it arrives — used by /generate-prose for the browser test UI.
export async function streamHanamiProse(systemPrompt: string, userPrompt: string, res: Response): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    for await (const token of streamHanamiTokens(systemPrompt, userPrompt)) {
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
  for await (const token of streamHanamiTokens(systemPrompt, userPrompt, temperature)) {
    full += token;
  }
  return full;
}
