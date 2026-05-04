import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { getProviderName } from "./providers/index.js";

const MODEL_KEY = "model";
const MODEL_TTL_MS = 30 * 1000;
let cached: { at: number; value: string } | null = null;

export const PROVIDER_MODELS: Record<string, Set<string>> = {
  claude: new Set([
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ]),
  codex: new Set([
    "o3",
    "o4-mini",
    "gpt-4.1",
    "codex-mini",
  ]),
};

export const PROVIDER_MODEL_ALIASES: Record<string, Record<string, string>> = {
  claude: {
    opus: "claude-opus-4-7",
    "opus 4.7": "claude-opus-4-7",
    sonnet: "claude-sonnet-4-6",
    "sonnet 4.6": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5-20251001",
    "haiku 4.5": "claude-haiku-4-5-20251001",
  },
  codex: {
    o3: "o3",
    "o4-mini": "o4-mini",
    "o4 mini": "o4-mini",
    "gpt-4.1": "gpt-4.1",
    "gpt 4.1": "gpt-4.1",
    "codex-mini": "codex-mini",
    "codex mini": "codex-mini",
  },
};

export const PROVIDER_DEFAULTS: Record<string, string> = {
  claude: "claude-sonnet-4-6",
  codex: "o3",
};

export function resolveModelInput(input: string): string | null {
  const provider = getProviderName();
  const lower = input.trim().toLowerCase();
  if (PROVIDER_MODELS[provider]?.has(lower)) return lower;
  return PROVIDER_MODEL_ALIASES[provider]?.[lower] ?? null;
}

function envFallback(): string {
  const provider = getProviderName();
  const envModel = process.env.BOOP_MODEL;
  if (envModel && PROVIDER_MODELS[provider]?.has(envModel)) return envModel;
  return PROVIDER_DEFAULTS[provider] ?? "claude-sonnet-4-6";
}

export async function getRuntimeModel(): Promise<string> {
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.value;
  const provider = getProviderName();
  let stored: string | null = null;
  try {
    stored = await convex.query(api.settings.get, { key: MODEL_KEY });
  } catch (err) {
    console.warn("[runtime-config] settings:get failed", err);
  }
  const final = stored && PROVIDER_MODELS[provider]?.has(stored) ? stored : envFallback();
  cached = { at: Date.now(), value: final };
  return final;
}

export async function setRuntimeModel(model: string): Promise<void> {
  await convex.mutation(api.settings.set, { key: MODEL_KEY, value: model });
  cached = { at: Date.now(), value: model };
}

export async function clearRuntimeModel(): Promise<void> {
  await convex.mutation(api.settings.clear, { key: MODEL_KEY });
  cached = null;
}
