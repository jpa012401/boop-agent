import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Provider, ProviderConfig, NormalizedMessage, ContentBlock, UsageData } from "./types.js";

export const claudeProvider: Provider = {
  name: "claude",
  defaultModel: "claude-sonnet-4-6",

  async *execute(prompt: string, config: ProviderConfig): AsyncIterable<NormalizedMessage> {
    const mcpServers = config.mcpServers as Record<string, McpSdkServerConfigWithInstance>;

    for await (const msg of query({
      prompt,
      options: {
        systemPrompt: config.systemPrompt,
        model: config.model,
        mcpServers,
        allowedTools: config.allowedTools,
        disallowedTools: config.disallowedTools,
        permissionMode: config.permissionMode as "bypassPermissions" | undefined,
        settingSources: config.settingSources as ("project" | "user")[] | undefined,
        abortController: config.abortController,
      },
    })) {
      if (msg.type === "assistant") {
        const content: ContentBlock[] = msg.message.content.map((block: any) => {
          if (block.type === "text") return { type: "text" as const, text: block.text };
          if (block.type === "tool_use") return { type: "tool_use" as const, name: block.name, input: block.input };
          return { type: "text" as const, text: "" };
        }).filter((b: ContentBlock) => b.type !== "text" || (b as any).text !== "");

        yield { type: "assistant", content };
      } else if (msg.type === "user") {
        const content: ContentBlock[] = [];
        for (const block of msg.message.content) {
          if ((block as any).type === "tool_result") {
            const text = Array.isArray((block as any).content)
              ? (block as any).content
                  .map((c: any) => (c.type === "text" ? (c.text ?? "") : ""))
                  .join("")
              : String((block as any).content ?? "");
            content.push({ type: "tool_result", content: text });
          }
        }
        if (content.length) yield { type: "user", content };
      } else if (msg.type === "result") {
        const usage = extractClaudeUsage(msg, config.model);
        yield { type: "result", content: [], usage };
      }
    }
  },
};

function extractClaudeUsage(msg: any, requestedModel: string): UsageData {
  const modelUsage: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }> = msg.modelUsage ?? {};

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (const u of Object.values(modelUsage)) {
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
    cacheReadTokens += u.cacheReadInputTokens ?? 0;
    cacheCreationTokens += u.cacheCreationInputTokens ?? 0;
  }

  return {
    model: requestedModel,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd: msg.total_cost_usd ?? 0,
  };
}
