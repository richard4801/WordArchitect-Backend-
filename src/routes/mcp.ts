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
//
// Accepts the key via Authorization: Bearer header (for curl/testing) OR
// a ?key= query param — claude.ai's "Add custom connector" dialog only
// offers a URL field plus OAuth Client ID/Secret, no plain bearer-token
// field, so the query param is what actually lets this be configured
// from that UI: https://.../mcp?key=<MCP_API_KEY>.
function requireMcpAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MCP_API_KEY;
  if (!expected) {
    res.status(500).json({ error: "MCP_API_KEY is not configured on the server." });
    return;
  }

  const header = req.headers.authorization ?? "";
  const headerToken = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  const queryToken = typeof req.query.key === "string" ? req.query.key : null;
  const token = headerToken ?? queryToken;

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
    } else if (sessionId) {
      // A session ID was supplied but isn't in the in-memory map — most
      // commonly because a redeploy restarted the process and wiped it
      // (see the module-level comment on `transports` above). Per the MCP
      // Streamable HTTP spec this is a 404, not a 400: a well-behaved
      // client treats 404 on a session-bearing request as "this session
      // expired, discard it and silently re-initialize," whereas a 400
      // reads as a generic, unrecoverable error. Collapsing both into 400
      // (the previous behavior) meant a client had no way to distinguish
      // "your session is gone, just reconnect" from "something is broken,"
      // which is exactly the failure mode observed in practice: every tool
      // call failing after a redeploy, surviving even a manual connector
      // toggle, because the client had no signal telling it to reinitialize.
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
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
  if (!sessionId) {
    res.status(400).send("Missing session ID");
    return;
  }
  // Present but unrecognized (e.g. a redeploy wiped it) — 404, not 400,
  // same reasoning as the POST handler above.
  if (!transports[sessionId]) {
    res.status(404).send("Session not found");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

mcpRouter.get("/mcp", requireMcpAuth, handleSessionRequest);
mcpRouter.delete("/mcp", requireMcpAuth, handleSessionRequest);
