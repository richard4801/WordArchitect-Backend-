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

// Streams Hanami prose generation chunk-by-chunk directly onto the Express
// response as it arrives from Infermatic's OpenAI-compatible SSE endpoint.
export async function streamHanamiProse(
  systemPrompt: string,
  userPrompt: string,
  res: Response
): Promise<void> {
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
      temperature: TEMPERATURE,
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

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const payload = trimmed.slice("data:".length).trim();
        if (payload === "[DONE]") {
          res.end();
          return;
        }

        try {
          const parsed = JSON.parse(payload) as InfermaticStreamChunk;
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) {
            res.write(token);
          }
        } catch {
          // Partial/malformed SSE fragment — skip and continue on the next line.
        }
      }
    }
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
}
