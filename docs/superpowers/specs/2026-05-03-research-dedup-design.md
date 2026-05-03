# Research Findings Dedup Design

**Date:** 2026-05-03  
**Status:** Approved  
**Scope:** Add structured research dedup to prevent automation agents from re-reporting known findings

## Context

Boop's automation system can run recurring research tasks (e.g., "every morning, find new AI funding rounds"). Without dedup, each run reports everything it finds — including items already surfaced in previous runs. This design adds a Convex table for structured findings storage and MCP tools so execution agents can check for duplicates and save new findings.

## Decisions

- **Single shared table** — one `researchFindings` table with `automationId` to filter, enables cross-automation dedup
- **User-defined JSON schema** — users describe what fields to track in natural language; the dispatcher generates a JSON schema and confirms; stored on the automation record
- **Dedup by URL + content hash** — same URL (normalized, tracking params stripped) OR same content hash = duplicate
- **Agent tool approach** — execution agents get `check_findings` and `save_finding` MCP tools; system prompt enforces usage
- **URL normalization** — full URL with path, stripped of tracking params (`utm_*`, `ref`, `source`, `fbclid`, `gclid`, `mc_*`)

## Convex Table: `researchFindings`

```typescript
researchFindings: defineTable({
  findingId: v.string(),
  automationId: v.string(),
  conversationId: v.optional(v.string()),
  url: v.string(),
  contentHash: v.string(),
  title: v.string(),
  data: v.string(),   // JSON blob matching the automation's dataSchema
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
  .index("by_status", ["automationId", "status"])
```

## Schema Storage on Automations Table

Add a new optional field to the existing `automations` table:

```typescript
dataSchema: v.optional(v.string()),  // JSON string describing the expected fields
```

Example value: `{"company":"string","amount":"string","roundType":"string","date":"string","leadInvestors":"string[]"}`

## MCP Tools: `server/tools/research-tools.ts`

### `check_findings`

**Purpose:** Query for duplicates before reporting.

**Input:**
```typescript
{
  automationId: string,
  urls?: string[],       // check if any of these URLs are already known
  contentHash?: string   // check if this content hash exists
}
```

**Behavior:**
1. Normalizes each URL (strip tracking params)
2. Queries `researchFindings` by URL index and/or content hash index
3. Returns list of matching findings (so the agent knows what to skip)

**Output:**
```typescript
{
  known: [{ findingId, url, title, foundAt }]  // already stored
}
```

### `save_finding`

**Purpose:** Persist a new finding after research.

**Input:**
```typescript
{
  automationId: string,
  url: string,
  title: string,
  data: string,           // JSON string matching the automation's dataSchema
  tags?: string[],
  conversationId?: string
}
```

**Behavior:**
1. Normalizes URL (strips tracking params)
2. Generates `contentHash` — SHA-256 of sorted key+value pairs from `data`
3. Checks for existing match (URL OR content hash)
4. If duplicate: returns `{ saved: false, reason: "duplicate", existingId }`
5. If new: inserts row with `status: "new"`, returns `{ saved: true, findingId }`

**Output:**
```typescript
{ saved: true, findingId: string }
// or
{ saved: false, reason: "duplicate", existingId: string }
```

## URL Normalization

Strips these query parameters before storing/comparing:
- `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` (all `utm_*`)
- `ref`, `source`, `fbclid`, `gclid`, `mc_cid`, `mc_eid` (all `mc_*`)

Preserves path and meaningful params (e.g., `?page=2`, `?id=123`).

## Content Hash

SHA-256 of the `data` JSON blob with keys sorted alphabetically. This ensures:
- Same entity from different URLs matches (e.g., same funding round reported by TechCrunch and Bloomberg)
- Minor differences in non-key fields (like description wording) still match on the core structured data

## Agent Integration

### Execution Agent System Prompt Addition

Append to `EXECUTION_SYSTEM` in `server/execution-agent.ts`:

```
Research dedup rules (when research tools are available):
- BEFORE reporting findings, call check_findings with the URLs you collected.
- Skip anything that already exists in the findings table.
- For each NEW finding, call save_finding with structured data matching the
  automation's schema. The schema is provided in your task description.
- Only include genuinely new findings in your response to the user.
- After saving, mark your response clearly: "[N new findings]" at the top.
```

### Automation Schema Flow

1. User messages: "Set up automation: research X. Track: field1, field2, field3"
2. Dispatcher generates JSON schema from the natural language description
3. Dispatcher confirms with user: "I'll track: field1, field2, field3. Correct?"
4. User confirms → `dataSchema` stored on the automation record
5. When automation runs, the task prompt includes the schema so the agent knows the format
6. Execution agent is given the `boop-research` MCP server (only when `dataSchema` is set)

### Tool Mounting

In `server/execution-agent.ts`, when spawning for an automation with `dataSchema`:

```typescript
const researchServer = createResearchMcp(automationId);
mcpServers["boop-research"] = researchServer;
```

## Convex Functions

### `convex/researchFindings.ts`

**Mutations:**
- `researchFindings.save` — insert a new finding (with dupe check)
- `researchFindings.markReported` — update status to "reported" + set `reportedAt`
- `researchFindings.archive` — update status to "archived"

**Queries:**
- `researchFindings.checkUrls` — given a list of URLs, return any matches
- `researchFindings.checkHash` — given a content hash, return match if exists
- `researchFindings.listByAutomation` — list findings for an automation (paginated, filterable by status)

## Files Summary

| Action | File |
|--------|------|
| Create | `server/tools/research-tools.ts` |
| Create | `convex/researchFindings.ts` |
| Modify | `convex/schema.ts` — add `researchFindings` table + `dataSchema` field on `automations` |
| Modify | `server/execution-agent.ts` — mount research MCP server + system prompt update |
| Modify | `server/automation-tools.ts` — add `dataSchema` to automation creation |

## Setup for Users

No additional configuration needed. Once an automation has a `dataSchema`, the research tools are automatically available to its execution agents. Users define the schema by describing fields when creating an automation via Telegram.
