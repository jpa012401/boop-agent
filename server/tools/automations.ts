import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { availableIntegrations } from "../execution-agent.js";
import { nextRunFor, validateSchedule } from "../automations.js";
import { describeUserNow } from "../timezone-config.js";
import { ToolSpec } from "./types.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const automationTools: ToolSpec[] = [
  {
    name: "create_automation",
    get description() {
      const integrationHint = availableIntegrations().join(", ") || "(none configured)";
      return `Schedule a recurring task. The agent will run the task on the schedule and reply with the result.

Cron expressions (5 fields: min hour day-of-month month day-of-week). Write times in the user's LOCAL clock — the runner attaches the user's stored timezone (from settings.user_timezone) automatically when evaluating the cron, so do NOT convert to UTC. If the user says "every morning at 10am" and they're on Central, pass "0 10 * * *" — it'll fire at 10am Central.

Examples:
  "0 8 * * *"      — every day at 8am (user-local)
  "*/15 * * * *"   — every 15 minutes
  "0 9 * * 1-5"    — weekdays at 9am (user-local)
  "0 18 * * 0"     — Sundays at 6pm (user-local)

If you don't yet know the user's timezone (get_config returns userTimezone=null), ASK before creating any time-of-day automation — otherwise it'll fire in the server's zone, which is almost always wrong.

Use this for anything the user says "every [time]" or "remind me" about.
Integrations available: ${integrationHint}`;
    },
    schema: {
      name: z.string().describe("Short label, e.g. 'morning email digest'."),
      schedule: z.string().describe("Cron expression (5 fields)."),
      task: z
        .string()
        .describe("Specific task for the sub-agent — what to look up, draft, or summarize."),
      integrations: z
        .array(z.string())
        .optional()
        .default([])
        .describe(
          "Integration names the sub-agent needs for this task. Pass [] for reminder-only automations that don't need external tools.",
        ),
      notify: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true, send the result to this conversation when it runs."),
      dataSchema: z
        .string()
        .optional()
        .describe(
          "JSON string defining the schema for structured research findings. Example: '{\"company\":\"string\",\"amount\":\"string\",\"date\":\"string\"}'. When set, the execution agent gets research dedup tools and will store findings in this format.",
        ),
    },
    async handler(args, ctx) {
      const name = args.name as string;
      const schedule = args.schedule as string;
      const task = args.task as string;
      const integrations = (args.integrations as string[] | undefined) ?? [];
      const notify = (args.notify as boolean | undefined) ?? true;
      const dataSchema = args.dataSchema as string | undefined;

      const tzInfo = await describeUserNow();
      const timezone = tzInfo.timezone;
      const validation = validateSchedule(schedule, timezone);
      if (!validation.valid) {
        return `Invalid cron expression: ${validation.error}`;
      }
      const automationId = randomId("auto");
      const nextRunAt = nextRunFor(schedule, timezone) ?? undefined;
      await convex.mutation(api.automations.create, {
        automationId,
        name,
        task,
        integrations,
        schedule,
        timezone,
        conversationId: ctx.conversationId,
        notifyConversationId: notify ? ctx.conversationId : undefined,
        nextRunAt,
        dataSchema,
      });
      const nextStr = nextRunAt
        ? new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          }).format(new Date(nextRunAt))
        : "unknown";
      const tzNote = tzInfo.isExplicit
        ? `timezone: ${timezone}`
        : `timezone: ${timezone} (server fallback — user has not set theirs; ask them and call set_timezone)`;
      return `Created automation ${automationId} "${name}" — next run: ${nextStr} (${tzNote}).`;
    },
  },

  {
    name: "list_automations",
    description: "List all automations for this conversation.",
    schema: {
      enabledOnly: z.boolean().optional().default(false),
    },
    async handler(args, ctx) {
      const enabledOnly = (args.enabledOnly as boolean | undefined) ?? false;
      const all = await convex.query(api.automations.list, { enabledOnly });
      const mine = all.filter((a) => a.conversationId === ctx.conversationId);
      if (mine.length === 0) {
        return "No automations.";
      }
      const lines = mine.map(
        (a) =>
          `• [${a.automationId}] ${a.enabled ? "●" : "○"} "${a.name}" — ${a.schedule} — ${a.task}`,
      );
      return lines.join("\n");
    },
  },

  {
    name: "toggle_automation",
    description: "Enable or disable an automation by id.",
    schema: {
      automationId: z.string(),
      enabled: z.boolean(),
    },
    async handler(args) {
      const automationId = args.automationId as string;
      const enabled = args.enabled as boolean;
      const id = await convex.mutation(api.automations.setEnabled, { automationId, enabled });
      return id ? `Set ${automationId} enabled=${enabled}.` : `Not found.`;
    },
  },

  {
    name: "delete_automation",
    description: "Permanently remove an automation.",
    schema: {
      automationId: z.string(),
    },
    async handler(args) {
      const automationId = args.automationId as string;
      const id = await convex.mutation(api.automations.remove, { automationId });
      return id ? `Deleted ${automationId}.` : `Not found.`;
    },
  },
];
