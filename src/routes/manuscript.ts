import { Router, type Request, type Response } from "express";
import { ingestManuscriptText, bulkIngestManuscript } from "../services/manuscriptIngest.js";

export const manuscriptRouter = Router();

function validateBulkImportBody(body: Record<string, unknown>): string | null {
  if (typeof body.userId !== "string" || body.userId.trim() === "") {
    return "userId is required and must be a non-empty string.";
  }
  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    return "bookId is required and must be a non-empty string.";
  }
  if (typeof body.rawText !== "string" || body.rawText.trim() === "") {
    return "rawText is required and must be a non-empty string.";
  }
  return null;
}

function validateIngestBody(body: Record<string, unknown>): string | null {
  if (typeof body.userId !== "string" || body.userId.trim() === "") {
    return "userId is required and must be a non-empty string.";
  }
  if (typeof body.bookId !== "string" || body.bookId.trim() === "") {
    return "bookId is required and must be a non-empty string.";
  }
  if (typeof body.chapterNumber !== "number" || !Number.isInteger(body.chapterNumber) || body.chapterNumber < 1) {
    return "chapterNumber is required and must be a positive integer.";
  }
  if (typeof body.rawText !== "string" || body.rawText.trim() === "") {
    return "rawText is required and must be a non-empty string.";
  }
  if (
    body.startingSceneOrder !== undefined &&
    (typeof body.startingSceneOrder !== "number" ||
      !Number.isInteger(body.startingSceneOrder) ||
      body.startingSceneOrder < 1)
  ) {
    return "startingSceneOrder must be a positive integer when provided.";
  }
  return null;
}

// Saves a finished scene/chapter into the Deep Past memory store: chunks
// the text, embeds each chunk, and stores it so future generate-prose
// calls can retrieve it via Layer 3. This is what keeps Hanami's sense of
// "the whole manuscript" up to date as the writer actually writes.
manuscriptRouter.post("/manuscript/chunks", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const validationError = validateIngestBody(body);

  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  try {
    const chunks = await ingestManuscriptText({
      userId: body.userId as string,
      bookId: body.bookId as string,
      chapterNumber: body.chapterNumber as number,
      rawText: body.rawText as string,
      ...(body.startingSceneOrder !== undefined
        ? { startingSceneOrder: body.startingSceneOrder as number }
        : {}),
    });

    res.status(201).json({ chunks });
  } catch (error) {
    console.error("manuscript ingestion failed:", error);
    res.status(502).json({ error: "Failed to save manuscript text. Please try again." });
  }
});

// Imports a whole manuscript in one call: detects "Chapter N" header lines
// in rawText, splits it into per-chapter blocks, and runs each through the
// same chunk/embed/store pipeline as /manuscript/chunks. Chapters are
// processed sequentially in this one request — fine for testing and
// moderate-length manuscripts, but a genuinely long novel (500+ chunks)
// could take a couple of minutes; see bulkIngestManuscript's comment on
// moving this to a background job if that becomes a real timeout risk.
manuscriptRouter.post("/manuscript/bulk-import", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const validationError = validateBulkImportBody(body);

  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  try {
    const chapters = await bulkIngestManuscript({
      userId: body.userId as string,
      bookId: body.bookId as string,
      rawText: body.rawText as string,
    });

    res.status(201).json({
      chaptersImported: chapters.length,
      totalChunksStored: chapters.reduce((sum, c) => sum + c.chunksStored, 0),
      chapters,
    });
  } catch (error) {
    console.error("bulk manuscript import failed:", error);
    res.status(502).json({ error: "Failed to bulk import manuscript. Please try again." });
  }
});
