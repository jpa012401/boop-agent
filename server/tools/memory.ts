import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { embed, embeddingsAvailable } from "../embeddings.js";
import { DEFAULT_DECAY, SEGMENT_PREFERRED_TIER, makeMemoryId } from "../memory/types.js";
import type { ToolSpec, ToolContext } from "./types.js";

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
      supersedes: z
        .array(z.string())
        .optional()
        .describe("memoryId(s) this replaces (will be archived)."),
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
      const segment = args.segment as z.infer<typeof segmentEnum>;
      const tier = (args.tier as z.infer<typeof tierEnum> | undefined) ?? SEGMENT_PREFERRED_TIER[segment];
      const content = args.content as string;
      const importance = args.importance as number;
      const supersedes = args.supersedes as string[] | undefined;

      const memoryId = makeMemoryId();
      const embedding = (await embed(content)) ?? undefined;
      await convex.mutation(api.memoryRecords.upsert, {
        memoryId,
        content,
        tier,
        segment,
        importance,
        decayRate: DEFAULT_DECAY[tier],
        supersedes,
        embedding,
      });
      await convex.mutation(api.memoryEvents.emit, {
        eventType: "memory.written",
        conversationId: ctx.conversationId,
        memoryId,
        data: JSON.stringify({ tier, segment, importance }),
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
    handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
      const query = args.query as string;
      const limit = (args.limit as number | undefined) ?? 10;

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
        results = await convex.query(api.memoryRecords.search, {
          query,
          limit,
        });
      }

      for (const r of results) {
        await convex.mutation(api.memoryRecords.markAccessed, { memoryId: r.memoryId });
      }
      await convex.mutation(api.memoryEvents.emit, {
        eventType: "memory.recalled",
        conversationId: ctx.conversationId,
        data: JSON.stringify({ query, hits: results.length, mode }),
      });

      if (results.length === 0) {
        return "No memories matched.";
      }
      return results
        .map(
          (r) =>
            `• [${r.tier}/${r.segment} importance=${r.importance.toFixed(2)}] ${r.memoryId}: ${r.content}`,
        )
        .join("\n");
    },
  },
];
