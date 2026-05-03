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
