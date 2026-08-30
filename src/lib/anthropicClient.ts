import Anthropic from "@anthropic-ai/sdk";
import { getEnvVar } from "./env.js";

let client: Anthropic | undefined;

export function getAnthropicClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: getEnvVar("ANTHROPIC_API_KEY") });
  }
  return client;
}
