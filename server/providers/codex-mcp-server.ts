/**
 * Local HTTP MCP server that exposes Boop's tool handlers to Codex via the
 * MCP Streamable HTTP transport. Codex cannot mount in-process MCP servers
 * like the Claude Agent SDK can, so it connects to this external HTTP endpoint.
 *
 * Uses session-based transport: Codex's initialize request creates a session,
 * and subsequent requests (tool calls, polling) are routed to the same
 * McpServer instance via the Mcp-Session-Id header.
 */

import crypto from "node:crypto";
import http from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  /** Unique tool name (must match what the LLM calls). */
  name: string;
  /** Human-readable description sent to the LLM. */
  description: string;
  /** Zod raw shape describing the tool's input parameters. E.g. { query: z.string() } */
  schema: Record<string, z.ZodTypeAny>;
  /** Implementation that receives validated arguments and returns a result. */
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let _httpServer: http.Server | null = null;
const _registeredTools: ToolDefinition[] = [];

/** Active sessions: sessionId → { server, transport } */
const _sessions = new Map<
  string,
  { server: McpServer; transport: StreamableHTTPServerTransport; createdAt: number }
>();

// Clean up stale sessions every 5 minutes (sessions older than 30 min).
const SESSION_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of _sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      session.server.close().catch(() => {});
      _sessions.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register tools that should be exposed over MCP. Call this before
 * `startCodexMcpServer()`.
 */
export function registerToolsForCodex(tools: ToolDefinition[]): void {
  const existing = new Set(_registeredTools.map((t) => t.name));
  for (const tool of tools) {
    if (existing.has(tool.name)) continue;
    _registeredTools.push(tool);
    existing.add(tool.name);
  }
}

/**
 * Create a fresh McpServer with all registered tools mounted.
 */
function _createMcpServer(): McpServer {
  const server = new McpServer({
    name: "boop-codex-mcp",
    version: "1.0.0",
  });
  for (const tool of _registeredTools) {
    _mountTool(server, tool);
  }
  return server;
}

/**
 * Start the MCP HTTP server.
 */
export async function startCodexMcpServer(port = 3456): Promise<void> {
  if (_httpServer) return;

  const httpServer = http.createServer(async (req, res) => {
    const method = req.method ?? "?";
    const url = req.url ?? "?";

    // Only handle requests to /mcp.
    if (url !== "/mcp") {
      // Silently 404 OAuth probes from Codex — they're expected.
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    // Check for existing session.
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && _sessions.has(sessionId)) {
      // Route to existing session's transport.
      const session = _sessions.get(sessionId)!;
      try {
        await session.transport.handleRequest(req, res);
      } catch (err) {
        console.error(`[codex-mcp-server] session ${sessionId} error:`, err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
      }
      return;
    }

    // No session — this is an initialize request. Create new session.
    const newSessionId = crypto.randomUUID();
    const mcpServer = _createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
    });

    _sessions.set(newSessionId, {
      server: mcpServer,
      transport,
      createdAt: Date.now(),
    });

    // Clean up session when transport closes.
    transport.onclose = () => {
      _sessions.delete(newSessionId);
      mcpServer.close().catch(() => {});
    };

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
      console.log(`[codex-mcp-server] new session ${newSessionId.slice(0, 8)} (${_registeredTools.length} tools)`);
    } catch (err) {
      console.error("[codex-mcp-server] init error:", err);
      _sessions.delete(newSessionId);
      await mcpServer.close().catch(() => {});
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    }
  });

  httpServer.timeout = 5 * 60 * 1000;
  httpServer.keepAliveTimeout = 5 * 60 * 1000;

  _httpServer = httpServer;

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      console.log(`[codex-mcp-server] Listening on http://127.0.0.1:${port}/mcp`);
      resolve();
    });
  });
}

/**
 * Stop the MCP HTTP server.
 */
export async function stopCodexMcpServer(): Promise<void> {
  // Close all active sessions.
  for (const [id, session] of _sessions) {
    await session.server.close().catch(() => {});
    _sessions.delete(id);
  }

  await new Promise<void>((resolve, reject) => {
    if (!_httpServer) {
      resolve();
      return;
    }
    _httpServer.close((err) => {
      _httpServer = null;
      if (err) reject(err);
      else resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _mountTool(server: McpServer, tool: ToolDefinition): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.schema,
    },
    async (args: Record<string, unknown>) => {
      const start = Date.now();
      try {
        const result = await tool.handler(args);
        const elapsed = Date.now() - start;
        if (elapsed > 5000) {
          console.warn(`[codex-mcp] slow tool: ${tool.name} took ${(elapsed / 1000).toFixed(1)}s`);
        }
        const text =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const elapsed = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[codex-mcp] tool ${tool.name} failed after ${(elapsed / 1000).toFixed(1)}s:`, message);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
