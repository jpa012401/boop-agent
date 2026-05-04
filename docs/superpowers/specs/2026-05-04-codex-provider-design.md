# Codex App-Server as Alternative Provider

**Date:** 2026-05-04  
**Status:** Draft  
**Branch:** `feat/codex-provider`

## Summary

Add support for OpenAI's Codex app-server (`@openai/codex-sdk`) as an alternative LLM execution engine alongside the existing Anthropic Claude Agent SDK. A single env var (`BOOP_PROVIDER=claude|codex`) toggles the entire system between providers at startup. Both the interaction agent (dispatcher) and execution agent use the selected provider.

## Motivation

1. **Capability comparison** — evaluate which provider performs better on Boop's agent workloads (dispatching, tool use, research, integrations).
2. **Resilience** — if one provider's API is degraded, restart with the other to maintain availability.

## Architecture

### Provider Abstraction Layer

A new `server/providers/` directory introduces a common interface. Both `interaction-agent.ts` and `execution-agent.ts` call through `getProvider().execute()` instead of importing `query()` directly.

```
interaction-agent.ts / execution-agent.ts
        │
        ▼
server/providers/index.ts  → getProvider()
        │
   ┌────┴────┐
   ▼         ▼
claude.ts   codex.ts
(query())   (Codex SDK thread.runStreamed())
```

### Provider Interface

```typescript
// server/providers/types.ts

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
  // Present only on type === "result"
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
  mcpServers: Record<string, McpServerConfig>;
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
```

### Claude Provider (`server/providers/claude.ts`)

Thin wrapper around the existing `query()` from `@anthropic-ai/claude-agent-sdk`. Maps SDK messages to `NormalizedMessage` with minimal transformation — the shapes are nearly identical. MCP servers pass through directly since the SDK natively supports them.

### Codex Provider (`server/providers/codex.ts`)

Uses `@openai/codex-sdk`:

1. Creates a `Codex` instance at module load.
2. Each agent run starts a new thread via `codex.startThread()`.
3. Calls `thread.runStreamed()` with the prompt (system prompt prepended or passed as config).
4. Streams events and normalizes them to `NormalizedMessage`.
5. On turn completion, extracts usage data from the SDK's response.

### MCP Tool Server (`server/providers/codex-mcp-server.ts`)

Codex has native shell/file tools but doesn't mount in-process MCP servers the way the Claude Agent SDK does. The Claude SDK calls tool handler functions directly in-process; Codex expects to connect to **external MCP servers** over stdio or HTTP.

**Solution:** Spin up a local Streamable HTTP MCP server within the Boop Node.js process that exposes all Boop tools. Codex connects to it via `.codex/config.toml`.

**Mechanism:**

1. At startup (when `BOOP_PROVIDER=codex`), start a local HTTP server on a configurable port (default `localhost:3456`).
2. The server implements the MCP Streamable HTTP transport protocol.
3. It registers all the same tool handlers that Claude SDK uses (memory, spawn, automations, drafts, self, Composio integrations).
4. A `.codex/config.toml` file in the project root is generated/updated at startup, pointing Codex at this local server.
5. The server runs for the lifetime of the process; no per-run cleanup needed.

**Generated `.codex/config.toml`:**

```toml
[mcp_servers.boop-tools]
type = "http"
url = "http://localhost:3456/mcp"
```

**How it works at runtime:**

```
Codex SDK (thread.run)
    │
    │  model decides to call "recall" tool
    ▼
Codex app-server connects to http://localhost:3456/mcp
    │
    ▼
codex-mcp-server.ts (in Boop's Node process)
    │  routes tool call to the same handler functions
    ▼
Convex / Composio / etc.
```

**Key details:**
- Uses the `@modelcontextprotocol/sdk` package (already the standard MCP server library) to implement the HTTP transport.
- Tool handlers are the same functions used by Claude SDK's `createSdkMcpServer()` — just re-registered on the HTTP server.
- The server dynamically registers integration tools (Composio) based on what's loaded in the registry.
- Per-run context (like `conversationId`) is passed via tool input parameters, not server state.
- The `.codex/config.toml` file lives in the project root at `server/providers/.codex/config.toml` (gitignored).

### Model Configuration

`server/runtime-config.ts` becomes provider-aware:

```typescript
export const PROVIDER_MODELS: Record<string, Set<string>> = {
  claude: new Set([
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ]),
  codex: new Set([
    "o3",
    "o4-mini",
    "gpt-4.1",
    "codex-mini",
  ]),
};

export const PROVIDER_MODEL_ALIASES: Record<string, Record<string, string>> = {
  claude: {
    opus: "claude-opus-4-7",
    "opus 4.7": "claude-opus-4-7",
    sonnet: "claude-sonnet-4-6",
    "sonnet 4.6": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5-20251001",
    "haiku 4.5": "claude-haiku-4-5-20251001",
  },
  codex: {
    o3: "o3",
    "o4-mini": "o4-mini",
    "o4 mini": "o4-mini",
    "gpt-4.1": "gpt-4.1",
    "gpt 4.1": "gpt-4.1",
    "codex-mini": "codex-mini",
    "codex mini": "codex-mini",
  },
};

export const PROVIDER_DEFAULTS: Record<string, string> = {
  claude: "claude-sonnet-4-6",
  codex: "o3",
};
```

- `resolveModelInput(input)` checks the active provider's model set and aliases.
- `getRuntimeModel()` falls back to `PROVIDER_DEFAULTS[provider]` if the env/settings value is invalid for the active provider.
- `getProvider()` is read from `process.env.BOOP_PROVIDER` (default: `"claude"`).

### Usage Tracking

The existing `UsageTotals` interface remains unchanged. Each provider is responsible for returning a `UsageData` object in its `result` message:

- **Claude:** Extracted from `msg.modelUsage` as today (via `aggregateUsageFromResult`).
- **Codex:** Parsed from the SDK's turn completion event. The Codex SDK returns `inputTokens` and `outputTokens`. Cost is estimated using hardcoded rates (configurable via `CODEX_COST_PER_1K_INPUT` / `CODEX_COST_PER_1K_OUTPUT` env vars). Cache tokens set to 0 (Codex doesn't expose cache metrics the same way).

### Environment Variables

```env
# .env.local

# Provider selection (restart required to switch)
BOOP_PROVIDER=claude          # "claude" | "codex"

# Model (must be valid for the active provider)
BOOP_MODEL=claude-sonnet-4-6  # or "o3" when provider=codex

# Required when BOOP_PROVIDER=codex
OPENAI_API_KEY=sk-...

# Optional: override Codex cost estimation
CODEX_COST_PER_1K_INPUT=0.01
CODEX_COST_PER_1K_OUTPUT=0.03
```

## Files Changed/Created

| File | Action | Description |
|------|--------|-------------|
| `server/providers/types.ts` | Create | Shared `Provider` interface and `NormalizedMessage` types |
| `server/providers/index.ts` | Create | `getProvider()` factory, reads `BOOP_PROVIDER` env var |
| `server/providers/claude.ts` | Create | Wraps `query()` from Claude Agent SDK |
| `server/providers/codex.ts` | Create | Wraps `@openai/codex-sdk` thread/run |
| `server/providers/codex-mcp-server.ts` | Create | Local HTTP MCP server exposing Boop tools to Codex |
| `.codex/config.toml` | Create (gitignored) | Points Codex at local MCP server |
| `server/execution-agent.ts` | Modify | Replace `import { query }` with `getProvider().execute()` |
| `server/interaction-agent.ts` | Modify | Replace `import { query }` with `getProvider().execute()` |
| `server/usage.ts` | Modify | Move Claude-specific parsing into `claude.ts`; keep interface |
| `server/runtime-config.ts` | Modify | Provider-aware model sets, aliases, defaults |
| `package.json` | Modify | Add `@openai/codex-sdk` and `@modelcontextprotocol/sdk` dependencies |

## Constraints & Decisions

1. **No hot-switching** — Provider is read at startup. Restart to change. This keeps the system simple and avoids mid-conversation provider mismatches.
2. **MCP over HTTP** — Codex connects to Boop's tools via a local HTTP MCP server running in the same Node.js process. This uses the standard MCP Streamable HTTP transport. The same tool handler functions are shared between both providers — only the transport differs.
3. **Codex threading** — Each agent run (interaction turn or execution task) gets a fresh thread. We don't reuse Codex threads across Boop conversation turns since the conversation history is managed by Boop's own Convex-backed system.
4. **Feature parity is not a goal for v1** — Some Claude SDK features (prompt caching, `settingSources`, skill loading) won't have Codex equivalents. The Codex provider skips these gracefully.
5. **Codex model list may need updating** — The model set is based on current Codex availability. New models should be added to `PROVIDER_MODELS.codex` as they become available.

## Testing Strategy

1. **Unit tests** — Test each provider in isolation with mocked SDK responses.
2. **Integration test** — A script that sends a simple prompt through each provider and verifies structured output.
3. **Manual validation** — Switch to `BOOP_PROVIDER=codex`, send messages via Telegram, verify dispatching + execution works end-to-end.

## Out of Scope

- Automatic failover (provider switch on error without restart)
- A/B testing framework (running both providers simultaneously)
- Runtime provider switching via `set_model` tool
- Codex-specific features (worktrees, parallel threads) beyond basic execution
