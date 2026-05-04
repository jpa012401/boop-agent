import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { spawnExecutionAgent } from "../execution-agent.js";
import type { ToolSpec } from "./types.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Execution-agent tool: stage a draft for user review. */
export const draftStagingTools: ToolSpec[] = [
  {
    name: "save_draft",
    description:
      `Save a draft of an external action (email, calendar event, message, etc.) for the user to review.
ALWAYS call this instead of sending or creating something directly. The user will say "send it" in the next turn to commit.

- summary: one-line description the user will see.
- payload: JSON string with everything needed to execute the draft (provider-specific fields).
- kind: short type tag like "gmail.reply", "gmail.new", "gcal.event", "slack.message".`,
    schema: {
      kind: z.string(),
      summary: z.string(),
      payload: z.string().describe("JSON string with the data needed to execute."),
    },
    async handler(args, ctx) {
      const draftId = randomId("draft");
      await convex.mutation(api.drafts.create, {
        draftId,
        conversationId: ctx.conversationId,
        kind: args.kind as string,
        summary: args.summary as string,
        payload: args.payload as string,
      });
      return `Draft saved as ${draftId}. Surface the summary to the user and ask them to confirm "send" or "cancel".`;
    },
  },
];

/** Interaction-agent tools: review and approve/reject drafts. */
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
