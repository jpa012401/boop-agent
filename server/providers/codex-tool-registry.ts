/**
 * Codex Tool Registry
 *
 * Builds ToolDefinition arrays for the Codex MCP server, mirroring the tools
 * defined in the Boop interaction agent and execution agent. Since Codex cannot
 * mount in-process MCP servers, these definitions are registered via
 * `registerToolsForCodex()` so they are served over the HTTP MCP endpoint.
 *
 * v1 skeleton — core interaction tools only. Additional tools (draft decisions,
 * self-config, etc.) are marked TODO and can be ported incrementally.
 */

import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import {
  CURATED_TOOLKITS,
  listConnectedToolkits,
  listToolkitMeta,
  listToolsForToolkit,
} from "../composio.js";
import { embed, embeddingsAvailable } from "../embeddings.js";
import { availableIntegrations, spawnExecutionAgent } from "../execution-agent.js";
import { activeProvider as activeEmbeddingProvider } from "../embeddings.js";
import { DEFAULT_DECAY, SEGMENT_PREFERRED_TIER, makeMemoryId } from "../memory/types.js";
import { nextRunFor, validateSchedule } from "../automations.js";
import {
  PROVIDER_MODELS,
  PROVIDER_MODEL_ALIASES,
  getRuntimeModel,
  resolveModelInput,
  setRuntimeModel,
} from "../runtime-config.js";
import { getProviderName } from "./index.js";
import {
  describeUserNow,
  resolveTimezoneInput,
  setUserTimezone,
} from "../timezone-config.js";
import type { ToolDefinition } from "./codex-mcp-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Interaction-layer tools
// ---------------------------------------------------------------------------

/**
 * Build the tool definitions exposed to a Codex interaction-layer session.
 *
 * Mirrors the tools available in the Claude SDK-based interaction agent:
 *   - recall / write_memory   (memory MCP)
 *   - spawn_agent             (spawn MCP)
 *   - list_automations        (automation MCP — read-only for now)
 *   - send_ack                (ack MCP)
 *
 * TODO: create_automation, toggle_automation, delete_automation
 * TODO: list_drafts, send_draft, reject_draft  (draft-decision MCP)
 * TODO: get_config, set_model, set_timezone, list_integrations,
 *       search_composio_catalog, inspect_toolkit  (self MCP)
 */
/**
 * Resolve the default conversationId for Codex tools. Since Boop is single-user,
 * we derive it from BOOP_USER_CHAT_ID (the Telegram chat ID).
 */
export function defaultConversationId(): string {
  const chatId = process.env.BOOP_USER_CHAT_ID;
  return chatId ? `telegram:${chatId}` : "codex:default";
}

export function buildInteractionTools(conversationId?: string): ToolDefinition[] {
  const convId = conversationId ?? defaultConversationId();
  return [
    // -------------------------------------------------------------------------
    // recall
    // -------------------------------------------------------------------------
    {
      name: "recall",
      description:
        "Search your memories for anything relevant to the current turn. Call this early in any conversation that touches the user's preferences, projects, or past decisions.",
      schema: {
        query: z.string().describe("Keywords or topic to search for."),
        limit: z.number().optional().default(10).describe("Maximum number of results to return (default 10)."),
      },
      handler: async (args) => {
        const query = args.query as string;
        const limit = typeof args.limit === "number" ? args.limit : 10;

        let results: Array<Record<string, unknown>> = [];
        let mode: "vector" | "substring" = "substring";

        if (embeddingsAvailable()) {
          const queryVec = await embed(query);
          if (queryVec) {
            const hits = await convex.action(api.memoryRecords.vectorSearch, {
              embedding: queryVec,
              limit,
            });
            results = hits.map((h) => h.record as Record<string, unknown>);
            mode = "vector";
          }
        }

        if (results.length === 0) {
          results = (await convex.query(api.memoryRecords.search, {
            query,
            limit,
          })) as Array<Record<string, unknown>>;
        }

        for (const r of results) {
          await convex.mutation(api.memoryRecords.markAccessed, {
            memoryId: r.memoryId as string,
          });
        }

        await convex.mutation(api.memoryEvents.emit, {
          eventType: "memory.recalled",
          conversationId: convId,
          data: JSON.stringify({ query, hits: results.length, mode }),
        });

        if (results.length === 0) {
          return "No memories matched.";
        }

        return results
          .map(
            (r) =>
              `• [${r.tier}/${r.segment} importance=${(r.importance as number).toFixed(2)}] ${r.memoryId}: ${r.content}`,
          )
          .join("\n");
      },
    },

    // -------------------------------------------------------------------------
    // write_memory
    // -------------------------------------------------------------------------
    {
      name: "write_memory",
      description:
        "Persist a fact about the user or conversation that you want available in future turns. Prefer aggressive writing — memory is cheap, forgetting is expensive. Only use for durable facts (preferences, identity, projects, relationships), NOT for transient conversational state.",
      schema: {
        content: z.string().describe("The fact to remember, in one clear sentence."),
        segment: z.enum(["identity", "preference", "relationship", "project", "knowledge", "context"]).describe("identity: core facts about who they are. preference: how they like things done. relationship: people they know. project: ongoing work. knowledge: facts about their world. context: current situation."),
        importance: z.number().min(0).max(1).describe("0-1; how critical to retain."),
        tier: z.enum(["short", "long", "permanent"]).optional().describe("Override the default tier for this segment."),
        supersedes: z.array(z.string()).optional().describe("memoryId(s) this replaces (will be archived)."),
      },
      handler: async (args) => {
        const segment = args.segment as keyof typeof SEGMENT_PREFERRED_TIER;
        const tier =
          (args.tier as "short" | "long" | "permanent" | undefined) ??
          SEGMENT_PREFERRED_TIER[segment];
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
          conversationId: convId,
          memoryId,
          data: JSON.stringify({
            tier,
            segment,
            importance: args.importance,
          }),
        });

        return `Stored ${memoryId} (tier=${tier}, segment=${segment}).`;
      },
    },

    // -------------------------------------------------------------------------
    // spawn_agent
    // -------------------------------------------------------------------------
    {
      name: "spawn_agent",
      description:
        "Spawn a focused sub-agent to do real work using external tools. Returns the agent's final answer. Use for anything requiring lookups, drafting, or actions in the user's integrations.",
      schema: {
        task: z.string().describe("Crisp task description — what to find/draft/do, not the raw user message."),
        integrations: z.array(z.string()).describe("Which integrations to give the agent."),
        name: z.string().optional().describe("Short label for the agent."),
      },
      handler: async (args) => {
        const res = await spawnExecutionAgent({
          task: args.task as string,
          integrations: args.integrations as string[],
          conversationId: convId,
          name: args.name as string | undefined,
        });
        return `[agent ${res.agentId} ${res.status}]\n\n${res.result}`;
      },
    },

    // -------------------------------------------------------------------------
    // list_automations
    // -------------------------------------------------------------------------
    {
      name: "list_automations",
      description: "List all automations for this conversation.",
      schema: {
        enabledOnly: z.boolean().optional().default(false).describe("If true, only return enabled automations."),
      },
      handler: async (args) => {
        const enabledOnly =
          typeof args.enabledOnly === "boolean" ? args.enabledOnly : false;
        const all = await convex.query(api.automations.list, { enabledOnly });
        const mine = all.filter(
          (a: Record<string, unknown>) => a.conversationId === convId,
        );
        if (mine.length === 0) {
          return "No automations.";
        }
        return mine
          .map(
            (a: Record<string, unknown>) =>
              `• [${a.automationId}] ${a.enabled ? "●" : "○"} "${a.name}" — ${a.schedule} — ${a.task}`,
          )
          .join("\n");
      },
    },

    // -------------------------------------------------------------------------
    // send_ack
    // -------------------------------------------------------------------------
    {
      name: "send_ack",
      description:
        'Send a short acknowledgment message to the user IMMEDIATELY, before a slow operation. Use this BEFORE spawn_agent so the user knows you heard them and are working on it. Keep it to ONE short sentence (ideally under 60 chars). Examples: "On it — one sec 🔍", "Looking into it…", "Drafting now, hold tight."',
      schema: {
        message: z.string().describe("1 short sentence ack. No markdown. Emojis OK."),
      },
      handler: async (args) => {
        const text = (args.message as string).trim();
        if (!text) {
          return "Empty ack skipped.";
        }

        const turnId = randomId("turn");
        await convex.mutation(api.messages.send, {
          conversationId: convId,
          role: "assistant",
          content: text,
          turnId,
        });

        return "Ack sent to user.";
      },
    },

    // -------------------------------------------------------------------------
    // create_automation
    // -------------------------------------------------------------------------
    {
      name: "create_automation",
      description:
        "Schedule a recurring task. Cron expressions use 5 fields (min hour dom month dow). Write times in the user's LOCAL clock — the runner attaches the stored timezone automatically.",
      schema: {
        name: z.string().describe("Short label, e.g. 'morning email digest'."),
        schedule: z.string().describe("Cron expression (5 fields)."),
        task: z.string().describe("Specific task for the sub-agent."),
        integrations: z.array(z.string()).optional().default([]).describe("Integration names the sub-agent needs."),
        notify: z.boolean().optional().default(true).describe("Send result to this conversation when it runs."),
        dataSchema: z.string().optional().describe("JSON string defining schema for structured research findings."),
      },
      handler: async (args) => {
        const tzInfo = await describeUserNow();
        const timezone = tzInfo.timezone;
        const validation = validateSchedule(args.schedule as string, timezone);
        if (!validation.valid) return `Invalid cron expression: ${validation.error}`;
        const automationId = randomId("auto");
        const nextRunAt = nextRunFor(args.schedule as string, timezone) ?? undefined;
        await convex.mutation(api.automations.create, {
          automationId,
          name: args.name as string,
          task: args.task as string,
          integrations: (args.integrations as string[]) ?? [],
          schedule: args.schedule as string,
          timezone,
          conversationId: convId,
          notifyConversationId: args.notify ? convId : undefined,
          nextRunAt,
          dataSchema: args.dataSchema as string | undefined,
        });
        const nextStr = nextRunAt
          ? new Intl.DateTimeFormat("en-US", {
              timeZone: timezone, weekday: "short", month: "short", day: "numeric",
              hour: "numeric", minute: "2-digit", timeZoneName: "short",
            }).format(new Date(nextRunAt))
          : "unknown";
        return `Created automation ${automationId} "${args.name}" — next run: ${nextStr} (timezone: ${timezone}).`;
      },
    },

    // -------------------------------------------------------------------------
    // toggle_automation
    // -------------------------------------------------------------------------
    {
      name: "toggle_automation",
      description: "Enable or disable an automation by id.",
      schema: {
        automationId: z.string(),
        enabled: z.boolean(),
      },
      handler: async (args) => {
        const id = await convex.mutation(api.automations.setEnabled, {
          automationId: args.automationId as string,
          enabled: args.enabled as boolean,
        });
        return id ? `Set ${args.automationId} enabled=${args.enabled}.` : "Not found.";
      },
    },

    // -------------------------------------------------------------------------
    // delete_automation
    // -------------------------------------------------------------------------
    {
      name: "delete_automation",
      description: "Permanently remove an automation.",
      schema: { automationId: z.string() },
      handler: async (args) => {
        const id = await convex.mutation(api.automations.remove, {
          automationId: args.automationId as string,
        });
        return id ? `Deleted ${args.automationId}.` : "Not found.";
      },
    },

    // -------------------------------------------------------------------------
    // list_drafts
    // -------------------------------------------------------------------------
    {
      name: "list_drafts",
      description: "List pending drafts in this conversation.",
      schema: {},
      handler: async () => {
        const drafts = await convex.query(api.drafts.pendingByConversation, {
          conversationId: convId,
        });
        if (drafts.length === 0) return "No pending drafts.";
        return drafts.map((d: Record<string, unknown>) =>
          `• [${d.draftId}] (${d.kind}) ${d.summary}`,
        ).join("\n");
      },
    },

    // -------------------------------------------------------------------------
    // send_draft
    // -------------------------------------------------------------------------
    {
      name: "send_draft",
      description: "Approve and execute a draft. Spawns an execution agent to perform the action.",
      schema: {
        draftId: z.string(),
        integrations: z.array(z.string()).describe("Which integrations the execution agent needs."),
      },
      handler: async (args) => {
        const draft = await convex.query(api.drafts.get, { draftId: args.draftId as string });
        if (!draft || (draft as Record<string, unknown>).status !== "pending") {
          return `Draft ${args.draftId} not found or already decided.`;
        }
        await convex.mutation(api.drafts.setStatus, {
          draftId: args.draftId as string,
          status: "sent",
        });
        const d = draft as Record<string, unknown>;
        const task = `Execute this approved draft. Use the matching integration tool to actually send/create it.\nkind: ${d.kind}\nsummary: ${d.summary}\npayload JSON: ${d.payload}`;
        const res = await spawnExecutionAgent({
          task,
          integrations: args.integrations as string[],
          conversationId: convId,
          name: `send:${d.kind}`,
        });
        return `Draft ${args.draftId} executed.\n\n${res.result}`;
      },
    },

    // -------------------------------------------------------------------------
    // reject_draft
    // -------------------------------------------------------------------------
    {
      name: "reject_draft",
      description: "Cancel a pending draft.",
      schema: { draftId: z.string() },
      handler: async (args) => {
        await convex.mutation(api.drafts.setStatus, {
          draftId: args.draftId as string,
          status: "rejected",
        });
        return `Draft ${args.draftId} rejected.`;
      },
    },

    // -------------------------------------------------------------------------
    // get_config
    // -------------------------------------------------------------------------
    {
      name: "get_config",
      description: "Return Boop's runtime configuration: model, timezone, integrations, env info.",
      schema: {},
      handler: async () => {
        const integrations = availableIntegrations();
        const tzInfo = await describeUserNow();
        return JSON.stringify({
          provider: getProviderName(),
          model: await getRuntimeModel(),
          availableModels: [...(PROVIDER_MODELS[getProviderName()] ?? [])],
          userTimezone: tzInfo.isExplicit ? tzInfo.timezone : null,
          currentLocalTime: tzInfo.now,
          integrationsLoaded: integrations,
          composioEnabled: Boolean(process.env.COMPOSIO_API_KEY),
          embeddingsProvider: activeEmbeddingProvider(),
          telegramEnabled: Boolean(process.env.TELEGRAM_BOT_TOKEN),
        }, null, 2);
      },
    },

    // -------------------------------------------------------------------------
    // set_model
    // -------------------------------------------------------------------------
    {
      name: "set_model",
      description: "Switch the model used for the next turn. Accepts canonical ID or alias.",
      schema: {
        model: z.string().describe("Model canonical ID or alias."),
      },
      handler: async (args) => {
        const resolved = resolveModelInput(args.model as string);
        if (!resolved) {
          return `Unknown model "${args.model}". Try one of: ${[...(PROVIDER_MODELS[getProviderName()] ?? [])].join(", ")} or aliases ${Object.keys(PROVIDER_MODEL_ALIASES[getProviderName()] ?? {}).join(", ")}.`;
        }
        await setRuntimeModel(resolved);
        return `Model set to ${resolved}. Takes effect next turn.`;
      },
    },

    // -------------------------------------------------------------------------
    // set_timezone
    // -------------------------------------------------------------------------
    {
      name: "set_timezone",
      description: 'Save the user\'s timezone. Accepts IANA ID or alias ("central", "PT", "Dallas", etc.).',
      schema: {
        timezone: z.string().describe("IANA timezone or friendly alias."),
      },
      handler: async (args) => {
        const resolved = resolveTimezoneInput(args.timezone as string);
        if (!resolved) {
          return `"${args.timezone}" isn't a recognized timezone. Use IANA format like "America/Chicago" or an alias like "central".`;
        }
        await setUserTimezone(resolved);
        const tzInfo = await describeUserNow();
        return `Timezone set to ${resolved}. Local time: ${tzInfo.now}.`;
      },
    },

    // -------------------------------------------------------------------------
    // list_integrations
    // -------------------------------------------------------------------------
    {
      name: "list_integrations",
      description: "List currently connected integrations (Gmail, Slack, etc.) with account details.",
      schema: {},
      handler: async () => {
        const connected = await listConnectedToolkits();
        if (connected.length === 0) return "No integrations connected.";
        return JSON.stringify(connected.map((c) => ({
          slug: c.slug,
          status: c.status,
          account: c.accountLabel ?? c.accountEmail ?? c.alias ?? "(unknown)",
          connectionId: c.connectionId,
        })), null, 2);
      },
    },

    // -------------------------------------------------------------------------
    // search_composio_catalog
    // -------------------------------------------------------------------------
    {
      name: "search_composio_catalog",
      description: "Search Composio's toolkit catalog (1000+ services) by keyword.",
      schema: {
        query: z.string().describe("Keyword to search."),
        limit: z.number().optional().default(15).describe("Max results."),
      },
      handler: async (args) => {
        const meta = await listToolkitMeta();
        const q = (args.query as string).trim().toLowerCase();
        const limit = (args.limit as number) ?? 15;
        const matches: Array<{ slug: string; name: string; description?: string }> = [];
        for (const t of meta.values()) {
          if (`${t.slug} ${t.name} ${t.description ?? ""}`.toLowerCase().includes(q)) {
            matches.push({ slug: t.slug, name: t.name, description: t.description });
          }
          if (matches.length >= limit) break;
        }
        return matches.length === 0
          ? `No toolkits match "${args.query}".`
          : JSON.stringify(matches, null, 2);
      },
    },

    // -------------------------------------------------------------------------
    // inspect_toolkit
    // -------------------------------------------------------------------------
    {
      name: "inspect_toolkit",
      description: "Look up a specific Composio toolkit by slug. Shows status, connections, and optionally its tools.",
      schema: {
        slug: z.string().describe("Toolkit slug, e.g. 'gmail', 'slack'."),
        includeTools: z.boolean().optional().default(false).describe("If true, fetch tool list (slower)."),
      },
      handler: async (args) => {
        const lower = (args.slug as string).trim().toLowerCase();
        const meta = await listToolkitMeta();
        const toolkit = meta.get(lower);
        if (!toolkit) return `Toolkit "${lower}" not in catalog. Try search_composio_catalog.`;
        const connected = (await listConnectedToolkits()).filter((c) => c.slug === lower);
        const curated = CURATED_TOOLKITS.find((t) => t.slug === lower);
        const result: Record<string, unknown> = {
          slug: toolkit.slug, name: toolkit.name, description: toolkit.description,
          toolsCount: toolkit.toolsCount, inCuratedList: Boolean(curated),
          connections: connected.map((c) => ({
            status: c.status, account: c.accountLabel ?? c.accountEmail ?? "(unknown)", id: c.connectionId,
          })),
          availableForSpawn: availableIntegrations().includes(lower),
        };
        if (args.includeTools) {
          result.tools = await listToolsForToolkit(lower);
        }
        return JSON.stringify(result, null, 2);
      },
    }
  ];
}

// ---------------------------------------------------------------------------
// Execution-layer tools
// ---------------------------------------------------------------------------

/**
 * Build the tool definitions for a Codex execution-layer session.
 *
 * Codex has native web search and file tools, so this layer is intentionally
 * minimal. Composio integration tools can be added here incrementally once
 * the Composio → ToolDefinition adapter is built.
 *
 * @param _conversationId - Reserved for future use (e.g. draft staging).
 * @param _integrations   - Reserved for future Composio tool mounting.
 */
export function buildExecutionTools(
  _conversationId: string,
  _integrations: string[],
): ToolDefinition[] {
  // TODO: Mount Composio integration tools once a ToolDefinition adapter exists.
  // TODO: Add save_draft tool mirroring createDraftStagingMcp for execution agents.
  return [
    // -------------------------------------------------------------------------
    // list_research_findings — query saved research data
    // -------------------------------------------------------------------------
    {
      name: "list_research_findings",
      description:
        "List research findings saved by automations. Use this to look up previously discovered items — businesses, listings, articles, etc. — that Boop's research automations have found.",
      schema: {
        automationId: z.string().optional().describe("Filter by automation ID. Omit to search all."),
        limit: z.number().optional().default(20).describe("Max results to return (default 20)."),
      },
      handler: async (args) => {
        const automationId = args.automationId as string | undefined;
        const limit = typeof args.limit === "number" ? args.limit : 20;

        if (automationId) {
          const results = await convex.query(api.researchFindings.listByAutomation, {
            automationId,
            limit,
          });
          if (results.length === 0) return "No findings for this automation.";
          return results
            .map((r: Record<string, unknown>) =>
              `• [${r.findingId}] "${r.title}" — ${r.url}\n  Data: ${r.data}`,
            )
            .join("\n\n");
        }

        // No automationId — list all automations first, then pull findings from each
        const autos = await convex.query(api.automations.list, { enabledOnly: false });
        if (autos.length === 0) return "No automations found.";

        const allFindings: string[] = [];
        for (const auto of autos) {
          const autoId = auto.automationId as string;
          const results = await convex.query(api.researchFindings.listByAutomation, {
            automationId: autoId,
            limit: Math.ceil(limit / autos.length) || 5,
          });
          for (const r of results) {
            allFindings.push(
              `• [${r.findingId}] (${auto.name}) "${r.title}" — ${r.url}\n  Data: ${(r as Record<string, unknown>).data}`,
            );
          }
        }
        if (allFindings.length === 0) return "No research findings saved yet.";
        return allFindings.slice(0, limit).join("\n\n");
      },
    },

    // -------------------------------------------------------------------------
    // recall (also available in execution layer for context)
    // -------------------------------------------------------------------------
    {
      name: "recall",
      description:
        "Search Boop's memory for relevant context. Use this to find previously saved facts about the user, their projects, preferences, or past research.",
      schema: {
        query: z.string().describe("Keywords or topic to search for."),
        limit: z.number().optional().default(10).describe("Maximum results (default 10)."),
      },
      handler: async (args) => {
        const query = args.query as string;
        const limit = typeof args.limit === "number" ? args.limit : 10;

        let results: Array<Record<string, unknown>> = [];

        if (embeddingsAvailable()) {
          const queryVec = await embed(query);
          if (queryVec) {
            const hits = await convex.action(api.memoryRecords.vectorSearch, {
              embedding: queryVec,
              limit,
            });
            results = hits.map((h) => h.record as Record<string, unknown>);
          }
        }

        if (results.length === 0) {
          results = (await convex.query(api.memoryRecords.search, {
            query,
            limit,
          })) as Array<Record<string, unknown>>;
        }

        if (results.length === 0) return "No memories matched.";

        return results
          .map(
            (r) =>
              `• [${r.tier}/${r.segment}] ${r.memoryId}: ${r.content}`,
          )
          .join("\n");
      },
    },
  ];
}
