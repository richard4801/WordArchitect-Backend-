import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerWordArchitectTools } from "../mcp/tools.js";

export const mcpRouter = Router();

// Single shared-secret check on every MCP request. This server exposes
// read AND write access to a writer's Codex/manuscript database to
// whatever client connects (e.g. Claude via a custom connector reachable
// over the public internet) — unlike the rest of this API, which has no
// auth at all, this surface can't be left open. Not full OAuth (overkill
// for a single-user tool at this stage), just enough to keep it from
// being wide open to anyone who finds the URL.
function requireMcpAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MCP_API_KEY;
  if (!expected) {
    res.status(500).json({ error: "MCP_API_KEY is not configured on the server." });
    return;
  }

  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (token !== expected) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }

  next();
}

// One MCP server + transport pair per session, kept in memory. Fine for a
// single Render instance with no horizontal scaling — if that ever
// changes, session state would need to move to a shared store.
const transports: Record<string, StreamableHTTPServerTransport> = {};

function createServer(): McpServer {
  const server = new McpServer({ name: "wordarchitect", version: "1.0.0" });
  registerWordArchitectTools(server);
  return server;
}

mcpRouter.post("/mcp", requireMcpAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports[newSessionId] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete transports[sid];
      };

      const server = createServer();
      // exactOptionalPropertyTypes flags this: the SDK's Transport interface
      // declares `onclose?: () => void` (optional) but this class's own
      // getter returns `(() => void) | undefined` — a real type mismatch
      // only under this tsconfig flag, not an actual runtime issue.
      await server.connect(transport as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request handling failed:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET handles the standalone SSE stream a session uses for server-initiated
// notifications; DELETE lets a client explicitly end its session.
async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

mcpRouter.get("/mcp", requireMcpAuth, handleSessionRequest);
mcpRouter.delete("/mcp", requireMcpAuth, handleSessionRequest);
