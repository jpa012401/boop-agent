export type { ToolSpec, ToolContext } from "./types.js";
export { memoryTools } from "./memory.js";
export { automationTools } from "./automations.js";
export { draftTools } from "./drafts.js";
export { selfConfigTools } from "./self-config.js";
export { integrationTools } from "./integrations.js";
export { commsTools } from "./comms.js";
export { makeSpawnTools } from "./spawn.js";
export { researchQueryTools, researchDedupTools } from "./research.js";

import { memoryTools } from "./memory.js";
import { automationTools } from "./automations.js";
import { draftTools } from "./drafts.js";
import { selfConfigTools } from "./self-config.js";
import { integrationTools } from "./integrations.js";
import { commsTools } from "./comms.js";
import { researchQueryTools } from "./research.js";
import type { ToolSpec } from "./types.js";

/** All interaction-layer tools (minus spawn, which is built dynamically). */
export const interactionTools: ToolSpec[] = [
  ...memoryTools,
  ...automationTools,
  ...draftTools,
  ...selfConfigTools,
  ...integrationTools,
  ...commsTools,
  ...researchQueryTools,
];

/** Execution-layer tools (read-only data access). */
export const executionTools: ToolSpec[] = [
  ...researchQueryTools,
];

export function defaultConversationId(): string {
  const chatId = process.env.BOOP_USER_CHAT_ID;
  return chatId ? `telegram:${chatId}` : "codex:default";
}
