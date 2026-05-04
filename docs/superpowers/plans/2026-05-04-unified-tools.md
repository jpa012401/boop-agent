# Unified Tool Definitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract all tool handler logic into shared `ToolSpec` definitions consumed by both Claude and Codex through thin adapters.

**Architecture:** Each tool is defined once as a `ToolSpec` (name, description, Zod schema, handler returning string). Provider-specific adapters wrap specs into Claude MCP servers or Codex ToolDefinitions. Old per-provider tool files are deleted.

**Tech Stack:** TypeScript, Zod, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`

**Spec:** `docs/superpowers/specs/2026-05-04-unified-tools-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/tools/types.ts` | ToolSpec, ToolContext interfaces |
| `server/tools/memory.ts` | recall, write_memory |
| `server/tools/automations.ts` | create/list/toggle/delete automation |
| `server/tools/drafts.ts` | list/send/reject draft |
| `server/tools/self-config.ts` | get_config, set_model, set_timezone |
| `server/tools/integrations.ts` | list_integrations, search_composio_catalog, inspect_toolkit |
| `server/tools/comms.ts` | send_ack |
| `server/tools/research.ts` | list_research_findings, check_findings, save_finding |
| `server/tools/spawn.ts` | spawn_agent |
| `server/tools/index.ts` | Groups and re-exports |
| `server/tools/adapters/claude.ts` | ToolSpec[] → Claude MCP server |
| `server/tools/adapters/codex.ts` | ToolSpec[] → Codex ToolDefinition[] |
| `server/interaction-agent.ts` | Modified: use adapters |
| `server/execution-agent.ts` | Modified: use adapters |
| `server/index.ts` | Modified: use adapters for Codex |

**Deleted after migration:**
- `server/automation-tools.ts`
- `server/draft-tools.ts`
- `server/self-tools.ts`
- `server/memory/tools.ts`
- `server/tools/research-tools.ts`
- `server/providers/codex-tool-registry.ts`

---

### Task 1: Create ToolSpec Types and Adapters

**Files:**
- Create: `server/tools/types.ts`
- Create: `server/tools/adapters/claude.ts`
- Create: `server/tools/adapters/codex.ts`

- [ ] **Step 1: Create types.ts**

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
  automationId?: string;
}
```

- [ ] **Step 2: Create Claude adapter**

```typescript
// server/tools/adapters/claude.ts
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

- [ ] **Step 3: Create Codex adapter**

```typescript
// server/tools/adapters/codex.ts
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

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add server/tools/types.ts server/tools/adapters/claude.ts server/tools/adapters/codex.ts
git commit -m "feat(tools): add ToolSpec types and provider adapters"
```

---

### Task 2: Extract Memory Tools

**Files:**
- Create: `server/tools/memory.ts`

Extract `recall` and `write_memory` handlers from `server/memory/tools.ts`. The handler logic is identical — just return strings instead of `{ content: [...] }`.

- [ ] **Step 1: Create memory.ts**

```typescript
// server/tools/memory.ts
import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { embed, embeddingsAvailable } from "../embeddings.js";
import { DEFAULT_DECAY, SEGMENT_PREFERRED_TIER, makeMemoryId } from "../memory/types.js";
import type { ToolSpec } from "./types.js";

const tierEnum = z.enum(["short", "long", "permanent"]);
const segmentEnum = z.enum([
  "identity",
  "preference",
  "relationship",
  "project",
  "knowledge",
  "context",
]);

export const memoryTools: ToolSpec[] = [
  {
    name: "write_memory",
    description:
      "Persist a fact about the user or conversation that you want available in future turns. Prefer aggressive writing — memory is cheap, forgetting is expensive. Only use for durable facts (preferences, identity, projects, relationships), NOT for transient conversational state.",
    schema: {
      content: z.string().describe("The fact to remember, in one clear sentence."),
      segment: segmentEnum.describe(
        "identity: core facts about who they are. preference: how they like things done. relationship: people they know. project: ongoing work. knowledge: facts about their world. context: current situation.",
      ),
      importance: z.number().min(0).max(1).describe("0-1; how critical to retain."),
      tier: tierEnum.optional().describe("Override; defaults by segment."),
      supersedes: z.array(z.string()).optional().describe("memoryId(s) this replaces (will be archived)."),
    },
    handler: async (args, ctx) => {
      const segment = args.segment as keyof typeof SEGMENT_PREFERRED_TIER;
      const tier = (args.tier as "short" | "long" | "permanent" | undefined) ?? SEGMENT_PREFERRED_TIER[segment];
      const memoryId = makeMemoryId();
      const embedding = (await embed(args.content as string)) ?? undefined;
      await convex.mutation(api.memoryRecords.upsert, {
        memoryId,
        content: args.content as string,
        tier,
        segment,
        importance: args.importance as number,
        decayRate: DEFAULT_DECAY[tier],
        supersedes: args.supersedes as string[] | undefined,
        embedding,
      });
      await convex.mutation(api.memoryEvents.emit, {
        eventType: "memory.written",
        conversationId: ctx.conversationId,
        memoryId,
        data: JSON.stringify({ tier, segment, importance: args.importance }),
      });
      return `Stored ${memoryId} (tier=${tier}, segment=${segment}).`;
    },
  },
  {
    name: "recall",
    description:
      "Search your memories for anything relevant to the current turn. Call this early in any conversation that touches the user's preferences, projects, or past decisions.",
    schema: {
      query: z.string().describe("Keywords or topic to search for."),
      limit: z.number().optional().default(10),
    },
    handler: async (args, ctx) => {
      const query = args.query as string;
      const limit = (args.limit as number) ?? 10;
      let results: any[] = [];
      let mode: "vector" | "substring" = "substring";

      if (embeddingsAvailable()) {
        const queryVec = await embed(query);
        if (queryVec) {
          const hits = await convex.action(api.memoryRecords.vectorSearch, {
            embedding: queryVec,
            limit,
          });
          results = hits.map((h) => h.record);
          mode = "vector";
        }
      }
      if (results.length === 0) {
        results = await convex.query(api.memoryRecords.search, { query, limit });
      }

      for (const r of results) {
        await convex.mutation(api.memoryRecords.markAccessed, { memoryId: r.memoryId });
      }
      await convex.mutation(api.memoryEvents.emit, {
        eventType: "memory.recalled",
        conversationId: ctx.conversationId,
        data: JSON.stringify({ query, hits: results.length, mode }),
      });

      if (results.length === 0) return "No memories matched.";
      return results
        .map((r) => `• [${r.tier}/${r.segment} importance=${r.importance.toFixed(2)}] ${r.memoryId}: ${r.content}`)
        .join("\n");
    },
  },
];
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add server/tools/memory.ts
git commit -m "feat(tools): extract shared memory tool specs"
```

---

### Task 3: Extract Automation Tools

**Files:**
- Create: `server/tools/automations.ts`

Extract from `server/automation-tools.ts`. Port `create_automation`, `list_automations`, `toggle_automation`, `delete_automation`.

- [ ] **Step 1: Create automations.ts**

Port all 4 tool handlers from `server/automation-tools.ts`. Each handler takes `(args, ctx)` and returns a string. Use the same Zod schemas. Import `validateSchedule`, `nextRunFor` from `../automations.js`, `describeUserNow` from `../timezone-config.js`, `availableIntegrations` from `../execution-agent.js`.

The `create_automation` handler uses `ctx.conversationId` where the original uses the closure `conversationId`.

- [ ] **Step 2: Verify and commit**

```bash
npx tsc --noEmit
git add server/tools/automations.ts
git commit -m "feat(tools): extract shared automation tool specs"
```

---

### Task 4: Extract Draft Tools

**Files:**
- Create: `server/tools/drafts.ts`

Extract from `server/draft-tools.ts`. Port `list_drafts`, `send_draft`, `reject_draft`.

- [ ] **Step 1: Create drafts.ts**

Port all 3 draft decision handlers. `send_draft` calls `spawnExecutionAgent` — import it from `../execution-agent.js`. Use `ctx.conversationId`.

- [ ] **Step 2: Verify and commit**

```bash
npx tsc --noEmit
git add server/tools/drafts.ts
git commit -m "feat(tools): extract shared draft tool specs"
```

---

### Task 5: Extract Self-Config and Integration Tools

**Files:**
- Create: `server/tools/self-config.ts`
- Create: `server/tools/integrations.ts`

Extract from `server/self-tools.ts`. Split into two files: self-config (get_config, set_model, set_timezone) and integrations (list_integrations, search_composio_catalog, inspect_toolkit).

- [ ] **Step 1: Create self-config.ts**

Port `get_config`, `set_model`, `set_timezone`. Import `getRuntimeModel`, `resolveModelInput`, `setRuntimeModel`, `PROVIDER_MODELS`, `PROVIDER_MODEL_ALIASES` from `../runtime-config.js`. Import `getProviderName` from `../providers/index.js`. Import `describeUserNow`, `resolveTimezoneInput`, `setUserTimezone` from `../timezone-config.js`.

- [ ] **Step 2: Create integrations.ts**

Port `list_integrations`, `search_composio_catalog`, `inspect_toolkit`. Import `listConnectedToolkits`, `listToolkitMeta`, `listToolsForToolkit`, `CURATED_TOOLKITS` from `../composio.js`. Import `availableIntegrations` from `../execution-agent.js`.

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit
git add server/tools/self-config.ts server/tools/integrations.ts
git commit -m "feat(tools): extract shared self-config and integration tool specs"
```

---

### Task 6: Extract Comms and Spawn Tools

**Files:**
- Create: `server/tools/comms.ts`
- Create: `server/tools/spawn.ts`

- [ ] **Step 1: Create comms.ts**

The `send_ack` shared handler does the Convex persistence only (saving the message). The Telegram-specific `sendMessage` call and `broadcast` stay in `interaction-agent.ts` as a wrapper around the shared handler. For now, include a basic version that persists to Convex:

```typescript
// server/tools/comms.ts
import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import type { ToolSpec } from "./types.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const commsTools: ToolSpec[] = [
  {
    name: "send_ack",
    description:
      'Send a short acknowledgment message to the user IMMEDIATELY, before a slow operation. Use this BEFORE spawn_agent so the user knows you heard them. Keep it to ONE short sentence (under 60 chars). Examples: "On it — one sec 🔍", "Looking into it…"',
    schema: {
      message: z.string().describe("1 short sentence ack. No markdown. Emojis OK."),
    },
    handler: async (args, ctx) => {
      const text = (args.message as string).trim();
      if (!text) return "Empty ack skipped.";
      const turnId = randomId("turn");
      await convex.mutation(api.messages.send, {
        conversationId: ctx.conversationId,
        role: "assistant",
        content: text,
        turnId,
      });
      return "Ack sent to user.";
    },
  },
];
```

- [ ] **Step 2: Create spawn.ts**

```typescript
// server/tools/spawn.ts
import { z } from "zod";
import { availableIntegrations, spawnExecutionAgent } from "../execution-agent.js";
import type { ToolSpec } from "./types.js";

export function makeSpawnTools(): ToolSpec[] {
  const integrations = availableIntegrations();
  return [
    {
      name: "spawn_agent",
      description:
        "Spawn a focused sub-agent to do real work using external tools. Returns the agent's final answer.",
      schema: {
        task: z.string().describe("Crisp task description — what to find/draft/do."),
        integrations: z.array(z.string()).describe(
          `Which integrations to give the agent. Available: ${integrations.join(", ") || "(none)"}`,
        ),
        name: z.string().optional().describe("Short label for the agent."),
      },
      handler: async (args, ctx) => {
        const res = await spawnExecutionAgent({
          task: args.task as string,
          integrations: args.integrations as string[],
          conversationId: ctx.conversationId,
          name: args.name as string | undefined,
        });
        return `[agent ${res.agentId} ${res.status}]\n\n${res.result}`;
      },
    },
  ];
}
```

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit
git add server/tools/comms.ts server/tools/spawn.ts
git commit -m "feat(tools): extract shared comms and spawn tool specs"
```

---

### Task 7: Extract Research Tools

**Files:**
- Create: `server/tools/research.ts`

Extract from `server/tools/research-tools.ts`. Port `list_research_findings` (from codex-tool-registry), `check_findings`, `save_finding` (from research-tools.ts). The `normalizeUrl` and `contentHash` helpers move here too.

- [ ] **Step 1: Create research.ts**

Port all 3 tools. `check_findings` and `save_finding` use `ctx.automationId` (required for dedup). `list_research_findings` doesn't need it.

Export three groups:
- `researchQueryTools` — `[list_research_findings]`
- `researchDedupTools` — `[check_findings, save_finding]`

- [ ] **Step 2: Verify and commit**

```bash
npx tsc --noEmit
git add server/tools/research.ts
git commit -m "feat(tools): extract shared research tool specs"
```

---

### Task 8: Create Tool Index

**Files:**
- Create: `server/tools/index.ts`

- [ ] **Step 1: Create index.ts re-exporting all tool groups**

```typescript
// server/tools/index.ts
export type { ToolSpec, ToolContext } from "./types.js";
export { memoryTools } from "./memory.js";
export { automationTools } from "./automations.js";
export { draftTools } from "./drafts.js";
export { selfConfigTools } from "./self-config.js";
export { integrationTools } from "./integrations.js";
export { commsTools } from "./comms.js";
export { makeSpawnTools } from "./spawn.js";
export { researchQueryTools, researchDedupTools } from "./research.js";

import { memoryTools } from "./memory.js";
import { automationTools } from "./automations.js";
import { draftTools } from "./drafts.js";
import { selfConfigTools } from "./self-config.js";
import { integrationTools } from "./integrations.js";
import { commsTools } from "./comms.js";
import { makeSpawnTools } from "./spawn.js";
import { researchQueryTools } from "./research.js";
import type { ToolSpec } from "./types.js";

/** All interaction-layer tools (minus spawn, which is built dynamically). */
export const interactionTools: ToolSpec[] = [
  ...memoryTools,
  ...automationTools,
  ...draftTools,
  ...selfConfigTools,
  ...integrationTools,
  ...commsTools,
];

/** Execution-layer tools (read-only data access). */
export const executionTools: ToolSpec[] = [
  ...researchQueryTools,
];

export function defaultConversationId(): string {
  const chatId = process.env.BOOP_USER_CHAT_ID;
  return chatId ? `telegram:${chatId}` : "codex:default";
}
```

- [ ] **Step 2: Verify and commit**

```bash
npx tsc --noEmit
git add server/tools/index.ts
git commit -m "feat(tools): add tool index with grouped exports"
```

---

### Task 9: Wire Up interaction-agent.ts

**Files:**
- Modify: `server/interaction-agent.ts`

- [ ] **Step 1: Replace old MCP server imports**

Replace imports of `createMemoryMcp`, `createAutomationMcp`, `createDraftDecisionMcp`, `createSelfMcp` with:

```typescript
import { interactionTools, makeSpawnTools } from "./tools/index.js";
import { toolSpecsToClaudeMcp } from "./tools/adapters/claude.js";
```

- [ ] **Step 2: Replace MCP server creation**

Replace the block that creates `memoryServer`, `automationServer`, `draftDecisionServer`, `selfServer` with:

```typescript
const ctx = { conversationId: opts.conversationId };
const toolServer = toolSpecsToClaudeMcp("boop-tools", "0.1.0", [
  ...interactionTools,
  ...makeSpawnTools(),
], ctx);
```

Keep `ackServer` inline in `interaction-agent.ts` because it has Telegram-specific logic (`sendMessage`, `broadcast`) that shouldn't be in the shared handler. The shared `send_ack` in commsTools does the Convex persistence; the interaction agent wraps it with Telegram delivery.

Actually, simpler: make `send_ack` use the shared handler for Convex, but wrap it in `interaction-agent.ts` to also call `sendMessage`. This is done by **not including commsTools** in the shared `toolServer` and keeping the ack server inline with the Telegram logic.

- [ ] **Step 3: Update mcpServers and allowedTools**

Update the `mcpServers` object and `allowedTools` array to reference the new consolidated `"boop-tools"` server name with wildcard `mcp__boop-tools__*`.

Keep `ackServer` as `"boop-ack"` with its existing Telegram-aware handler.

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add server/interaction-agent.ts
git commit -m "refactor(interaction): use shared tool specs via claude adapter"
```

---

### Task 10: Wire Up execution-agent.ts

**Files:**
- Modify: `server/execution-agent.ts`

- [ ] **Step 1: Replace research MCP imports**

Replace `import { createResearchMcp, createResearchQueryMcp }` with:

```typescript
import { executionTools, researchDedupTools } from "./tools/index.js";
import { toolSpecsToClaudeMcp } from "./tools/adapters/claude.js";
```

- [ ] **Step 2: Replace MCP server creation**

Replace `createResearchQueryMcp()` with:
```typescript
const execCtx = { conversationId: opts.conversationId ?? "" };
const execToolServer = toolSpecsToClaudeMcp("boop-exec-tools", "0.1.0", executionTools, execCtx);
```

Replace `createResearchMcp(opts.automationId)` with:
```typescript
const dedupCtx = { conversationId: opts.conversationId ?? "", automationId: opts.automationId };
toolSpecsToClaudeMcp("boop-research", "0.1.0", researchDedupTools, dedupCtx);
```

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit
git add server/execution-agent.ts
git commit -m "refactor(execution): use shared tool specs via claude adapter"
```

---

### Task 11: Wire Up Codex Startup

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Replace codex-tool-registry imports**

Replace `import { buildInteractionTools, buildExecutionTools }` with:

```typescript
import { interactionTools, executionTools, makeSpawnTools, defaultConversationId } from "./tools/index.js";
import { toolSpecsToCodexDefs } from "./tools/adapters/codex.js";
```

- [ ] **Step 2: Replace registerToolsForCodex calls**

```typescript
const codexCtx = { conversationId: defaultConversationId() };
registerToolsForCodex(toolSpecsToCodexDefs([
  ...interactionTools,
  ...makeSpawnTools(),
  ...executionTools,
], codexCtx));
```

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit
git add server/index.ts
git commit -m "refactor(index): use shared tool specs for Codex MCP registration"
```

---

### Task 12: Delete Old Files

**Files:**
- Delete: `server/automation-tools.ts`
- Delete: `server/draft-tools.ts`
- Delete: `server/self-tools.ts`
- Delete: `server/memory/tools.ts`
- Delete: `server/tools/research-tools.ts`
- Delete: `server/providers/codex-tool-registry.ts`

- [ ] **Step 1: Remove old files**

```bash
git rm server/automation-tools.ts server/draft-tools.ts server/self-tools.ts server/memory/tools.ts server/tools/research-tools.ts server/providers/codex-tool-registry.ts
```

- [ ] **Step 2: Fix any remaining import references**

Run `npx tsc --noEmit` and fix any broken imports pointing to deleted files. Likely candidates:
- `server/interaction-agent.ts` — should already be updated in Task 9
- `server/execution-agent.ts` — should already be updated in Task 10
- `server/index.ts` — should already be updated in Task 11

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit
git add -A
git commit -m "chore: delete old tool files replaced by shared specs"
```

---

### Task 13: Final Verification

- [ ] **Step 1: Full type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Grep for dead imports**

```bash
grep -r "automation-tools\|draft-tools\|self-tools\|memory/tools\|research-tools\|codex-tool-registry" server/ --include="*.ts"
```
Expected: No matches (or only in plan/spec docs)

- [ ] **Step 3: Verify tool count parity**

Check that the interaction agent's allowedTools list and the Codex MCP server both expose the same tools. The tool names should match the original set of 17 tools.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: final cleanup after unified tools refactor"
```

---

## Execution Order

Tasks 1-8 are pure additions (no existing code changes). Tasks 9-11 swap consumers to use the new code. Task 12 deletes the old code. Task 13 verifies.

Parallelizable:
- Tasks 2-7 are independent (different tool domains)
- Tasks 9 and 10 are independent (different files)
- Task 12 depends on 9-11 all being complete
