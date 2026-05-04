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

import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { embed, embeddingsAvailable } from "../embeddings.js";
import { spawnExecutionAgent } from "../execution-agent.js";
import { DEFAULT_DECAY, SEGMENT_PREFERRED_TIER, makeMemoryId } from "../memory/types.js";
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
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keywords or topic to search for.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default 10).",
            default: 10,
          },
        },
        required: ["query"],
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
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The fact to remember, in one clear sentence.",
          },
          segment: {
            type: "string",
            enum: ["identity", "preference", "relationship", "project", "knowledge", "context"],
            description:
              "identity: core facts about who they are. preference: how they like things done. relationship: people they know. project: ongoing work. knowledge: facts about their world. context: current situation.",
          },
          importance: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "0-1; how critical to retain.",
          },
          tier: {
            type: "string",
            enum: ["short", "long", "permanent"],
            description: "Override the default tier for this segment.",
          },
          supersedes: {
            type: "array",
            items: { type: "string" },
            description: "memoryId(s) this replaces (will be archived).",
          },
        },
        required: ["content", "segment", "importance"],
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
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "Crisp task description — what to find/draft/do, not the raw user message.",
          },
          integrations: {
            type: "array",
            items: { type: "string" },
            description: "Which integrations to give the agent.",
          },
          name: {
            type: "string",
            description: "Short label for the agent.",
          },
        },
        required: ["task", "integrations"],
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
        type: "object",
        properties: {
          enabledOnly: {
            type: "boolean",
            description: "If true, only return enabled automations.",
            default: false,
          },
        },
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
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "1 short sentence ack. No markdown. Emojis OK.",
          },
        },
        required: ["message"],
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

    // TODO: create_automation — needs describeUserNow, validateSchedule, nextRunFor
    // TODO: toggle_automation — calls api.automations.setEnabled
    // TODO: delete_automation — calls api.automations.remove
    // TODO: list_drafts       — calls api.drafts.pendingByConversation
    // TODO: send_draft        — calls api.drafts.setStatus + spawnExecutionAgent
    // TODO: reject_draft      — calls api.drafts.setStatus
    // TODO: get_config        — reads runtime model, timezone, integrations
    // TODO: set_model         — calls setRuntimeModel
    // TODO: set_timezone      — calls setUserTimezone
    // TODO: list_integrations — calls listConnectedToolkits
    // TODO: search_composio_catalog — calls listToolkitMeta
    // TODO: inspect_toolkit   — calls listToolkitMeta + listToolsForToolkit
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function buildExecutionTools(
  _conversationId: string,
  _integrations: string[],
): ToolDefinition[] {
  // TODO: Mount Composio integration tools once a ToolDefinition adapter exists.
  // TODO: Add save_draft tool mirroring createDraftStagingMcp for execution agents.
  return [];
}
