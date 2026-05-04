import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import type { ToolSpec } from "./types.js";

/**
 * commsTools — shared Convex-persistence layer for send_ack.
 *
 * The handler saves the ack message to the DB only. The Telegram-specific
 * sendMessage call remains in interaction-agent.ts as a wrapper around this
 * shared handler so the tool can be reused in other contexts.
 */
export const commsTools: ToolSpec[] = [
  {
    name: "send_ack",
    description:
      `Send a short acknowledgment message to the user IMMEDIATELY, before a slow operation. Use this BEFORE spawn_agent so the user knows you heard them and are working on it. Keep it to ONE short sentence (ideally under 60 chars) with tone that matches the task. Examples: "On it — one sec 🔍", "Looking into it…", "Drafting now, hold tight.", "Let me check your calendar."`,
    schema: {
      message: z.string().describe("1 short sentence ack. No markdown. Emojis OK."),
    },
    async handler(args, ctx) {
      const text = (args.message as string).trim();
      if (!text) {
        return "Empty ack skipped.";
      }
      await convex.mutation(api.messages.send, {
        conversationId: ctx.conversationId,
        role: "assistant",
        content: text,
      });
      return "Ack sent to user.";
    },
  },
];
