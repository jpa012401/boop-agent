# Codex Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@openai/codex-sdk` as an alternative LLM provider toggled via `BOOP_PROVIDER` env var.

**Architecture:** Provider abstraction layer wraps both Claude Agent SDK and Codex SDK behind a common `Provider` interface. When Codex is active, a local HTTP MCP server exposes Boop's tools so Codex can connect to them. Model configuration becomes provider-aware.

**Tech Stack:** TypeScript, `@openai/codex-sdk`, `@modelcontextprotocol/sdk` (already installed), `@anthropic-ai/claude-agent-sdk` (existing)

**Spec:** `docs/superpowers/specs/2026-05-04-codex-provider-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/providers/types.ts` | Shared types: `Provider`, `NormalizedMessage`, `UsageData`, `ProviderConfig` |
| `server/providers/index.ts` | `getProvider()` factory; reads `BOOP_PROVIDER` env var |
| `server/providers/claude.ts` | Wraps `query()` → yields `NormalizedMessage` |
| `server/providers/codex.ts` | Wraps Codex SDK `thread.runStreamed()` → yields `NormalizedMessage` |
| `server/providers/codex-mcp-server.ts` | Local HTTP MCP server exposing Boop tools to Codex |
| `server/runtime-config.ts` | Modified: provider-aware model sets/aliases/defaults |
| `server/execution-agent.ts` | Modified: use `getProvider().execute()` instead of `query()` |
| `server/interaction-agent.ts` | Modified: use `getProvider().execute()` instead of `query()` |
| `server/usage.ts` | Modified: keep interface, move Claude-specific parsing into claude provider |
| `package.json` | Modified: add `@openai/codex-sdk` |
| `.codex/config.toml` | Generated at runtime (gitignored): points Codex at local MCP server |

---

### Task 1: Install Codex SDK and Update .gitignore

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Install @openai/codex-sdk**

Run: `npm install @openai/codex-sdk`

- [ ] **Step 2: Add .codex/ to .gitignore**

Append to `.gitignore`:
```
# Codex provider config (generated at runtime)
.codex/
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: add @openai/codex-sdk dependency"
```

---

### Task 2: Provider Types

**Files:**
- Create: `server/providers/types.ts`

- [ ] **Step 1: Create the shared types file**

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
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit server/providers/types.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/providers/types.ts
git commit -m "feat(providers): add shared Provider interface and message types"
```

---

### Task 3: Claude Provider

**Files:**
- Create: `server/providers/claude.ts`

- [ ] **Step 1: Create claude.ts wrapping the existing query() call**

```typescript
// server/providers/claude.ts
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
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/providers/claude.ts
git commit -m "feat(providers): add Claude provider wrapping query()"
```

---

### Task 4: Codex MCP Server

**Files:**
- Create: `server/providers/codex-mcp-server.ts`

This is the local HTTP server that exposes Boop's tool handlers to Codex via the standard MCP Streamable HTTP transport.

- [ ] **Step 1: Create the MCP HTTP server**

```typescript
// server/providers/codex-mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { z } from "zod";

let httpServer: ReturnType<typeof createServer> | null = null;

interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, any>;
  handler: (args: any) => Promise<{ content: { type: string; text: string }[] }>;
}

let registeredTools: ToolDefinition[] = [];

export function registerToolsForCodex(tools: ToolDefinition[]): void {
  registeredTools = tools;
}

export async function startCodexMcpServer(port = 3456): Promise<void> {
  const mcp = new McpServer({ name: "boop-tools", version: "0.1.0" });

  for (const t of registeredTools) {
    mcp.tool(t.name, t.description, t.schema, async (args: any) => {
      return t.handler(args);
    });
  }

  httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/mcp" && req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServer.listen(port, "127.0.0.1", () => {
    console.log(`[codex-mcp] MCP server listening on http://127.0.0.1:${port}/mcp`);
  });
}

export async function stopCodexMcpServer(): Promise<void> {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/providers/codex-mcp-server.ts
git commit -m "feat(providers): add local HTTP MCP server for Codex tool access"
```

---

### Task 5: Codex Provider

**Files:**
- Create: `server/providers/codex.ts`

- [ ] **Step 1: Create codex.ts wrapping the Codex SDK**

```typescript
// server/providers/codex.ts
import { Codex } from "@openai/codex-sdk";
import type { Provider, ProviderConfig, NormalizedMessage, UsageData } from "./types.js";

let codexInstance: Codex | null = null;

function getCodex(): Codex {
  if (!codexInstance) {
    codexInstance = new Codex();
  }
  return codexInstance;
}

export const codexProvider: Provider = {
  name: "codex",
  defaultModel: "o3",

  async *execute(prompt: string, config: ProviderConfig): AsyncIterable<NormalizedMessage> {
    const codex = getCodex();
    const thread = codex.startThread();

    // Prepend system prompt to the user prompt (Codex doesn't have a separate systemPrompt param)
    const fullPrompt = `${config.systemPrompt}\n\n---\n\n${prompt}`;

    let inputTokens = 0;
    let outputTokens = 0;
    let finalText = "";

    for await (const event of thread.runStreamed(fullPrompt)) {
      if (event.type === "message" || event.type === "text") {
        const text = typeof event === "string" ? event : (event as any).text ?? (event as any).content ?? "";
        if (text) {
          finalText += text;
          yield {
            type: "assistant",
            content: [{ type: "text", text }],
          };
        }
      } else if (event.type === "tool_call" || event.type === "function_call") {
        const name = (event as any).name ?? (event as any).tool ?? "unknown";
        const input = (event as any).arguments ?? (event as any).input ?? {};
        yield {
          type: "assistant",
          content: [{ type: "tool_use", name, input }],
        };
      } else if (event.type === "tool_result" || event.type === "function_result") {
        const content = (event as any).output ?? (event as any).result ?? "";
        yield {
          type: "user",
          content: [{ type: "tool_result", content: String(content) }],
        };
      } else if (event.type === "usage" || event.type === "done" || event.type === "turn_completed") {
        inputTokens = (event as any).inputTokens ?? (event as any).usage?.inputTokens ?? 0;
        outputTokens = (event as any).outputTokens ?? (event as any).usage?.outputTokens ?? 0;
      }
    }

    // Emit final result with usage
    const costPerInputK = parseFloat(process.env.CODEX_COST_PER_1K_INPUT ?? "0.01");
    const costPerOutputK = parseFloat(process.env.CODEX_COST_PER_1K_OUTPUT ?? "0.03");
    const costUsd = (inputTokens / 1000) * costPerInputK + (outputTokens / 1000) * costPerOutputK;

    const usage: UsageData = {
      model: config.model,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd,
    };

    yield { type: "result", content: [], usage };
  },
};
```

**Note:** The exact event types from `thread.runStreamed()` will need adjustment based on the actual SDK response shape. The above handles multiple possible event formats defensively. Refine after testing with real SDK output.

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors (may need `// @ts-ignore` or type assertions for SDK event shapes until we test)

- [ ] **Step 3: Commit**

```bash
git add server/providers/codex.ts
git commit -m "feat(providers): add Codex provider wrapping codex-sdk"
```

---

### Task 6: Provider Factory

**Files:**
- Create: `server/providers/index.ts`

- [ ] **Step 1: Create the factory**

```typescript
// server/providers/index.ts
import type { Provider } from "./types.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";

export type ProviderName = "claude" | "codex";

const providers: Record<ProviderName, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
};

let activeProvider: ProviderName | null = null;

export function getProviderName(): ProviderName {
  if (!activeProvider) {
    const env = process.env.BOOP_PROVIDER?.toLowerCase() ?? "claude";
    if (env !== "claude" && env !== "codex") {
      console.warn(`[providers] unknown BOOP_PROVIDER="${env}", defaulting to claude`);
      activeProvider = "claude";
    } else {
      activeProvider = env;
    }
  }
  return activeProvider;
}

export function getProvider(): Provider {
  return providers[getProviderName()];
}

export { type Provider, type ProviderConfig, type NormalizedMessage } from "./types.js";
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/providers/index.ts
git commit -m "feat(providers): add provider factory with env-based selection"
```

---

### Task 7: Update runtime-config.ts to be Provider-Aware

**Files:**
- Modify: `server/runtime-config.ts`

- [ ] **Step 1: Refactor model configuration**

Replace the entire file with provider-aware logic:

```typescript
// server/runtime-config.ts
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { getProviderName } from "./providers/index.js";

const MODEL_KEY = "model";
const MODEL_TTL_MS = 30 * 1000;
let cached: { at: number; value: string } | null = null;

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

export function resolveModelInput(input: string): string | null {
  const provider = getProviderName();
  const lower = input.trim().toLowerCase();
  if (PROVIDER_MODELS[provider]?.has(lower)) return lower;
  return PROVIDER_MODEL_ALIASES[provider]?.[lower] ?? null;
}

function envFallback(): string {
  const provider = getProviderName();
  const envModel = process.env.BOOP_MODEL;
  if (envModel && PROVIDER_MODELS[provider]?.has(envModel)) return envModel;
  return PROVIDER_DEFAULTS[provider] ?? "claude-sonnet-4-6";
}

export async function getRuntimeModel(): Promise<string> {
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.value;
  const provider = getProviderName();
  let stored: string | null = null;
  try {
    stored = await convex.query(api.settings.get, { key: MODEL_KEY });
  } catch (err) {
    console.warn("[runtime-config] settings:get failed", err);
  }
  const final = stored && PROVIDER_MODELS[provider]?.has(stored) ? stored : envFallback();
  cached = { at: Date.now(), value: final };
  return final;
}

export async function setRuntimeModel(model: string): Promise<void> {
  await convex.mutation(api.settings.set, { key: MODEL_KEY, value: model });
  cached = { at: Date.now(), value: model };
}

export async function clearRuntimeModel(): Promise<void> {
  await convex.mutation(api.settings.clear, { key: MODEL_KEY });
  cached = null;
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/runtime-config.ts
git commit -m "feat(config): make model configuration provider-aware"
```

---

### Task 8: Refactor execution-agent.ts to Use Provider

**Files:**
- Modify: `server/execution-agent.ts`

- [ ] **Step 1: Replace query() import with provider**

Replace line 1:
```typescript
// OLD: import { query } from "@anthropic-ai/claude-agent-sdk";
// NEW:
import { getProvider, getProviderName } from "./providers/index.js";
import type { NormalizedMessage } from "./providers/types.js";
```

Keep the `McpSdkServerConfigWithInstance` import (still needed for building MCP servers for Claude provider).

- [ ] **Step 2: Replace the query() call block (lines 159-217) with provider.execute()**

Replace the `for await (const msg of query({...}))` block with:

```typescript
    const provider = getProvider();
    for await (const msg of provider.execute(opts.task, {
      systemPrompt: EXECUTION_SYSTEM,
      model: requestedModel,
      mcpServers: mcpServers as Record<string, unknown>,
      allowedTools,
      abortController: abort,
      permissionMode: "bypassPermissions",
      settingSources: ["project"],
    })) {
      if (msg.type === "assistant") {
        for (const block of msg.content) {
          if (block.type === "text") {
            buffer += block.text;
            await convex.mutation(api.agents.addLog, {
              agentId,
              logType: "text",
              content: block.text,
            });
          } else if (block.type === "tool_use") {
            const toolShort = block.name.replace(/^mcp__[a-z-]+__/, "");
            const accounts = extractAccounts(block.input);
            const acctSuffix = accounts.length ? ` [${accounts.join(", ")}]` : "";
            logAgent(`tool: ${toolShort}${acctSuffix}`);
            await convex.mutation(api.agents.addLog, {
              agentId,
              logType: "tool_use",
              toolName: block.name,
              ...(accounts.length ? { accounts } : {}),
              content: JSON.stringify(block.input).slice(0, 2000),
            });
            broadcast("agent_tool", { agentId, toolName: block.name, accounts });
          }
        }
      } else if (msg.type === "user") {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            await convex.mutation(api.agents.addLog, {
              agentId,
              logType: "tool_result",
              content: block.content.slice(0, 2000),
            });
          }
        }
      } else if (msg.type === "result" && msg.usage) {
        usage = {
          model: msg.usage.model,
          inputTokens: msg.usage.inputTokens,
          outputTokens: msg.usage.outputTokens,
          cacheReadTokens: msg.usage.cacheReadTokens,
          cacheCreationTokens: msg.usage.cacheCreationTokens,
          costUsd: msg.usage.costUsd,
        };
      }
    }
```

- [ ] **Step 3: Remove the import of `aggregateUsageFromResult` from usage.ts** (it's now handled inside the provider)

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add server/execution-agent.ts
git commit -m "refactor(execution): use provider abstraction instead of direct query()"
```

---

### Task 9: Refactor interaction-agent.ts to Use Provider

**Files:**
- Modify: `server/interaction-agent.ts`

- [ ] **Step 1: Replace query() and createSdkMcpServer imports**

Replace line 1:
```typescript
// OLD: import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
// NEW:
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { getProvider } from "./providers/index.js";
import type { NormalizedMessage } from "./providers/types.js";
```

Note: `tool` and `createSdkMcpServer` are still needed for building MCP server objects passed to the Claude provider.

- [ ] **Step 2: Replace the query() call block (lines 310-382) with provider.execute()**

Replace the `for await (const msg of query({...}))` block with:

```typescript
    const provider = getProvider();
    for await (const msg of provider.execute(prompt, {
      systemPrompt,
      model: requestedModel,
      mcpServers: {
        "boop-memory": memoryServer,
        "boop-spawn": spawnServer,
        "boop-automations": automationServer,
        "boop-draft-decisions": draftDecisionServer,
        "boop-ack": ackServer,
        "boop-self": selfServer,
      } as Record<string, unknown>,
      allowedTools: [
        "mcp__boop-memory__write_memory",
        "mcp__boop-memory__recall",
        "mcp__boop-spawn__spawn_agent",
        "mcp__boop-automations__create_automation",
        "mcp__boop-automations__list_automations",
        "mcp__boop-automations__toggle_automation",
        "mcp__boop-automations__delete_automation",
        "mcp__boop-draft-decisions__list_drafts",
        "mcp__boop-draft-decisions__send_draft",
        "mcp__boop-draft-decisions__reject_draft",
        "mcp__boop-ack__send_ack",
        "mcp__boop-self__get_config",
        "mcp__boop-self__set_model",
        "mcp__boop-self__set_timezone",
        "mcp__boop-self__list_integrations",
        "mcp__boop-self__search_composio_catalog",
        "mcp__boop-self__inspect_toolkit",
      ],
      disallowedTools: [
        "WebSearch", "WebFetch", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "Skill",
      ],
      permissionMode: "bypassPermissions",
    })) {
      if (msg.type === "assistant") {
        reply = "";
        for (const block of msg.content) {
          if (block.type === "text") {
            reply += block.text;
            opts.onThinking?.(block.text);
          } else if (block.type === "tool_use") {
            const name = block.name.replace(/^mcp__boop-[a-z-]+__/, "");
            const inputPreview = JSON.stringify(block.input);
            log(
              `tool: ${name}(${inputPreview.length > 90 ? inputPreview.slice(0, 90) + "…" : inputPreview})`,
            );
          }
        }
      } else if (msg.type === "result" && msg.usage) {
        usage = {
          model: msg.usage.model,
          inputTokens: msg.usage.inputTokens,
          outputTokens: msg.usage.outputTokens,
          cacheReadTokens: msg.usage.cacheReadTokens,
          cacheCreationTokens: msg.usage.cacheCreationTokens,
          costUsd: msg.usage.costUsd,
        };
      }
    }
```

- [ ] **Step 3: Remove `aggregateUsageFromResult` import**

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add server/interaction-agent.ts
git commit -m "refactor(interaction): use provider abstraction instead of direct query()"
```

---

### Task 10: Wire Up Codex MCP Server at Startup

**Files:**
- Modify: `server/index.ts`
- Modify: `server/providers/codex-mcp-server.ts`

- [ ] **Step 1: Add startup hook in index.ts**

After the existing initialization code (Telegram, automations, etc.), add:

```typescript
import { getProviderName } from "./providers/index.js";
import { startCodexMcpServer, registerToolsForCodex } from "./providers/codex-mcp-server.js";

// Near the top of the main startup function, after loadIntegrations():
if (getProviderName() === "codex") {
  // Register all Boop tools on the MCP HTTP server
  // (tool registration function will be populated by interaction/execution agent setup)
  await startCodexMcpServer(parseInt(process.env.CODEX_MCP_PORT ?? "3456"));
}
```

- [ ] **Step 2: Generate .codex/config.toml at startup**

Add to the codex startup block:

```typescript
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

if (getProviderName() === "codex") {
  const codexDir = join(process.cwd(), ".codex");
  mkdirSync(codexDir, { recursive: true });
  const port = process.env.CODEX_MCP_PORT ?? "3456";
  writeFileSync(
    join(codexDir, "config.toml"),
    `[mcp_servers.boop-tools]\ntype = "http"\nurl = "http://127.0.0.1:${port}/mcp"\n`,
  );
  console.log("[codex] wrote .codex/config.toml");
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add server/index.ts server/providers/codex-mcp-server.ts
git commit -m "feat: wire up Codex MCP server at startup with config.toml generation"
```

---

### Task 11: Register Boop Tools on the Codex MCP Server

**Files:**
- Modify: `server/providers/codex-mcp-server.ts`
- Create: `server/providers/codex-tool-registry.ts`

- [ ] **Step 1: Create a tool registry that collects all Boop tools for Codex**

```typescript
// server/providers/codex-tool-registry.ts
import type { ToolDefinition } from "./codex-mcp-server.js";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { embed, embeddingsAvailable } from "../embeddings.js";
import { spawnExecutionAgent, availableIntegrations } from "../execution-agent.js";

/**
 * Build the list of tool definitions that should be exposed to Codex
 * via the local MCP HTTP server. These mirror what createSdkMcpServer()
 * registers for the Claude provider.
 */
export function buildInteractionTools(conversationId: string): ToolDefinition[] {
  return [
    {
      name: "recall",
      description: "Search memory for relevant records.",
      schema: { query: { type: "string", description: "What to search for" } },
      handler: async (args: { query: string }) => {
        const results = await convex.query(api.memoryRecords.search, {
          query: args.query,
          limit: 10,
        });
        return { content: [{ type: "text", text: JSON.stringify(results) }] };
      },
    },
    {
      name: "spawn_agent",
      description: `Spawn a sub-agent for external work. Available integrations: ${availableIntegrations().join(", ")}`,
      schema: {
        task: { type: "string", description: "Task description" },
        integrations: { type: "array", items: { type: "string" }, description: "Which integrations" },
        name: { type: "string", description: "Short label" },
      },
      handler: async (args: { task: string; integrations: string[]; name?: string }) => {
        const res = await spawnExecutionAgent({
          task: args.task,
          integrations: args.integrations,
          conversationId,
          name: args.name,
        });
        return { content: [{ type: "text", text: `[agent ${res.agentId} ${res.status}]\n\n${res.result}` }] };
      },
    },
    // Additional tools (write_memory, automations, etc.) follow the same pattern
  ];
}

export function buildExecutionTools(conversationId: string, integrations: string[]): ToolDefinition[] {
  // Execution tools: WebSearch, WebFetch handled natively by Codex
  // Composio integration tools would need to be exposed here
  return [];
}
```

**Note:** This is a skeleton — each tool from `interaction-agent.ts` and `execution-agent.ts` will be ported to this registry. The full list matches the MCP tools already defined in the codebase.

- [ ] **Step 2: Export ToolDefinition type from codex-mcp-server.ts**

Add `export` to the `ToolDefinition` interface in `codex-mcp-server.ts`.

- [ ] **Step 3: Commit**

```bash
git add server/providers/codex-tool-registry.ts server/providers/codex-mcp-server.ts
git commit -m "feat(providers): add Codex tool registry mirroring Boop MCP tools"
```

---

### Task 12: End-to-End Smoke Test

**Files:**
- Create: `scripts/test-provider.ts`

- [ ] **Step 1: Create a minimal smoke test script**

```typescript
// scripts/test-provider.ts
import { getProvider, getProviderName } from "../server/providers/index.js";

async function main() {
  const provider = getProvider();
  console.log(`Provider: ${provider.name} (from BOOP_PROVIDER=${getProviderName()})`);
  console.log(`Default model: ${provider.defaultModel}`);

  console.log("\nSending test prompt...");
  for await (const msg of provider.execute("Say hello in one sentence.", {
    systemPrompt: "You are a helpful assistant. Reply in one sentence.",
    model: provider.defaultModel,
    mcpServers: {},
    allowedTools: [],
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
    } else if (msg.type === "result") {
      console.log("\n\nUsage:", msg.usage);
    }
  }
}

main().catch(console.error);
```

- [ ] **Step 2: Test with Claude provider**

Run: `BOOP_PROVIDER=claude tsx scripts/test-provider.ts`
Expected: Prints a greeting and usage stats

- [ ] **Step 3: Test with Codex provider** (requires OPENAI_API_KEY)

Run: `BOOP_PROVIDER=codex OPENAI_API_KEY=sk-... tsx scripts/test-provider.ts`
Expected: Prints a greeting and usage stats

- [ ] **Step 4: Commit**

```bash
git add scripts/test-provider.ts
git commit -m "test: add provider smoke test script"
```

---

### Task 13: Update .env.local.example

**Files:**
- Modify: `.env.local.example` (or equivalent)

- [ ] **Step 1: Add provider configuration docs**

Append to the example env file:

```env
# --- Provider Selection ---
# "claude" (default) or "codex"
# BOOP_PROVIDER=claude

# Required when BOOP_PROVIDER=codex
# OPENAI_API_KEY=sk-...

# Model must be valid for the active provider
# Claude: claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001
# Codex: o3, o4-mini, gpt-4.1, codex-mini
# BOOP_MODEL=claude-sonnet-4-6

# Optional: Codex cost estimation overrides
# CODEX_COST_PER_1K_INPUT=0.01
# CODEX_COST_PER_1K_OUTPUT=0.03

# Optional: port for local MCP server (Codex provider only)
# CODEX_MCP_PORT=3456
```

- [ ] **Step 2: Commit**

```bash
git add .env.local.example
git commit -m "docs: add provider env vars to .env.local.example"
```

---

## Execution Order

Tasks 1-6 are the foundation (types, providers, factory). Task 7 updates config. Tasks 8-9 are the main refactor. Task 10-11 wire Codex MCP. Task 12-13 are validation and docs.

Tasks can be parallelized:
- Tasks 2, 3, 4, 5 are independent (different files)
- Tasks 8 and 9 are independent (different files, same pattern)
- Task 12 depends on all prior tasks
