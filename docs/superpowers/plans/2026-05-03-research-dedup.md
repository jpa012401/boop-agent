# Research Findings Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured research findings table with dedup tools so automation agents avoid re-reporting known findings.

**Architecture:** A new `researchFindings` Convex table stores structured findings keyed by normalized URL + content hash. Execution agents get `check_findings` and `save_finding` MCP tools (mounted when the spawning automation has a `dataSchema`). The automation creation tool gains a `dataSchema` parameter.

**Tech Stack:** Convex (schema + mutations/queries), Claude Agent SDK MCP tools, Node.js crypto (SHA-256)

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `convex/researchFindings.ts` | Mutations + queries for the findings table |
| Create | `server/tools/research-tools.ts` | MCP server with `check_findings` and `save_finding` tools |
| Modify | `convex/schema.ts` | Add `researchFindings` table + `dataSchema` on `automations` |
| Modify | `convex/automations.ts` | Accept `dataSchema` in create mutation |
| Modify | `server/automation-tools.ts` | Add `dataSchema` param to `create_automation` tool |
| Modify | `server/execution-agent.ts` | Mount research MCP server + update system prompt |
| Modify | `server/automations.ts` | Pass `dataSchema` through to execution agent task prompt |

---

### Task 1: Add `researchFindings` table and `dataSchema` to Convex schema

**Files:**
- Modify: `convex/schema.ts`

- [ ] **Step 1: Add `dataSchema` field to the `automations` table**

In `convex/schema.ts`, add after the `nextRunAt` field (line 164):

```typescript
    dataSchema: v.optional(v.string()),
```

- [ ] **Step 2: Add `researchFindings` table**

In `convex/schema.ts`, add after the `automationRuns` table definition (before the closing of `defineSchema`):

```typescript
  researchFindings: defineTable({
    findingId: v.string(),
    automationId: v.string(),
    conversationId: v.optional(v.string()),
    url: v.string(),
    contentHash: v.string(),
    title: v.string(),
    data: v.string(),
    tags: v.optional(v.array(v.string())),
    status: v.union(
      v.literal("new"),
      v.literal("reported"),
      v.literal("archived"),
    ),
    foundAt: v.number(),
    reportedAt: v.optional(v.number()),
  })
    .index("by_finding_id", ["findingId"])
    .index("by_automation", ["automationId"])
    .index("by_url", ["url"])
    .index("by_content_hash", ["contentHash"])
    .index("by_status", ["automationId", "status"]),
```

- [ ] **Step 3: Verify schema deploys**

Run: `npx convex dev --once --typecheck=disable`
Expected: Deploys successfully

- [ ] **Step 4: Commit**

```bash
git add convex/schema.ts
git commit -m "feat: add researchFindings table and dataSchema to automations"
```

---

### Task 2: Create `convex/researchFindings.ts`

**Files:**
- Create: `convex/researchFindings.ts`

- [ ] **Step 1: Create the file with all mutations and queries**

```typescript
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const save = mutation({
  args: {
    findingId: v.string(),
    automationId: v.string(),
    conversationId: v.optional(v.string()),
    url: v.string(),
    contentHash: v.string(),
    title: v.string(),
    data: v.string(),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    // Check for duplicate by URL
    const byUrl = await ctx.db
      .query("researchFindings")
      .withIndex("by_url", (q) => q.eq("url", args.url))
      .first();
    if (byUrl) return { saved: false, reason: "duplicate_url", existingId: byUrl.findingId };

    // Check for duplicate by content hash
    const byHash = await ctx.db
      .query("researchFindings")
      .withIndex("by_content_hash", (q) => q.eq("contentHash", args.contentHash))
      .first();
    if (byHash) return { saved: false, reason: "duplicate_content", existingId: byHash.findingId };

    await ctx.db.insert("researchFindings", {
      ...args,
      status: "new",
      foundAt: Date.now(),
    });
    return { saved: true, findingId: args.findingId };
  },
});

export const checkUrls = query({
  args: { urls: v.array(v.string()) },
  handler: async (ctx, args) => {
    const known: { findingId: string; url: string; title: string; foundAt: number }[] = [];
    for (const url of args.urls) {
      const match = await ctx.db
        .query("researchFindings")
        .withIndex("by_url", (q) => q.eq("url", url))
        .first();
      if (match) {
        known.push({
          findingId: match.findingId,
          url: match.url,
          title: match.title,
          foundAt: match.foundAt,
        });
      }
    }
    return { known };
  },
});

export const checkHash = query({
  args: { contentHash: v.string() },
  handler: async (ctx, args) => {
    const match = await ctx.db
      .query("researchFindings")
      .withIndex("by_content_hash", (q) => q.eq("contentHash", args.contentHash))
      .first();
    if (!match) return { found: false };
    return {
      found: true,
      findingId: match.findingId,
      url: match.url,
      title: match.title,
    };
  },
});

export const markReported = mutation({
  args: { findingId: v.string() },
  handler: async (ctx, args) => {
    const finding = await ctx.db
      .query("researchFindings")
      .withIndex("by_finding_id", (q) => q.eq("findingId", args.findingId))
      .unique();
    if (!finding) return null;
    await ctx.db.patch(finding._id, { status: "reported", reportedAt: Date.now() });
    return finding._id;
  },
});

export const archive = mutation({
  args: { findingId: v.string() },
  handler: async (ctx, args) => {
    const finding = await ctx.db
      .query("researchFindings")
      .withIndex("by_finding_id", (q) => q.eq("findingId", args.findingId))
      .unique();
    if (!finding) return null;
    await ctx.db.patch(finding._id, { status: "archived" });
    return finding._id;
  },
});

export const listByAutomation = query({
  args: {
    automationId: v.string(),
    status: v.optional(v.union(v.literal("new"), v.literal("reported"), v.literal("archived"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let q;
    if (args.status) {
      q = ctx.db
        .query("researchFindings")
        .withIndex("by_status", (qb) =>
          qb.eq("automationId", args.automationId).eq("status", args.status!),
        );
    } else {
      q = ctx.db
        .query("researchFindings")
        .withIndex("by_automation", (qb) => qb.eq("automationId", args.automationId));
    }
    const results = await q.order("desc").take(args.limit ?? 50);
    return results;
  },
});
```

- [ ] **Step 2: Verify deployment**

Run: `npx convex dev --once --typecheck=disable`
Expected: Deploys successfully

- [ ] **Step 3: Commit**

```bash
git add convex/researchFindings.ts
git commit -m "feat: add researchFindings Convex mutations and queries"
```

---

### Task 3: Create `server/tools/research-tools.ts`

**Files:**
- Create: `server/tools/research-tools.ts`

- [ ] **Step 1: Create the directory and file**

```bash
mkdir -p server/tools
```

```typescript
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createHash } from "node:crypto";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Strip tracking parameters from a URL, preserving path and meaningful params.
 */
function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const trackingPrefixes = ["utm_", "mc_"];
    const trackingExact = new Set(["ref", "source", "fbclid", "gclid"]);
    const toDelete: string[] = [];
    for (const key of url.searchParams.keys()) {
      if (trackingExact.has(key)) {
        toDelete.push(key);
      } else if (trackingPrefixes.some((p) => key.startsWith(p))) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      url.searchParams.delete(key);
    }
    // Remove trailing empty search
    let result = url.toString();
    if (result.endsWith("?")) result = result.slice(0, -1);
    return result;
  } catch {
    return raw;
  }
}

/**
 * Generate a content hash from the structured data JSON.
 * Keys are sorted so field order doesn't affect the hash.
 */
function contentHash(dataJson: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(dataJson);
  } catch {
    // If not valid JSON, hash the raw string
    return createHash("sha256").update(dataJson).digest("hex");
  }
  const sorted = Object.keys(parsed)
    .sort()
    .reduce(
      (acc, key) => {
        acc[key] = parsed[key];
        return acc;
      },
      {} as Record<string, unknown>,
    );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export function createResearchMcp(automationId: string) {
  return createSdkMcpServer({
    name: "boop-research",
    version: "0.1.0",
    tools: [
      tool(
        "check_findings",
        `Check if URLs or content have already been recorded as findings for this automation. Call this BEFORE reporting results to avoid duplicates.`,
        {
          urls: z
            .array(z.string())
            .optional()
            .describe("URLs to check against known findings"),
          contentHash: z
            .string()
            .optional()
            .describe("Content hash to check (optional — usually you check by URL first)"),
        },
        async (args) => {
          const normalizedUrls = (args.urls ?? []).map(normalizeUrl);
          let known: { findingId: string; url: string; title: string; foundAt: number }[] = [];

          if (normalizedUrls.length > 0) {
            const result = await convex.query(api.researchFindings.checkUrls, {
              urls: normalizedUrls,
            });
            known = result.known;
          }

          if (args.contentHash) {
            const hashResult = await convex.query(api.researchFindings.checkHash, {
              contentHash: args.contentHash,
            });
            if (hashResult.found) {
              const alreadyListed = known.some((k) => k.findingId === hashResult.findingId);
              if (!alreadyListed) {
                known.push({
                  findingId: hashResult.findingId!,
                  url: hashResult.url!,
                  title: hashResult.title!,
                  foundAt: 0,
                });
              }
            }
          }

          if (known.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No duplicates found — all URLs are new." }],
            };
          }
          const lines = known.map(
            (k) => `• [${k.findingId}] "${k.title}" — ${k.url}`,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${known.length} already-known finding(s):\n${lines.join("\n")}\n\nSkip these in your report.`,
              },
            ],
          };
        },
      ),

      tool(
        "save_finding",
        `Save a new research finding. Call this for each genuinely NEW item you want to report. The data field must be a JSON string matching the automation's schema.`,
        {
          url: z.string().describe("Source URL of the finding"),
          title: z.string().describe("Human-readable title/headline"),
          data: z
            .string()
            .describe(
              "JSON string with structured data matching the automation's dataSchema",
            ),
          tags: z
            .array(z.string())
            .optional()
            .describe("Optional category/topic tags"),
          conversationId: z
            .string()
            .optional()
            .describe("Conversation this finding relates to"),
        },
        async (args) => {
          const normalizedUrl = normalizeUrl(args.url);
          const hash = contentHash(args.data);
          const findingId = randomId("finding");

          const result = await convex.mutation(api.researchFindings.save, {
            findingId,
            automationId,
            url: normalizedUrl,
            contentHash: hash,
            title: args.title,
            data: args.data,
            tags: args.tags,
            conversationId: args.conversationId,
          });

          if (!result.saved) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Duplicate — this finding already exists (${result.reason}, existing: ${result.existingId}). Skip it.`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `Saved finding ${findingId}: "${args.title}"`,
              },
            ],
          };
        },
      ),
    ],
  });
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit --skipLibCheck server/tools/research-tools.ts`
Expected: No errors (or only pre-existing Convex generated types errors)

- [ ] **Step 3: Commit**

```bash
git add server/tools/research-tools.ts
git commit -m "feat: add research MCP tools (check_findings, save_finding)"
```

---

### Task 4: Update `convex/automations.ts` to accept `dataSchema`

**Files:**
- Modify: `convex/automations.ts`

- [ ] **Step 1: Add `dataSchema` to the create mutation args**

In `convex/automations.ts`, add to the `create` mutation args (after `nextRunAt`):

```typescript
    dataSchema: v.optional(v.string()),
```

- [ ] **Step 2: Add `dataSchema` to the `get` query return**

No change needed — `get` already returns the full document.

- [ ] **Step 3: Commit**

```bash
git add convex/automations.ts
git commit -m "feat: accept dataSchema in automation create mutation"
```

---

### Task 5: Update `server/automation-tools.ts` — add `dataSchema` to `create_automation`

**Files:**
- Modify: `server/automation-tools.ts`

- [ ] **Step 1: Add `dataSchema` parameter to the `create_automation` tool**

In `server/automation-tools.ts`, add after the `notify` parameter (around line 53):

```typescript
          dataSchema: z
            .string()
            .optional()
            .describe(
              "JSON string defining the schema for structured research findings. Example: '{\"company\":\"string\",\"amount\":\"string\",\"date\":\"string\"}'. When set, the execution agent gets research dedup tools and will store findings in this format.",
            ),
```

- [ ] **Step 2: Pass `dataSchema` to the Convex mutation**

In the handler, update the `convex.mutation(api.automations.create, {...})` call to include:

```typescript
            dataSchema: args.dataSchema,
```

Add it after `nextRunAt` in the object passed to `api.automations.create`.

- [ ] **Step 3: Commit**

```bash
git add server/automation-tools.ts
git commit -m "feat: add dataSchema param to create_automation tool"
```

---

### Task 6: Update `server/execution-agent.ts` — mount research tools + system prompt

**Files:**
- Modify: `server/execution-agent.ts`

- [ ] **Step 1: Add import for research tools**

Add at the top of the file:

```typescript
import { createResearchMcp } from "./tools/research-tools.js";
```

- [ ] **Step 2: Add `automationId` and `dataSchema` to `SpawnOptions`**

Update the interface:

```typescript
export interface SpawnOptions {
  task: string;
  integrations: string[];
  conversationId?: string;
  name?: string;
  automationId?: string;
  dataSchema?: string;
}
```

- [ ] **Step 3: Mount research MCP server when `dataSchema` is present**

In `spawnExecutionAgent`, after building `mcpServers` (around line 125-128), add:

```typescript
  if (opts.dataSchema && opts.automationId) {
    const researchServer = createResearchMcp(opts.automationId);
    mcpServers["boop-research"] = researchServer;
  }
```

- [ ] **Step 4: Update `EXECUTION_SYSTEM` prompt**

Append to the end of the `EXECUTION_SYSTEM` string (before the closing backtick):

```typescript
`

Research dedup rules (when boop-research tools are available):
- BEFORE reporting findings, call check_findings with the URLs you collected.
- Skip anything that already exists in the findings table.
- For each NEW finding, call save_finding with structured data matching the
  automation's dataSchema (provided in your task description).
- Only include genuinely new findings in your response to the user.
- Start your response with "[N new findings]" when you found new items, or
  "[No new findings]" when everything was already known.`
```

- [ ] **Step 5: Commit**

```bash
git add server/execution-agent.ts
git commit -m "feat: mount research MCP tools on execution agents with dataSchema"
```

---

### Task 7: Update `server/automations.ts` — pass schema to execution agent

**Files:**
- Modify: `server/automations.ts`

- [ ] **Step 1: Add `dataSchema` to the `runAutomation` parameter type**

Update the function signature parameter type to include:

```typescript
  dataSchema?: string;
```

- [ ] **Step 2: Include schema in the task prompt and pass to `spawnExecutionAgent`**

Change the `spawnExecutionAgent` call (around line 57):

```typescript
    const schemaNote = a.dataSchema
      ? `\n\nDATA SCHEMA (save findings in this format): ${a.dataSchema}`
      : "";
    const res = await spawnExecutionAgent({
      task: `AUTOMATION "${a.name}": ${a.task}${schemaNote}`,
      integrations: a.integrations,
      conversationId: a.conversationId,
      name: `auto:${a.name}`,
      automationId: a.automationId,
      dataSchema: a.dataSchema,
    });
```

- [ ] **Step 3: Pass `dataSchema` in `tickAutomations`**

In the `tickAutomations` function where `runAutomation` is called (around line 110-119), add `dataSchema` to the object:

```typescript
    runAutomation({
      automationId: a.automationId,
      name: a.name,
      task: a.task,
      integrations: a.integrations,
      schedule: a.schedule,
      timezone: a.timezone,
      conversationId: a.conversationId,
      notifyConversationId: a.notifyConversationId,
      dataSchema: a.dataSchema,
    }).catch((err) => console.error("[automations] run error", err));
```

- [ ] **Step 4: Commit**

```bash
git add server/automations.ts
git commit -m "feat: pass dataSchema through automation runner to execution agent"
```

---

### Task 8: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: No new errors (only pre-existing Convex generated types errors)

- [ ] **Step 2: Deploy Convex schema**

Run: `npx convex dev --once --typecheck=disable`
Expected: Deploys successfully with new table

- [ ] **Step 3: Verify no import errors**

Run: `npx tsx --eval "import './server/tools/research-tools.js'"`
Expected: No crash (may warn about missing token, that's fine)

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "chore: fix any remaining issues from research dedup integration"
```

(Only if previous steps found issues)
