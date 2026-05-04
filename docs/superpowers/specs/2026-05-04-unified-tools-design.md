# Unified Tool Definitions

**Date:** 2026-05-04
**Status:** Draft
**Branch:** `refactor/unified-tools`

## Summary

Extract all tool handler logic into a single shared `server/tools/` module. Both the Claude Agent SDK (in-process MCP) and the Codex SDK (HTTP MCP) consume the same `ToolSpec` definitions through thin provider-specific adapters. Eliminates all duplication between the Claude MCP files and the Codex tool registry.

## Motivation

Tool logic is currently duplicated:
- **Claude side:** `automation-tools.ts`, `draft-tools.ts`, `self-tools.ts`, `memory/tools.ts`, `tools/research-tools.ts` — each uses `createSdkMcpServer` + `tool()` from the Claude Agent SDK.
- **Codex side:** `providers/codex-tool-registry.ts` — reimplements the same handlers with `ToolDefinition` objects.

Any tool change requires edits in two places. Bug fixes diverge. Adding a new tool means writing it twice. This refactor makes tools a first-class shared module with one source of truth.

## Architecture

### ToolSpec Interface

```typescript
// server/tools/types.ts
import { z } from "zod";

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export interface ToolContext {
  conversationId: string;
}
```

- **Schema is Zod raw shape** — both providers accept this natively. Claude SDK's `tool()` takes Zod. MCP SDK's `registerTool` takes Zod raw shapes.
- **Handler returns `string`** — each provider wraps it into its response format (`{ content: [{ type: "text", text }] }` for Claude, plain text for Codex MCP).
- **`ToolContext`** carries per-request state (primarily `conversationId`). Injected at call time by each provider, not baked into tool definitions. This replaces the current pattern of creating MCP servers per-turn with a closure over `conversationId`.

### File Structure

```
server/tools/
  types.ts              — ToolSpec, ToolContext
  memory.ts             — recall, write_memory
  automations.ts        — create_automation, list_automations, toggle_automation, delete_automation
  drafts.ts             — list_drafts, send_draft, reject_draft
  self-config.ts        — get_config, set_model, set_timezone
  integrations.ts       — list_integrations, search_composio_catalog, inspect_toolkit
  comms.ts              — send_ack
  research.ts           — list_research_findings, check_findings, save_finding
  index.ts              — groups and re-exports: interactionTools, executionTools, allTools

server/tools/adapters/
  claude.ts             — toolSpecsToClaudeMcp(name, version, specs, ctx) → McpSdkServerConfigWithInstance
  codex.ts              — toolSpecsToCodexDefs(specs, ctx) → ToolDefinition[]
```

### Provider Adapters

#### Claude Adapter (`server/tools/adapters/claude.ts`)

```typescript
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
```

#### Codex Adapter (`server/tools/adapters/codex.ts`)

```typescript
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
```

### Tool Groupings (`server/tools/index.ts`)

```typescript
// Groups for the interaction agent (dispatcher)
export const interactionTools = [
  ...memoryTools,      // recall, write_memory
  ...automationTools,  // create/list/toggle/delete
  ...draftTools,       // list/send/reject
  ...selfConfigTools,  // get_config, set_model, set_timezone
  ...integrationTools, // list_integrations, search_catalog, inspect
  ...commsTools,       // send_ack
];

// Groups for the execution agent
export const executionTools = [
  ...researchQueryTools,  // list_research_findings
  ...memoryReadTools,     // recall (read-only subset)
];

// Research dedup tools (only for automation runs with dataSchema)
export const researchDedupTools = [
  ...researchDedupSpecs,  // check_findings, save_finding
];
```

### Consumer Changes

#### `interaction-agent.ts`

Before:
```typescript
const memoryServer = createMemoryMcp(opts.conversationId);
const automationServer = createAutomationMcp(opts.conversationId);
const draftDecisionServer = createDraftDecisionMcp(opts.conversationId);
const selfServer = createSelfMcp();
const ackServer = createSdkMcpServer({ ... });
const spawnServer = createSdkMcpServer({ ... });
```

After:
```typescript
import { interactionTools } from "./tools/index.js";
import { toolSpecsToClaudeMcp } from "./tools/adapters/claude.js";

const ctx = { conversationId: opts.conversationId };

// spawn_agent is still inline (it's provider-specific — it calls spawnExecutionAgent)
const spawnServer = createSdkMcpServer({ ... });

const toolServer = toolSpecsToClaudeMcp("boop-tools", "0.1.0", interactionTools, ctx);

// Pass both to provider.execute()
mcpServers: {
  "boop-tools": toolServer,
  "boop-spawn": spawnServer,
}
```

Note: `spawn_agent` stays inline in `interaction-agent.ts` because it has provider-specific logic (spawning sub-agents). It's not a simple Convex call.

#### `execution-agent.ts`

Before:
```typescript
const mcpServers = { ...integrationServers, ...draftServer, "boop-research-query": createResearchQueryMcp() };
if (opts.dataSchema && opts.automationId) mcpServers["boop-research"] = createResearchMcp(opts.automationId);
```

After:
```typescript
import { executionTools, researchDedupTools } from "./tools/index.js";
import { toolSpecsToClaudeMcp } from "./tools/adapters/claude.js";

const ctx = { conversationId: opts.conversationId };
const execToolServer = toolSpecsToClaudeMcp("boop-exec-tools", "0.1.0", executionTools, ctx);
const mcpServers = { ...integrationServers, ...draftServer, "boop-exec-tools": execToolServer };

if (opts.dataSchema && opts.automationId) {
  const dedupCtx = { conversationId: opts.conversationId, automationId: opts.automationId };
  mcpServers["boop-research"] = toolSpecsToClaudeMcp("boop-research", "0.1.0", researchDedupTools, dedupCtx);
}
```

#### `index.ts` (Codex startup)

Before:
```typescript
registerToolsForCodex(buildInteractionTools());
registerToolsForCodex(buildExecutionTools("", []));
```

After:
```typescript
import { interactionTools, executionTools } from "./tools/index.js";
import { toolSpecsToCodexDefs } from "./tools/adapters/codex.js";
import { defaultConversationId } from "./tools/index.js";

const ctx = { conversationId: defaultConversationId() };
registerToolsForCodex(toolSpecsToCodexDefs([...interactionTools, ...executionTools], ctx));
```

## Files Deleted

| File | Replaced By |
|------|-------------|
| `server/automation-tools.ts` | `server/tools/automations.ts` |
| `server/draft-tools.ts` | `server/tools/drafts.ts` |
| `server/self-tools.ts` | `server/tools/self-config.ts` + `server/tools/integrations.ts` |
| `server/memory/tools.ts` | `server/tools/memory.ts` |
| `server/tools/research-tools.ts` | `server/tools/research.ts` |
| `server/providers/codex-tool-registry.ts` | `server/tools/index.ts` + adapters |

## Files Created

| File | Purpose |
|------|---------|
| `server/tools/types.ts` | ToolSpec, ToolContext interfaces |
| `server/tools/memory.ts` | recall, write_memory specs |
| `server/tools/automations.ts` | create/list/toggle/delete automation specs |
| `server/tools/drafts.ts` | list/send/reject draft specs |
| `server/tools/self-config.ts` | get_config, set_model, set_timezone specs |
| `server/tools/integrations.ts` | list_integrations, search_catalog, inspect specs |
| `server/tools/comms.ts` | send_ack spec |
| `server/tools/research.ts` | list_research_findings, check_findings, save_finding specs |
| `server/tools/index.ts` | Groups + re-exports |
| `server/tools/adapters/claude.ts` | ToolSpec[] → Claude MCP server |
| `server/tools/adapters/codex.ts` | ToolSpec[] → Codex ToolDefinition[] |

## Files Modified

| File | Change |
|------|--------|
| `server/interaction-agent.ts` | Use shared tools via claude adapter |
| `server/execution-agent.ts` | Use shared tools via claude adapter |
| `server/index.ts` | Use shared tools via codex adapter |

## Constraints

1. **`spawn_agent` stays inline** — it has provider-specific logic (calling `spawnExecutionAgent` with closure over conversation state). It's not a simple handler.
2. **`send_ack` on Claude side** has Telegram-specific logic (sending via `sendMessage`). The shared handler will do the Convex persistence; the Telegram send stays in the interaction agent as a wrapper.
3. **Research dedup tools** (`check_findings`, `save_finding`) need `automationId` in their context. `ToolContext` will be extended: `automationId?: string`.
4. **Existing `server/tools/` directory** already has `research-tools.ts`. The new files go alongside it, then the old one is deleted.

## Testing Strategy

1. **Type check** — `npx tsc --noEmit` after each task.
2. **Behavioral parity** — switch to Claude (`BOOP_PROVIDER=claude`), send messages via Telegram, verify recall/spawn/automations/drafts all work identically.
3. **Codex parity** — switch to Codex, verify same tool list appears on MCP server.
4. **Regression** — run automations, verify research dedup tools still fire.
