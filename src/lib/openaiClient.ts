import OpenAI from "openai";
import { getEnvVar } from "./env.js";

let client: OpenAI | undefined;

export function getOpenAIClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: getEnvVar("OPENAI_API_KEY") });
  }
  return client;
}
