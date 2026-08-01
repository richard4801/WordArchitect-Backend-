import { getOpenAIClient } from "../lib/openaiClient.js";

const EXPANSION_MODEL = "gpt-4o-mini";
const MAX_CONCEPTS = 4;

export interface SceneBeatConcept {
  concept: string;
  searchText: string;
}

// Splits a scene beat into its distinct searchable concepts (plot objects,
// events, or threads — not character names, which Layer 1 already covers
// deterministically) and expands each into a fuller descriptive phrase
// closer to how it would actually read in prose. This closes two gaps at
// once: a terse beat embeds poorly against full narrative text (register
// mismatch), and a beat mixing multiple topics (e.g. "the pregnancy, and
// the totem") would otherwise be embedded as one blended vector where one
// topic can drown out the other in a single similarity search.
//
// Falls back to treating the whole beat as a single concept if expansion
// fails for any reason — Layer 3 should degrade to its original
// single-query behavior, never break generation over this.
export async function expandSceneBeatConcepts(sceneBeat: string): Promise<SceneBeatConcept[]> {
  try {
    const openai = getOpenAIClient();
    const response = await openai.chat.completions.create({
      model: EXPANSION_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You extract distinct searchable story concepts from a scene beat for a novel-writing tool's memory search.",
            `Identify up to ${MAX_CONCEPTS} distinct plot objects, events, or threads mentioned or implied — not character names.`,
            "For each, write a short descriptive search phrase (5-15 words) resembling how it might actually be described in prose, not just the bare noun.",
            'Respond with JSON: {"concepts": [{"concept": "...", "searchText": "..."}]}.',
            "If the beat has only one clear concept, return just one item. Never return an empty array.",
          ].join(" "),
        },
        { role: "user", content: sceneBeat },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error("empty response from expansion model");

    const parsed = JSON.parse(raw) as { concepts?: unknown };
    const concepts = (Array.isArray(parsed.concepts) ? parsed.concepts : [])
      .filter(
        (c): c is SceneBeatConcept =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as SceneBeatConcept).concept === "string" &&
          typeof (c as SceneBeatConcept).searchText === "string" &&
          (c as SceneBeatConcept).searchText.trim() !== ""
      )
      .slice(0, MAX_CONCEPTS);

    if (concepts.length === 0) throw new Error("no usable concepts returned");
    return concepts;
  } catch (err) {
    console.error("Scene beat concept expansion failed, falling back to raw beat:", err);
    return [{ concept: sceneBeat, searchText: sceneBeat }];
  }
}
