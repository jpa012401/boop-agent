/**
 * Local HTTP MCP server that exposes Boop's tool handlers to Codex via the
 * MCP Streamable HTTP transport. Codex cannot mount in-process MCP servers
 * like the Claude Agent SDK can, so it connects to this external HTTP endpoint.
 *
 * Listens on 127.0.0.1:<port> (default 3456) and serves MCP on /mcp.
 */

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
    if (existing.has(tool.name)) continue; // skip duplicates
    _registeredTools.push(tool);
    existing.add(tool.name);
  }
}

/**
 * Create a fresh McpServer with all registered tools mounted. A new instance
 * is needed per HTTP request because McpServer.connect() binds to a single
 * transport and cannot be reused across connections.
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
 *
 * @param port - TCP port to listen on (default: 3456).
 * @returns A Promise that resolves once the server is listening.
 */
export async function startCodexMcpServer(port = 3456): Promise<void> {
  if (_httpServer) {
    // Already running — nothing to do.
    return;
  }

  const httpServer = http.createServer(async (req, res) => {
    // Only handle requests to /mcp.
    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    // Each request gets a fresh McpServer + transport pair. The MCP SDK binds
    // a server to exactly one transport via connect(), so sharing an instance
    // across concurrent requests causes "Already connected" errors.
    const mcpServer = _createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[codex-mcp-server] Error handling MCP request:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    } finally {
      await mcpServer.close();
    }
  });

  // Codex tool calls can involve vector search, embeddings, and sub-agent
  // spawning which may take well over the default 2-minute Node timeout.
  // Set a generous timeout so long-running tools don't get killed mid-flight.
  httpServer.timeout = 5 * 60 * 1000; // 5 minutes
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
 * Stop the MCP HTTP server (graceful close, waits for in-flight requests).
 */
export async function stopCodexMcpServer(): Promise<void> {
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

/**
 * Mount a single ToolDefinition onto a running McpServer instance.
 *
 * The MCP SDK expects a Zod raw shape (Record<string, ZodType>) or a
 * z.object() schema — plain JSON Schema objects are NOT accepted.
 */
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
