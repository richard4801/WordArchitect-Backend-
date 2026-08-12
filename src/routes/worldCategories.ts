import { Router, type Request, type Response } from "express";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import type { WorldCategory } from "../types/domain.js";

export const worldCategoriesRouter = Router();

// Matches the frontend's own NewCategoryInput slugification: lowercase,
// non-alphanumeric runs collapsed to a single hyphen, no leading/trailing
// hyphens — so a category created here and one created on the frontend
// from the same name land on the same key. Exported for reuse by the MCP
// create_world_category tool (src/mcp/tools.ts) so both write paths derive
// keys identically.
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function titleize(key: string): string {
  return key
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

// Merges explicit world_categories rows with any entry_type already in
// real use on this book's codex_entries that doesn't have a category row
// yet (excluding 'character'). This means a book's existing nation/
// culture/magic/faction/religion/history entries (real production data
// predating this table) show up as categories immediately, with a
// derived display name, rather than being invisible until someone
// manually backfills a matching row. Exported for reuse by the MCP
// list_world_categories tool (src/mcp/tools.ts).
export async function listWorldCategories(bookId: string): Promise<WorldCategory[]> {
  const supabase = getSupabaseClient();
  const { data: categories, error: categoriesError } = await supabase
    .from("world_categories")
    .select("*")
    .eq("book_id", bookId);

  if (categoriesError) {
    throw new Error(`Failed to list world categories: ${categoriesError.message}`);
  }

  const { data: entryTypeRows, error: entryTypesError } = await supabase
    .from("codex_entries")
    .select("entry_type")
    .eq("book_id", bookId)
    .neq("entry_type", "character");

  if (entryTypesError) {
    throw new Error(`Failed to list categories currently in use: ${entryTypesError.message}`);
  }

  const knownKeys = new Set((categories ?? []).map((c) => c.key));
  const derivedKeys = new Set(
    (entryTypeRows ?? []).map((row) => row.entry_type as string).filter((key) => !knownKeys.has(key))
  );

  const derived: WorldCategory[] = Array.from(derivedKeys).map((key) => ({
    id: "",
    book_id: bookId,
    key,
    name: titleize(key),
    description: null,
    color: null,
    icon: null,
    created_at: "",
    is_derived: true,
  }));

  return [...(categories ?? []), ...derived].sort((a, b) => a.name.localeCompare(b.name));
}

// GET /api/v1/world-categories?bookId=
worldCategoriesRouter.get("/world-categories", async (req: Request, res: Response) => {
  const bookId = req.query.bookId;
  if (typeof bookId !== "string" || bookId.trim() === "") {
    res.status(400).json({ error: "bookId query parameter is required." });
    return;
  }

  try {
    const categories = await listWorldCategories(bookId);
    res.json({ categories });
  } catch (error) {
    console.error("list world categories failed:", error);
    res.status(502).json({ error: "Failed to list world categories." });
  }
});

// POST /api/v1/world-categories — { bookId, name, description?, color?,
// icon?, key? }. key is auto-slugified from name when omitted, matching
// the frontend's own category-creation flow.
worldCategoriesRouter.post("/world-categories", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    res.status(400).json({ error: "bookId is required and must be a non-empty string." });
    return;
  }
  if (typeof body.name !== "string" || body.name.trim() === "") {
    res.status(400).json({ error: "name is required and must be a non-empty string." });
    return;
  }
  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
    res.status(400).json({ error: "description must be a string." });
    return;
  }
  if (body.color !== undefined && body.color !== null && typeof body.color !== "string") {
    res.status(400).json({ error: "color must be a string." });
    return;
  }
  if (body.icon !== undefined && body.icon !== null && typeof body.icon !== "string") {
    res.status(400).json({ error: "icon must be a string." });
    return;
  }
  if (body.key !== undefined && (typeof body.key !== "string" || body.key.trim() === "")) {
    res.status(400).json({ error: "key must be a non-empty string when provided." });
    return;
  }

  const key = typeof body.key === "string" ? slugify(body.key) : slugify(body.name);
  if (key === "") {
    res.status(400).json({ error: "Could not derive a valid category key from name — provide one explicitly." });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("world_categories")
    .insert({
      book_id: body.bookId,
      key,
      name: body.name,
      description: body.description ?? null,
      color: body.color ?? null,
      icon: body.icon ?? null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      res.status(409).json({ error: `A category with key "${key}" already exists for this book.` });
      return;
    }
    console.error("world category creation failed:", error);
    res.status(502).json({ error: "Failed to create world category." });
    return;
  }
  res.status(201).json({ category: data });
});

// PATCH /api/v1/world-categories/:id — name/description/color/icon only.
// key is immutable once created: existing codex_entries.entry_type values
// reference it by string, and renaming the key would silently orphan them.
worldCategoriesRouter.patch("/world-categories/:id", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const payload: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim() === "") {
      res.status(400).json({ error: "name must be a non-empty string." });
      return;
    }
    payload.name = body.name;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      res.status(400).json({ error: "description must be a string." });
      return;
    }
    payload.description = body.description;
  }
  if (body.color !== undefined) {
    if (body.color !== null && typeof body.color !== "string") {
      res.status(400).json({ error: "color must be a string." });
      return;
    }
    payload.color = body.color;
  }
  if (body.icon !== undefined) {
    if (body.icon !== null && typeof body.icon !== "string") {
      res.status(400).json({ error: "icon must be a string." });
      return;
    }
    payload.icon = body.icon;
  }
  if (Object.keys(payload).length === 0) {
    res.status(400).json({ error: "No updatable fields were provided." });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("world_categories")
    .update(payload)
    .eq("id", req.params.id)
    .select("*")
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to update world category." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No world category found with id ${req.params.id}.` });
    return;
  }
  res.json({ category: data });
});

// DELETE /api/v1/world-categories/:id — deletes only the category's
// metadata row. codex_entries rows using this key as their entry_type keep
// it as a plain string — they just fall back to a derived display (see
// GET above) instead of the custom name/color/icon. Never cascades into
// Codex data as an unreviewed side effect, same principle as everywhere
// else in this schema.
worldCategoriesRouter.delete("/world-categories/:id", async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("world_categories")
    .delete()
    .eq("id", req.params.id)
    .select("id")
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to delete world category." });
    return;
  }
  if (!data) {
    res.status(404).json({ error: `No world category found with id ${req.params.id}.` });
    return;
  }
  res.status(204).end();
});
