// In-terminal seed & test runner (Stage 5).
//
// Seeds a fixed test book with Codex entries and manuscript chunks, runs a
// simulated scene beat through assembleContextPayload() to verify Layer
// 1/2/3 retrieval accuracy and token budgets, then fires the compiled
// context at Hanami via streamHanamiProse() and streams the prose straight
// to stdout. No frontend required — this is the whole pipeline exercised
// end-to-end from the terminal.
import "dotenv/config";
import type { Response } from "express";
import { getSupabaseClient } from "../src/lib/supabaseClient.js";
import { generateEmbedding } from "../src/services/embedding.js";
import { assembleContextPayload } from "../src/services/rag.js";
import { streamHanamiProse } from "../src/services/llm.js";
import { buildSystemPrompt } from "../src/routes/generateProse.js";
import { estimateTokens } from "../src/lib/tokenBudget.js";

// Fixed, well-formed UUIDs so repeated runs are idempotent (existing rows
// for this book are wiped and re-seeded on every run).
const TEST_USER_ID = "a0000000-0000-0000-0000-000000000001";
const TEST_BOOK_ID = "b0000000-0000-0000-0000-000000000001";

const REQUIRED_ENV_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "INFERMATIC_API_KEY",
  "INFERMATIC_BASE_URL",
];

function printSection(title: string): void {
  const bar = "═".repeat(78);
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}

function printError(label: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n✗ ${label}\n  ${message}`);
  if (err instanceof Error && err.stack && process.env.DEBUG) {
    console.error(err.stack);
  }
}

function preflightEnvCheck(): void {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    printSection("✗ Missing environment variables");
    console.error(`  Missing: ${missing.join(", ")}`);
    console.error("  Copy .env.example to .env and fill in real credentials, then re-run.");
    process.exitCode = 1;
    throw new Error("Preflight environment check failed.");
  }
}

interface SeedCodexEntry {
  name: string;
  aliases: string[];
  entry_type: "character" | "location" | "item" | "lore";
  description: string;
}

const CODEX_SEED: SeedCodexEntry[] = [
  {
    name: "Torin",
    aliases: ["Tor"],
    entry_type: "character",
    description:
      "Torin is a weathered trader who navigates the northern trade routes. Fiercely loyal to family, " +
      "he carries the weight of a promise made to his late uncle, Denner, and rarely speaks of the debt.",
  },
  {
    name: "The Broken Copper Coin",
    aliases: ["the coin", "the copper coin"],
    entry_type: "item",
    description:
      "A copper coin snapped cleanly in half, its edges worn smooth by decades of handling. Torin's uncle " +
      "gave him this half in the misty market of Kell's Landing as a token of an unfulfilled promise.",
  },
];

interface SeedManuscriptChunk {
  chapter_number: number;
  scene_order: number;
  raw_text: string;
}

const MANUSCRIPT_SEED: SeedManuscriptChunk[] = [
  {
    chapter_number: 1,
    scene_order: 1,
    raw_text:
      "The market at Kell's Landing was thick with fog that morning, the kind that swallowed lantern light " +
      "before it reached the cobblestones. Torin's uncle Denner pressed something small and cold into his " +
      "palm without a word, his grip lingering a moment longer than it needed to.",
  },
  {
    chapter_number: 1,
    scene_order: 2,
    raw_text:
      "\"It's broken,\" Torin said, turning the copper coin over between his fingers. \"That's the point,\" " +
      "Denner replied, voice low against the market din. \"The other half is out there somewhere. One day " +
      "you'll need to find who holds it, and they'll know you by this.\"",
  },
  {
    chapter_number: 2,
    scene_order: 1,
    raw_text:
      "The tavern brawl started over a spilled tankard and ended with three broken chairs and a bloodied " +
      "nose. Torin watched from the corner booth, unwilling to get involved in a fight that wasn't his, " +
      "nursing a warm ale while the innkeeper shouted for the watch.",
  },
  {
    chapter_number: 3,
    scene_order: 1,
    raw_text:
      "Six weeks at sea had worn the color from everything Torin owned. The ship creaked against a swell " +
      "as the crew hauled in nets heavy with silverfish, and the coastline of a country he didn't recognize " +
      "finally broke the horizon to the east.",
  },
];

const SCENE_BEAT =
  "Torin pulled the cold coin from his tunic, remembering the misty market where his uncle gave it to him.";

const RECENT_HISTORY_TEXT =
  "The caravan had stopped for the night at the edge of the salt flats, tents pitched against a wind that " +
  "never quite settled. Torin sat apart from the others, the fire throwing long shadows across the sand. " +
  "He hadn't spoken much since they'd left the last town — not since the merchant there had mentioned a man " +
  "matching Denner's description, three years dead by every account Torin had ever trusted. He turned the " +
  "thought over the way he turned the coin, worrying at the edges of it, looking for a seam that would let " +
  "it come apart into something that made sense.";

async function seedCodexEntries(): Promise<void> {
  const supabase = getSupabaseClient();

  const { error: deleteError } = await supabase.from("codex_entries").delete().eq("book_id", TEST_BOOK_ID);
  if (deleteError) {
    throw new Error(`Failed to clear existing codex_entries: ${deleteError.message}`);
  }

  for (const entry of CODEX_SEED) {
    const embedding = await generateEmbedding(`${entry.name}. ${entry.description}`);
    const { data, error } = await supabase
      .from("codex_entries")
      .insert({
        user_id: TEST_USER_ID,
        book_id: TEST_BOOK_ID,
        name: entry.name,
        aliases: entry.aliases,
        entry_type: entry.entry_type,
        description: entry.description,
        embedding,
      })
      .select("id, name, entry_type")
      .single();

    if (error) {
      throw new Error(`Failed to insert codex entry "${entry.name}": ${error.message}`);
    }
    console.log(`  ✓ codex_entries: "${data.name}" [${data.entry_type}] (id: ${data.id})`);
  }
}

async function seedManuscriptChunks(): Promise<void> {
  const supabase = getSupabaseClient();

  const { error: deleteError } = await supabase.from("manuscript_chunks").delete().eq("book_id", TEST_BOOK_ID);
  if (deleteError) {
    throw new Error(`Failed to clear existing manuscript_chunks: ${deleteError.message}`);
  }

  for (const chunk of MANUSCRIPT_SEED) {
    const embedding = await generateEmbedding(chunk.raw_text);
    const { data, error } = await supabase
      .from("manuscript_chunks")
      .insert({
        user_id: TEST_USER_ID,
        book_id: TEST_BOOK_ID,
        chapter_number: chunk.chapter_number,
        scene_order: chunk.scene_order,
        raw_text: chunk.raw_text,
        embedding,
      })
      .select("id, chapter_number, scene_order")
      .single();

    if (error) {
      throw new Error(`Failed to insert manuscript chunk (ch${chunk.chapter_number}/${chunk.scene_order}): ${error.message}`);
    }
    console.log(
      `  ✓ manuscript_chunks: ch${data.chapter_number} scene${data.scene_order} (id: ${data.id})`
    );
  }
}

function summarizeContextPayload(contextPayload: string): void {
  const layers = contextPayload.split("\n\n---\n\n").filter(Boolean);

  if (layers.length === 0) {
    console.log("  (no layers matched — empty context payload)");
    return;
  }

  for (const layer of layers) {
    const [headerLine] = layer.split("\n");
    const tokens = estimateTokens(layer);
    console.log(`  • ${headerLine?.replace(/^##\s*/, "")} — ~${tokens} tokens`);

    const similarityMatches = [...layer.matchAll(/similarity:\s*([\d.]+)/g)];
    for (const match of similarityMatches) {
      console.log(`      match similarity: ${match[1]}`);
    }
  }

  const totalTokens = estimateTokens(contextPayload);
  console.log(`\n  Total compiled context: ~${totalTokens} tokens (hard cap: 4000, per CLAUDE.md)`);
}

function createStdoutResponse(): Response {
  let ended = false;
  return {
    setHeader() {
      // no-op — terminal output has no HTTP headers to set
    },
    write(chunk: string) {
      process.stdout.write(chunk);
      return true;
    },
    end() {
      if (!ended) {
        ended = true;
        process.stdout.write("\n");
      }
    },
    get writableEnded() {
      return ended;
    },
  } as unknown as Response;
}

async function main(): Promise<void> {
  printSection("WordArchitect — Dual-Layer Context Engine Test Harness");

  preflightEnvCheck();

  printSection("1. Seeding Codex Entries");
  try {
    await seedCodexEntries();
  } catch (err) {
    printError("Codex seeding failed", err);
    process.exitCode = 1;
    return;
  }

  printSection("2. Seeding Manuscript Chunks");
  try {
    await seedManuscriptChunks();
  } catch (err) {
    printError("Manuscript chunk seeding failed", err);
    process.exitCode = 1;
    return;
  }

  printSection("3. Simulated Scene Beat");
  console.log(`  Scene beat:      "${SCENE_BEAT}"`);
  console.log(`  Recent history:  "${RECENT_HISTORY_TEXT.slice(0, 90)}..."`);

  printSection("4. Assembling Dual-Layer Context Payload");
  let contextPayload: string;
  try {
    const startedAt = Date.now();
    contextPayload = await assembleContextPayload({
      userId: TEST_USER_ID,
      bookId: TEST_BOOK_ID,
      userSceneBeat: SCENE_BEAT,
      recentHistoryText: RECENT_HISTORY_TEXT,
    });
    const elapsedMs = Date.now() - startedAt;

    console.log(`  Assembled in ${elapsedMs}ms\n`);
    summarizeContextPayload(contextPayload);
    console.log("\n  --- Full compiled context ---\n");
    console.log(contextPayload);
  } catch (err) {
    printError("assembleContextPayload failed", err);
    process.exitCode = 1;
    return;
  }

  printSection("5. Streaming Hanami Prose Generation");
  try {
    const systemPrompt = buildSystemPrompt(contextPayload);
    console.log("  Generating (streaming live below)...\n");
    await streamHanamiProse(systemPrompt, SCENE_BEAT, createStdoutResponse());
  } catch (err) {
    printError("streamHanamiProse failed", err);
    process.exitCode = 1;
    return;
  }

  printSection("✓ Stage 5 test run complete");
}

main().catch((err) => {
  printError("Unexpected failure", err);
  process.exitCode = 1;
});
