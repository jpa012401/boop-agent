import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { spawnExecutionAgent } from "../execution-agent.js";
import type { ToolSpec } from "./types.js";

export const draftTools: ToolSpec[] = [
  {
    name: "list_drafts",
    description:
      "List pending drafts in this conversation. Call this when the user says 'send it', 'yes', 'go ahead', etc. without a specific id.",
    schema: {},
    async handler(_args, ctx) {
      const drafts = await convex.query(api.drafts.pendingByConversation, {
        conversationId: ctx.conversationId,
      });
      if (drafts.length === 0) {
        return "No pending drafts.";
      }
      return drafts.map((d) => `• [${d.draftId}] (${d.kind}) ${d.summary}`).join("\n");
    },
  },

  {
    name: "send_draft",
    description:
      "Approve and execute a draft. Spawns an execution agent to actually perform the action based on the stored payload.",
    schema: {
      draftId: z.string(),
      integrations: z.array(z.string()),
    },
    async handler(args, ctx) {
      const draftId = args.draftId as string;
      const integrations = args.integrations as string[];

      const draft = await convex.query(api.drafts.get, { draftId });
      if (!draft || draft.status !== "pending") {
        return `Draft ${draftId} not found or already decided.`;
      }

      await convex.mutation(api.drafts.setStatus, {
        draftId,
        status: "sent",
      });

      const task = `Execute this approved draft. Use the matching integration tool to actually send/create it.
kind: ${draft.kind}
summary: ${draft.summary}
payload JSON: ${draft.payload}`;

      const res = await spawnExecutionAgent({
        task,
        integrations,
        conversationId: ctx.conversationId,
        name: `send:${draft.kind}`,
      });

      return `Draft ${draftId} executed.\n\n${res.result}`;
    },
  },

  {
    name: "reject_draft",
    description:
      "Cancel a pending draft when the user says 'no', 'cancel', or revises the request.",
    schema: {
      draftId: z.string(),
    },
    async handler(args, _ctx) {
      const draftId = args.draftId as string;
      await convex.mutation(api.drafts.setStatus, {
        draftId,
        status: "rejected",
      });
      return `Draft ${draftId} rejected.`;
    },
  },
];
