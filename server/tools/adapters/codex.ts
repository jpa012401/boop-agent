import type { ToolDefinition } from "../../providers/codex-mcp-server.js";
import type { ToolSpec, ToolContext } from "../types.js";

export function toolSpecsToCodexDefs(
  specs: ToolSpec[],
  ctx: ToolContext,
): ToolDefinition[] {
  return specs.map((s) => ({
    name: s.name,
    description: s.description,
    schema: s.schema,
    handler: async (args) => s.handler(args, ctx),
  }));
}
