import { z } from "zod";
import {
  getRuntimeModel,
  resolveModelInput,
  setRuntimeModel,
  PROVIDER_MODELS,
  PROVIDER_MODEL_ALIASES,
} from "../runtime-config.js";
import { getProviderName } from "../providers/index.js";
import {
  describeUserNow,
  resolveTimezoneInput,
  setUserTimezone,
} from "../timezone-config.js";
import { availableIntegrations } from "../execution-agent.js";
import { activeProvider as activeEmbeddingProvider } from "../embeddings.js";
import type { ToolSpec } from "./types.js";

export const selfConfigTools: ToolSpec[] = [
  {
    name: "get_config",
    description:
      "Return Boop's runtime configuration: which Claude model it's using, the user's timezone, the current local time, which integrations are loaded, and basic env info. Use when the user asks 'what model are you?', 'what time is it?', 'what timezone am I in?', or anything about the agent itself.",
    schema: {},
    handler: async (_args, _ctx) => {
      const integrations = availableIntegrations();
      const tzInfo = await describeUserNow();
      const config = {
        model: await getRuntimeModel(),
        envDefault: process.env.BOOP_MODEL ?? "claude-sonnet-4-6",
        availableModels: [...(PROVIDER_MODELS[getProviderName()] ?? [])],
        userTimezone: tzInfo.isExplicit ? tzInfo.timezone : null,
        timezoneFallback: tzInfo.isExplicit ? null : tzInfo.timezone,
        currentLocalTime: tzInfo.now,
        integrationsLoaded: integrations,
        integrationCount: integrations.length,
        composioEnabled: Boolean(process.env.COMPOSIO_API_KEY),
        // Embeddings always available — local Transformers.js fallback
        // kicks in when no paid key is set. Provider tells the user
        // which one is actually running this turn.
        embeddingsEnabled: true,
        embeddingsProvider: activeEmbeddingProvider(),
        telegramEnabled: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      };
      return JSON.stringify(config, null, 2);
    },
  },
  {
    name: "set_timezone",
    description: `Save the user's timezone so Boop can reason about deadlines, "today", "9am tomorrow", and other local-time references correctly. Accepts an IANA timezone ID (e.g. "America/Chicago", "Europe/London") or a friendly alias ("central", "PT", "Dallas", "Tokyo", "UTC", etc.).

Use when the user tells you their timezone or location ("I'm in Dallas", "use central time", "I'm in London"), or proactively after asking when get_config returns a null userTimezone and you need local-time context for the user's request. Don't guess from prior messages — if you're unsure, just ask once.`,
    schema: {
      timezone: z
        .string()
        .describe(
          'Timezone the user just told you. IANA format like "America/New_York" or alias like "eastern" / "Dallas".',
        ),
    },
    handler: async (args, _ctx) => {
      const timezone = args.timezone as string;
      const resolved = resolveTimezoneInput(timezone);
      if (!resolved) {
        return `"${timezone}" isn't a recognized timezone or alias. Pass a canonical IANA ID like "America/Chicago" / "Europe/London" / "Asia/Tokyo", or a friendly name like "central" / "pacific" / "London" / "Tokyo". Ask the user to clarify if needed.`;
      }
      await setUserTimezone(resolved);
      const tzInfo = await describeUserNow();
      return `User timezone set to ${resolved}. Local time there is now ${tzInfo.now}. This will be used for all future date/time reasoning.`;
    },
  },
  {
    name: "set_model",
    description: `Switch the Claude model used for both this dispatcher and any sub-agents. The change applies to the *next* turn (this turn finishes on the current model). Accepts either a canonical ID or a friendly alias.

Aliases: ${Object.keys(PROVIDER_MODEL_ALIASES[getProviderName()] ?? {}).map((k) => `"${k}"`).join(", ")}
Canonical: ${[...(PROVIDER_MODELS[getProviderName()] ?? [])].map((k) => `"${k}"`).join(", ")}

Use when the user says "use opus", "switch to sonnet", "make it faster (haiku)", etc.

Cost note (approximate, per 1M output tokens): Opus 4.7 ≈ $75, Sonnet 4.6 ≈ $15, Haiku 4.5 ≈ $4. Mention briefly when switching to Opus.`,
    schema: {
      model: z
        .string()
        .describe('Model to use. Canonical ID like "claude-opus-4-7" or alias like "opus".'),
    },
    handler: async (args, _ctx) => {
      const model = args.model as string;
      const resolved = resolveModelInput(model);
      if (!resolved) {
        return `Unknown model "${model}". Try one of: ${[...(PROVIDER_MODELS[getProviderName()] ?? [])].join(", ")} or aliases ${Object.keys(PROVIDER_MODEL_ALIASES[getProviderName()] ?? {}).join(", ")}.`;
      }
      await setRuntimeModel(resolved);
      return `Model override set to ${resolved}. Next agent run (interaction or sub-agent) will use it. This current turn keeps the previous model.`;
    },
  },
];
