import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { generateProseRouter } from "./routes/generateProse.js";
import { codexRouter } from "./routes/codex.js";
import { manuscriptRouter } from "./routes/manuscript.js";
import { mcpRouter } from "./routes/mcp.js";
import { askRouter } from "./routes/ask.js";
import { bannedTermsRouter } from "./routes/bannedTerms.js";
import { booksRouter } from "./routes/books.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
// Default 100kb is too small for a full manuscript chapter pasted into
// POST /api/v1/manuscript/chunks; raised to comfortably fit tens of
// thousands of words in one ingestion call.
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Manual test harness (public/index.html) for exercising the Codex,
// manuscript ingestion, and /generate-prose endpoints without a frontend.
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/v1", generateProseRouter);
app.use("/api/v1", codexRouter);
app.use("/api/v1", manuscriptRouter);
app.use("/api/v1", askRouter);
app.use("/api/v1", bannedTermsRouter);
app.use("/api/v1", booksRouter);
app.use(mcpRouter);

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// Catches malformed JSON from express.json() and any error thrown
// synchronously by route handlers, returning clean JSON instead of
// Express's default HTML error page.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "Malformed JSON in request body." });
    return;
  }

  console.error("Unhandled error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error." });
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 4000;

app.listen(port, () => {
  console.log(`WordArchitect backend listening on port ${port}`);
});
