import { z } from "zod";
import {
  CURATED_TOOLKITS,
  listConnectedToolkits,
  listToolkitMeta,
  listToolsForToolkit,
} from "../composio.js";
import { availableIntegrations } from "../execution-agent.js";
import type { ToolSpec } from "./types.js";

export const integrationTools: ToolSpec[] = [
  {
    name: "list_integrations",
    description:
      "List the user's currently connected integrations (Gmail, Slack, etc.) with the actual account behind each connection. Use when the user asks 'what tools do I have connected?' or 'which Gmail account?' or 'what integrations are set up?'.",
    schema: {},
    handler: async (_args, _ctx) => {
      const connected = await listConnectedToolkits();
      const summary = connected.map((c) => ({
        slug: c.slug,
        status: c.status,
        account: c.accountLabel ?? c.accountEmail ?? c.alias ?? "(unknown)",
        connectionId: c.connectionId,
      }));
      if (summary.length === 0) {
        return "No integrations are currently connected. The user can connect new ones from the Connections panel in the debug UI.";
      }
      return JSON.stringify(summary, null, 2);
    },
  },
  {
    name: "search_composio_catalog",
    description:
      "Search Composio's full toolkit catalog (1000+ services) by keyword. Returns matching toolkit slugs and descriptions. Use when the user asks 'is there a tool for X?', 'can you connect to Y?', or 'is Z available?' — e.g. 'is there a Notion integration?', 'can you talk to Zendesk?'.",
    schema: {
      query: z
        .string()
        .describe("Keyword to match against toolkit slug, name, or description (case-insensitive)."),
      limit: z.number().int().min(1).max(50).optional().default(15),
    },
    handler: async (args, _ctx) => {
      const query = args.query as string;
      const limit = (args.limit as number | undefined) ?? 15;
      const meta = await listToolkitMeta();
      const q = query.trim().toLowerCase();
      const matches: Array<{ slug: string; name: string; description?: string; toolsCount?: number }> = [];
      for (const t of meta.values()) {
        const haystack = `${t.slug} ${t.name} ${t.description ?? ""}`.toLowerCase();
        if (haystack.includes(q)) {
          matches.push({
            slug: t.slug,
            name: t.name,
            description: t.description,
            toolsCount: t.toolsCount,
          });
        }
        if (matches.length >= limit) break;
      }
      if (matches.length === 0) {
        return `No toolkits in Composio's catalog match "${query}".`;
      }
      return JSON.stringify(matches, null, 2);
    },
  },
  {
    name: "inspect_toolkit",
    description:
      "Look up a specific Composio toolkit by exact slug. Returns whether it exists, whether it's currently connected, and (if requested) the list of tools it exposes. Use when the user asks 'what can the Slack tool do?' or 'is Notion connected?'.",
    schema: {
      slug: z
        .string()
        .describe("Exact toolkit slug, e.g. 'gmail', 'slack', 'notion', 'linear'. Lowercase."),
      includeTools: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, also fetch the toolkit's tool list (slower)."),
    },
    handler: async (args, _ctx) => {
      const slug = args.slug as string;
      const includeTools = (args.includeTools as boolean | undefined) ?? false;
      const lower = slug.trim().toLowerCase();
      const meta = await listToolkitMeta();
      const toolkit = meta.get(lower);
      if (!toolkit) {
        return `Toolkit "${lower}" is not in Composio's catalog. Try search_composio_catalog with a keyword to find similar ones.`;
      }
      const connected = (await listConnectedToolkits()).filter((c) => c.slug === lower);
      const curated = CURATED_TOOLKITS.find((t) => t.slug === lower);
      const result: {
        slug: string;
        name: string;
        description?: string;
        toolsCount?: number;
        inCuratedList: boolean;
        authMode?: string;
        connections: Array<{ status: string; account: string; id: string }>;
        availableForSpawn: boolean;
        tools?: Array<{ slug: string; name: string; description?: string }>;
      } = {
        slug: toolkit.slug,
        name: toolkit.name,
        description: toolkit.description,
        toolsCount: toolkit.toolsCount,
        inCuratedList: Boolean(curated),
        authMode: curated?.authMode,
        connections: connected.map((c) => ({
          status: c.status,
          account: c.accountLabel ?? c.accountEmail ?? c.alias ?? "(unknown)",
          id: c.connectionId,
        })),
        availableForSpawn: availableIntegrations().includes(lower),
      };
      if (includeTools) {
        result.tools = await listToolsForToolkit(lower);
      }
      return JSON.stringify(result, null, 2);
    },
  },
];
