import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { ToolSpec, ToolContext } from "../types.js";

export function toolSpecsToClaudeMcp(
  name: string,
  version: string,
  specs: ToolSpec[],
  ctx: ToolContext,
) {
  return createSdkMcpServer({
    name,
    version,
    tools: specs.map((s) =>
      tool(s.name, s.description, s.schema, async (args) => {
        const text = await s.handler(args as Record<string, unknown>, ctx);
        return { content: [{ type: "text" as const, text }] };
      }),
    ),
  });
}
