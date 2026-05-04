/**
 * Local HTTP MCP server that exposes Boop's tool handlers to Codex via the
 * MCP Streamable HTTP transport. Codex cannot mount in-process MCP servers
 * like the Claude Agent SDK can, so it connects to this external HTTP endpoint.
 *
 * Listens on 127.0.0.1:<port> (default 3456) and serves MCP on /mcp.
 */

import http from "node:http";
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
  /** JSON Schema object describing the tool's input parameters. */
  schema: Record<string, unknown>;
  /** Implementation that receives validated arguments and returns a result. */
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let _mcpServer: McpServer | null = null;
let _httpServer: http.Server | null = null;
const _registeredTools: ToolDefinition[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register tools that should be exposed over MCP. Call this before
 * `startCodexMcpServer()` — or after, in which case the running server's
 * McpServer will be updated immediately.
 */
export function registerToolsForCodex(tools: ToolDefinition[]): void {
  _registeredTools.push(...tools);

  // If the server is already running, mount any newly added tools right away.
  if (_mcpServer) {
    for (const tool of tools) {
      _mountTool(_mcpServer, tool);
    }
  }
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

  const mcpServer = new McpServer({
    name: "boop-codex-mcp",
    version: "1.0.0",
  });

  // Mount every tool that was registered before start.
  for (const tool of _registeredTools) {
    _mountTool(mcpServer, tool);
  }

  _mcpServer = mcpServer;

  const httpServer = http.createServer(async (req, res) => {
    // Only handle requests to /mcp.
    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    // The MCP Streamable HTTP transport is stateless here (no session IDs)
    // so each request gets its own transport instance connected to the shared
    // McpServer.
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
    }
  });

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
  const closeMcp = _mcpServer?.close();
  _mcpServer = null;

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

  await closeMcp;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mount a single ToolDefinition onto a running McpServer instance.
 *
 * We use the `registerTool` API (preferred over the deprecated `tool()`)
 * and pass the JSON Schema object directly as `inputSchema`. The MCP SDK
 * accepts raw JSON Schema objects when the AnySchema overload is used.
 */
function _mountTool(server: McpServer, tool: ToolDefinition): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      // The SDK accepts a plain JSON Schema object as `inputSchema`.
      inputSchema: tool.schema as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    },
    async (args: Record<string, unknown>) => {
      try {
        const result = await tool.handler(args);
        const text =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
