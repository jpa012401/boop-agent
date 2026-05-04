import { z } from "zod";
import { availableIntegrations, spawnExecutionAgent } from "../execution-agent.js";
import type { ToolSpec } from "./types.js";

/**
 * makeSpawnTools — returns a ToolSpec array with `spawn_agent`.
 *
 * This is a function rather than a const so the tool description can embed
 * the current list of available integrations at call time.
 */
export function makeSpawnTools(): ToolSpec[] {
  const integrations = availableIntegrations();

  return [
    {
      name: "spawn_agent",
      description:
        "Spawn a focused sub-agent to do real work using external tools. Returns the agent's final answer. Use for anything requiring lookups, drafting, or actions in the user's integrations.",
      schema: {
        task: z
          .string()
          .describe("Crisp task description — what to find/draft/do, not the raw user message."),
        integrations: z
          .array(z.string())
          .describe(
            `Which integrations to give the agent. Available: ${integrations.join(", ") || "(none)"}`,
          ),
        name: z.string().optional().describe("Short label for the agent."),
      },
      async handler(args, ctx) {
        const res = await spawnExecutionAgent({
          task: args.task as string,
          integrations: args.integrations as string[],
          conversationId: ctx.conversationId,
          name: args.name as string | undefined,
          automationId: ctx.automationId,
        });
        return `[agent ${res.agentId} ${res.status}]\n\n${res.result}`;
      },
    },
  ];
}
