export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  content: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface NormalizedMessage {
  type: "assistant" | "user" | "result";
  content: ContentBlock[];
  usage?: UsageData;
}

export interface UsageData {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface ProviderConfig {
  systemPrompt: string;
  model: string;
  mcpServers: Record<string, unknown>;
  allowedTools: string[];
  disallowedTools?: string[];
  abortController?: AbortController;
  permissionMode?: string;
  settingSources?: string[];
}

export interface Provider {
  name: string;
  defaultModel: string;
  execute(prompt: string, config: ProviderConfig): AsyncIterable<NormalizedMessage>;
}
