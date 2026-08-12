import { Router, type Request, type Response } from "express";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import {
  type CodexTier,
  type CodexRelationshipStrength,
  type CharacterArcStage,
  type CodexNote,
} from "../types/domain.js";

export const codexRouter = Router();

const VALID_TIERS: CodexTier[] = ["main", "supporting", "minor", "extra"];
const VALID_STRENGTHS: CodexRelationshipStrength[] = ["strong", "moderate", "tense", "weak"];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCharacterArc(value: unknown): value is CharacterArcStage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).stage === "string" &&
        typeof (item as Record<string, unknown>).description === "string"
    )
  );
}

// notes is an array of { title, body, date?, pinned? } — date/pinned are
// optional so a caller can omit them without the whole entry being rejected.
function isNotesArray(value: unknown): value is CodexNote[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (typeof item !== "object" || item === null) return false;
      const note = item as Record<string, unknown>;
      if (typeof note.title !== "string" || typeof note.body !== "string") return false;
      if (note.date !== undefined && note.date !== null && typeof note.date !== "string") return false;
      if (note.pinned !== undefined && typeof note.pinned !== "boolean") return false;
      return true;
    })
  );
}

// life_events/cultural_background shapes aren't settled on the frontend
// yet (see CLAUDE.md) — validated loosely as JSON objects/arrays-of-objects
// rather than against specific required fields, so a legitimate but
// not-yet-documented shape isn't rejected.
function isObjectArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((item) => isPlainObject(item));
}

// Maps the request body's camelCase fields onto codex_entries' snake_case
// columns, validating each field only when present. `requireCore` enforces
// name/entryType/description/userId/bookId for creation; PATCH omits it so
// every field stays optional on update.
function buildEntryPayload(
  body: Record<string, unknown>,
  requireCore: boolean
): { payload: Record<string, unknown>; error: string | null } {
  const payload: Record<string, unknown> = {};

  if (requireCore || body.userId !== undefined) {
    if (typeof body.userId !== "string" || body.userId.trim() === "") {
      return { payload, error: "userId is required and must be a non-empty string." };
    }
    payload.user_id = body.userId;
  }
  if (requireCore || body.bookId !== undefined) {
    if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
      return { payload, error: "bookId is required and must be a non-empty string." };
    }
    payload.book_id = body.bookId;
  }
  if (requireCore || body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return { payload, error: "name is required and must be a non-empty string." };
    }
    payload.name = body.name;
  }
  if (requireCore || body.entryType !== undefined) {
    // Open-ended: entryType is 'character' or any worldbuilding category
    // key (see world_categories / worldCategories.ts) — no longer a fixed
    // enum, since the frontend lets writers create their own categories.
    if (typeof body.entryType !== "string" || body.entryType.trim() === "") {
      return { payload, error: "entryType is required and must be a non-empty string." };
    }
    payload.entry_type = body.entryType;
  }
  if (requireCore || body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.trim() === "") {
      return { payload, error: "description is required and must be a non-empty string." };
    }
    payload.description = body.description;
  }

  if (body.aliases !== undefined) {
    if (!isStringArray(body.aliases)) return { payload, error: "aliases must be an array of strings." };
    payload.aliases = body.aliases;
  }
  if (body.tier !== undefined) {
    if (body.tier !== null && !VALID_TIERS.includes(body.tier as CodexTier)) {
      return { payload, error: `tier must be one of: ${VALID_TIERS.join(", ")}.` };
    }
    payload.tier = body.tier;
  }
  if (body.quote !== undefined) {
    if (body.quote !== null && typeof body.quote !== "string") return { payload, error: "quote must be a string." };
    payload.quote = body.quote;
  }
  if (body.imageUrl !== undefined) {
    if (body.imageUrl !== null && typeof body.imageUrl !== "string")
      return { payload, error: "imageUrl must be a string." };
    payload.image_url = body.imageUrl;
  }
  if (body.age !== undefined) {
    if (body.age !== null && typeof body.age !== "string") return { payload, error: "age must be a string." };
    payload.age = body.age;
  }
  if (body.gender !== undefined) {
    if (body.gender !== null && typeof body.gender !== "string")
      return { payload, error: "gender must be a string." };
    payload.gender = body.gender;
  }
  if (body.roleInStory !== undefined) {
    if (body.roleInStory !== null && typeof body.roleInStory !== "string")
      return { payload, error: "roleInStory must be a string." };
    payload.role_in_story = body.roleInStory;
  }
  if (body.occupation !== undefined) {
    if (body.occupation !== null && typeof body.occupation !== "string")
      return { payload, error: "occupation must be a string." };
    payload.occupation = body.occupation;
  }
  if (body.locationName !== undefined) {
    if (body.locationName !== null && typeof body.locationName !== "string")
      return { payload, error: "locationName must be a string." };
    payload.location_name = body.locationName;
  }
  if (body.physicalDescription !== undefined) {
    if (body.physicalDescription !== null && !isStringArray(body.physicalDescription))
      return { payload, error: "physicalDescription must be an array of strings." };
    payload.physical_description = body.physicalDescription;
  }
  if (body.personalityTraits !== undefined) {
    if (body.personalityTraits !== null && !isStringArray(body.personalityTraits))
      return { payload, error: "personalityTraits must be an array of strings." };
    payload.personality_traits = body.personalityTraits;
  }
  if (body.motivations !== undefined) {
    if (body.motivations !== null && !isStringArray(body.motivations))
      return { payload, error: "motivations must be an array of strings." };
    payload.motivations = body.motivations;
  }
  if (body.background !== undefined) {
    if (body.background !== null && !isStringArray(body.background))
      return { payload, error: "background must be an array of strings." };
    payload.background = body.background;
  }
  if (body.characterArc !== undefined) {
    if (body.characterArc !== null && !isCharacterArc(body.characterArc))
      return { payload, error: "characterArc must be an array of { stage, description } objects." };
    payload.character_arc = body.characterArc;
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && !isNotesArray(body.notes))
      return { payload, error: "notes must be an array of { title, body, date?, pinned? } objects." };
    payload.notes = body.notes;
  }
  if (body.eventYear !== undefined) {
    if (body.eventYear !== null && typeof body.eventYear !== "string")
      return { payload, error: "eventYear must be a string." };
    payload.event_year = body.eventYear;
  }
  if (body.nickname !== undefined) {
    if (body.nickname !== null && typeof body.nickname !== "string")
      return { payload, error: "nickname must be a string." };
    payload.nickname = body.nickname;
  }
  if (body.epithet !== undefined) {
    if (body.epithet !== null && typeof body.epithet !== "string")
      return { payload, error: "epithet must be a string." };
    payload.epithet = body.epithet;
  }
  if (body.status !== undefined) {
    if (body.status !== null && typeof body.status !== "string")
      return { payload, error: "status must be a string." };
    payload.status = body.status;
  }
  if (body.alignment !== undefined) {
    if (body.alignment !== null && typeof body.alignment !== "string")
      return { payload, error: "alignment must be a string." };
    payload.alignment = body.alignment;
  }
  if (body.povCharacter !== undefined) {
    if (typeof body.povCharacter !== "boolean") return { payload, error: "povCharacter must be a boolean." };
    payload.pov_character = body.povCharacter;
  }
  if (body.archetype !== undefined) {
    if (body.archetype !== null && typeof body.archetype !== "string")
      return { payload, error: "archetype must be a string." };
    payload.archetype = body.archetype;
  }
  if (body.favorites !== undefined) {
    if (typeof body.favorites !== "number") return { payload, error: "favorites must be a number." };
    payload.favorites = body.favorites;
  }
  if (body.motivation !== undefined) {
    if (body.motivation !== null && typeof body.motivation !== "string")
      return { payload, error: "motivation must be a string." };
    payload.motivation = body.motivation;
  }
  if (body.goal !== undefined) {
    if (body.goal !== null && typeof body.goal !== "string") return { payload, error: "goal must be a string." };
    payload.goal = body.goal;
  }
  if (body.fear !== undefined) {
    if (body.fear !== null && typeof body.fear !== "string") return { payload, error: "fear must be a string." };
    payload.fear = body.fear;
  }
  if (body.secret !== undefined) {
    if (body.secret !== null && typeof body.secret !== "string") return { payload, error: "secret must be a string." };
    payload.secret = body.secret;
  }
  if (body.lifeEvents !== undefined) {
    if (body.lifeEvents !== null && !isObjectArray(body.lifeEvents))
      return { payload, error: "lifeEvents must be an array of objects." };
    payload.life_events = body.lifeEvents;
  }
  if (body.culturalBackground !== undefined) {
    if (body.culturalBackground !== null && !isPlainObject(body.culturalBackground))
      return { payload, error: "culturalBackground must be an object." };
    payload.cultural_background = body.culturalBackground;
  }
  if (body.strengths !== undefined) {
    if (body.strengths !== null && !isStringArray(body.strengths))
      return { payload, error: "strengths must be an array of strings." };
    payload.strengths = body.strengths;
  }
  if (body.weaknesses !== undefined) {
    if (body.weaknesses !== null && !isStringArray(body.weaknesses))
      return { payload, error: "weaknesses must be an array of strings." };
    payload.weaknesses = body.weaknesses;
  }
  if (body.internalConflict !== undefined) {
    if (body.internalConflict !== null && typeof body.internalConflict !== "string")
      return { payload, error: "internalConflict must be a string." };
    payload.internal_conflict = body.internalConflict;
  }

  return { payload, error: null };
}

// GET /api/v1/codex?bookId=...&entryType=...&tier=...
codexRouter.get("/codex", async (req: Request, res: Response) => {
  const bookId = req.query.bookId;
  if (typeof bookId !== "string" || bookId.trim() === "") {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }

  const supabase = getSupabaseClient();
  let query = supabase.from("codex_entries").select("*").eq("book_id", bookId);

  if (typeof req.query.entryType === "string") {
    query = query.eq("entry_type", req.query.entryType);
  }
  if (typeof req.query.tier === "string") {
    query = query.eq("tier", req.query.tier);
  }

  const { data, error } = await query.order("name", { ascending: true });
  if (error) {
    res.status(502).json({ error: "Failed to list codex entries." });
    return;
  }
  res.json({ entries: data });
});

// GET /api/v1/codex/:id
codexRouter.get("/codex/:id", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("codex_entries").select("*").eq("id", req.params.id).maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to fetch codex entry." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No codex entry found with id ${req.params.id}.` });
    return;
  }
  res.json({ entry: data });
});

// POST /api/v1/codex
codexRouter.post("/codex", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { payload, error: validationError } = buildEntryPayload(body, true);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("codex_entries").insert(payload).select("*").single();

  if (error) {
    console.error("codex entry creation failed:", error);
    res.status(502).json({ error: "Failed to create codex entry." });
    return;
  }
  res.status(201).json({ entry: data });
});

// PATCH /api/v1/codex/:id
codexRouter.patch("/codex/:id", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { payload, error: validationError } = buildEntryPayload(body, false);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }
  if (Object.keys(payload).length === 0) {
    res.status(400).json({ error: "No updatable fields were provided." });
    return;
  }
  payload.updated_at = new Date().toISOString();

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("codex_entries")
    .update(payload)
    .eq("id", req.params.id)
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("codex entry update failed:", error);
    res.status(502).json({ error: "Failed to update codex entry." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No codex entry found with id ${req.params.id}.` });
    return;
  }
  res.json({ entry: data });
});

// DELETE /api/v1/codex/:id
codexRouter.delete("/codex/:id", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("codex_entries")
    .delete()
    .eq("id", req.params.id)
    .select("id")
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to delete codex entry." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No codex entry found with id ${req.params.id}.` });
    return;
  }
  res.status(204).end();
});

// GET /api/v1/codex/:id/relationships
codexRouter.get("/codex/:id/relationships", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("codex_relationships")
    .select("*")
    .or(`from_entry_id.eq.${req.params.id},to_entry_id.eq.${req.params.id}`);

  if (error) {
    res.status(502).json({ error: "Failed to list relationships." });
    return;
  }
  res.json({ relationships: data });
});

// POST /api/v1/codex/:id/relationships
codexRouter.post("/codex/:id/relationships", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }
  if (typeof body.toEntryId !== "string" || body.toEntryId.trim() === "") {
    res.status(400).json({ error: "toEntryId is required and must be a non-empty string." });
    return;
  }
  if (typeof body.bondType !== "string" || body.bondType.trim() === "") {
    res.status(400).json({ error: "bondType is required and must be a non-empty string." });
    return;
  }
  if (body.strength !== undefined && !VALID_STRENGTHS.includes(body.strength as CodexRelationshipStrength)) {
    res.status(400).json({ error: `strength must be one of: ${VALID_STRENGTHS.join(", ")}.` });
    return;
  }
  if (req.params.id === body.toEntryId) {
    res.status(400).json({ error: "fromEntryId and toEntryId must be different entries." });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("codex_relationships")
    .insert({
      book_id: body.bookId,
      from_entry_id: req.params.id,
      to_entry_id: body.toEntryId,
      bond_type: body.bondType,
      description: typeof body.description === "string" ? body.description : null,
      strength: body.strength ?? null,
    })
    .select("*")
    .single();

  if (error) {
    console.error("relationship creation failed:", error);
    res.status(502).json({ error: "Failed to create relationship." });
    return;
  }
  res.status(201).json({ relationship: data });
});

// DELETE /api/v1/codex/relationships/:relationshipId
codexRouter.delete("/codex/relationships/:relationshipId", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("codex_relationships")
    .delete()
    .eq("id", req.params.relationshipId)
    .select("id")
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to delete relationship." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No relationship found with id ${req.params.relationshipId}.` });
    return;
  }
  res.status(204).end();
});
