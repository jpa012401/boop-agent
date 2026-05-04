import type { Provider } from "./types.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";

export type ProviderName = "claude" | "codex";

const providers: Record<ProviderName, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
};

let activeProvider: ProviderName | null = null;

export function getProviderName(): ProviderName {
  if (!activeProvider) {
    const env = process.env.BOOP_PROVIDER?.toLowerCase() ?? "claude";
    if (env !== "claude" && env !== "codex") {
      console.warn(`[providers] unknown BOOP_PROVIDER="${env}", defaulting to claude`);
      activeProvider = "claude";
    } else {
      activeProvider = env;
    }
  }
  return activeProvider;
}

export function getProvider(): Provider {
  return providers[getProviderName()];
}

export { type Provider, type ProviderConfig, type NormalizedMessage } from "./types.js";
