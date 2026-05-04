/**
 * Smoke test: verify the active provider can execute a simple prompt.
 *
 * Usage:
 *   BOOP_PROVIDER=claude tsx scripts/test-provider.ts
 *   BOOP_PROVIDER=codex OPENAI_API_KEY=sk-... tsx scripts/test-provider.ts
 */
import "../server/env-setup.js";
import { getProvider, getProviderName } from "../server/providers/index.js";

async function main() {
  const provider = getProvider();
  console.log(`Provider: ${provider.name} (BOOP_PROVIDER=${getProviderName()})`);
  console.log(`Default model: ${provider.defaultModel}\n`);

  console.log("Sending test prompt...\n");
  for await (const msg of provider.execute("Say hello in one sentence.", {
    systemPrompt: "You are a helpful assistant. Reply in one sentence.",
    model: provider.defaultModel,
    mcpServers: {},
    allowedTools: [],
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
    } else if (msg.type === "result") {
      console.log("\n\nUsage:", JSON.stringify(msg.usage, null, 2));
    }
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
