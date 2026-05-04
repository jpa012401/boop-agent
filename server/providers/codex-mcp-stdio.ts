/**
 * Standalone MCP stdio server for Codex.
 *
 * Codex spawns this as a subprocess and communicates over stdin/stdout.
 * Much faster than HTTP — no TCP overhead, no OAuth probes, no session mgmt.
 *
 * Usage in .codex/config.toml:
 *   [mcp_servers.boop-tools]
 *   type = "stdio"
 *   command = "tsx"
 *   args = ["server/providers/codex-mcp-stdio.ts"]
 *
 * This script loads env, registers all Boop tools, and starts the MCP server.
 */

import "../env-setup.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { interactionTools, executionTools, makeSpawnTools, defaultConversationId } from "../tools/index.js";
import { loadIntegrations } from "../integrations/registry.js";
import type { ToolSpec, ToolContext } from "../tools/types.js";

async function main() {
  // Load integrations so spawn_agent knows what's available.
  await loadIntegrations();

  const ctx: ToolContext = { conversationId: defaultConversationId() };

  const allTools: ToolSpec[] = [
    ...interactionTools,
    ...makeSpawnTools(),
    ...executionTools,
  ];

  const server = new McpServer({
    name: "boop-tools",
    version: "1.0.0",
  });

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
      },
      async (args: Record<string, unknown>) => {
        const start = Date.now();
        try {
          const result = await tool.handler(args, ctx);
          const elapsed = Date.now() - start;
          if (elapsed > 5000) {
            console.error(`[boop-mcp] slow: ${tool.name} ${(elapsed / 1000).toFixed(1)}s`);
          }
          const text =
            typeof result === "string" ? result : JSON.stringify(result, null, 2);
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          const elapsed = Date.now() - start;
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[boop-mcp] ${tool.name} failed (${(elapsed / 1000).toFixed(1)}s): ${message}`);
          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[boop-mcp] stdio server ready (${allTools.length} tools)`);
}

main().catch((err) => {
  console.error("[boop-mcp] fatal:", err);
  process.exit(1);
});
