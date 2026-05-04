import { z } from "zod";
import { createHash } from "node:crypto";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import type { ToolSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// researchQueryTools — read-only, mounted on all execution agents
// ---------------------------------------------------------------------------

export const researchQueryTools: ToolSpec[] = [
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
];

// ---------------------------------------------------------------------------
// researchDedupTools — dedup tools requiring ctx.automationId
// ---------------------------------------------------------------------------

export const researchDedupTools: ToolSpec[] = [
  {
    name: "check_findings",
    description:
      "Check if URLs or content have already been recorded as findings for this automation. Call this BEFORE reporting results to avoid duplicates.",
    schema: {
      urls: z
        .array(z.string())
        .optional()
        .describe("URLs to check against known findings"),
      contentHash: z
        .string()
        .optional()
        .describe("Content hash to check (optional — usually you check by URL first)"),
    },
    handler: async (args) => {
      const normalizedUrls = ((args.urls ?? []) as string[]).map(normalizeUrl);
      let known: { findingId: string; url: string; title: string; foundAt: number }[] = [];

      if (normalizedUrls.length > 0) {
        const result = await convex.query(api.researchFindings.checkUrls, {
          urls: normalizedUrls,
        });
        known = result.known;
      }

      if (args.contentHash) {
        const hashResult = await convex.query(api.researchFindings.checkHash, {
          contentHash: args.contentHash as string,
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
        return "No duplicates found — all URLs are new.";
      }
      const lines = known.map((k) => `• [${k.findingId}] "${k.title}" — ${k.url}`);
      return `Found ${known.length} already-known finding(s):\n${lines.join("\n")}\n\nSkip these in your report.`;
    },
  },

  {
    name: "save_finding",
    description:
      "Save a new research finding. Call this for each genuinely NEW item you want to report. The data field must be a JSON string matching the automation's schema.",
    schema: {
      url: z.string().describe("Source URL of the finding"),
      title: z.string().describe("Human-readable title/headline"),
      data: z
        .string()
        .describe("JSON string with structured data matching the automation's dataSchema"),
      tags: z.array(z.string()).optional().describe("Optional category/topic tags"),
      conversationId: z
        .string()
        .optional()
        .describe("Conversation this finding relates to"),
    },
    handler: async (args, ctx) => {
      const automationId = ctx.automationId!;
      const normalizedUrl = normalizeUrl(args.url as string);
      const hash = contentHash(args.data as string);
      const findingId = randomId("finding");

      const result = await convex.mutation(api.researchFindings.save, {
        findingId,
        automationId,
        url: normalizedUrl,
        contentHash: hash,
        title: args.title as string,
        data: args.data as string,
        tags: args.tags as string[] | undefined,
        conversationId: args.conversationId as string | undefined,
      });

      if (!result.saved) {
        return `Duplicate — this finding already exists (${result.reason}, existing: ${result.existingId}). Skip it.`;
      }
      return `Saved finding ${findingId}: "${args.title}"`;
    },
  },
];
