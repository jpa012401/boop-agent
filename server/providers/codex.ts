import { Codex } from "@openai/codex-sdk";
import type {
  AgentMessageItem,
  McpToolCallItem,
  TurnCompletedEvent,
} from "@openai/codex-sdk";
import type {
  Provider,
  ProviderConfig,
  NormalizedMessage,
  ContentBlock,
  UsageData,
} from "./types.js";

const CODEX_COST_PER_1K_INPUT = parseFloat(
  process.env.CODEX_COST_PER_1K_INPUT ?? "0.01"
);
const CODEX_COST_PER_1K_OUTPUT = parseFloat(
  process.env.CODEX_COST_PER_1K_OUTPUT ?? "0.03"
);

export const codexProvider: Provider = {
  name: "codex",
  defaultModel: "gpt-5.5",

  async *execute(
    prompt: string,
    config: ProviderConfig
  ): AsyncIterable<NormalizedMessage> {
    const codex = new Codex({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const thread = codex.startThread({
      model: config.model,
      approvalPolicy: "never",
    });

    const fullPrompt = config.systemPrompt
      ? `${config.systemPrompt}\n\n${prompt}`
      : prompt;

    const { events } = await thread.runStreamed(fullPrompt, {
      signal: config.abortController?.signal,
    });

    let turnUsage: TurnCompletedEvent["usage"] | null = null;

    for await (const event of events) {
      if (event.type === "item.completed") {
        const item = event.item;

        if (item.type === "agent_message") {
          const agentItem = item as AgentMessageItem;
          if (agentItem.text) {
            const content: ContentBlock[] = [
              { type: "text", text: agentItem.text },
            ];
            yield { type: "assistant", content };
          }
        } else if (item.type === "mcp_tool_call") {
          const toolItem = item as McpToolCallItem;

          // Emit tool use as an assistant message
          const toolUseContent: ContentBlock[] = [
            {
              type: "tool_use",
              name: `${toolItem.server}__${toolItem.tool}`,
              input: toolItem.arguments,
            },
          ];
          yield { type: "assistant", content: toolUseContent };

          // Emit tool result as a user message
          if (toolItem.status === "completed" && toolItem.result) {
            const resultText = toolItem.result.content
              .map((block) =>
                block.type === "text" ? ((block as { type: "text"; text: string }).text ?? "") : ""
              )
              .join("");
            const toolResultContent: ContentBlock[] = [
              { type: "tool_result", content: resultText },
            ];
            yield { type: "user", content: toolResultContent };
          } else if (toolItem.status === "failed" && toolItem.error) {
            const toolResultContent: ContentBlock[] = [
              { type: "tool_result", content: `Error: ${toolItem.error.message}` },
            ];
            yield { type: "user", content: toolResultContent };
          }
        }
      } else if (event.type === "turn.completed") {
        turnUsage = event.usage;
      } else if (event.type === "turn.failed") {
        throw new Error(`Codex turn failed: ${event.error.message}`);
      } else if (event.type === "error") {
        throw new Error(`Codex stream error: ${event.message}`);
      }
    }

    const usage = buildUsage(config.model, turnUsage);
    yield { type: "result", content: [], usage };
  },
};

function buildUsage(
  model: string,
  turnUsage: TurnCompletedEvent["usage"] | null
): UsageData {
  const inputTokens = turnUsage?.input_tokens ?? 0;
  const outputTokens = turnUsage?.output_tokens ?? 0;
  const cacheReadTokens = turnUsage?.cached_input_tokens ?? 0;

  const costUsd =
    (inputTokens / 1000) * CODEX_COST_PER_1K_INPUT +
    (outputTokens / 1000) * CODEX_COST_PER_1K_OUTPUT;

  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    costUsd,
  };
}
