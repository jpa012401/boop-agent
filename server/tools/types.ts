import { z } from "zod";

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export interface ToolContext {
  conversationId: string;
  automationId?: string;
}
