/**
 * Cancel all agents stuck in "running" or "spawned" status.
 * These are stale from server restarts — the actual process is gone.
 *
 * Usage: tsx scripts/cancel-stale-agents.ts
 */
import "../server/env-setup.js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

async function main() {
  const url = process.env.CONVEX_URL;
  if (!url) {
    console.error("CONVEX_URL not set");
    process.exit(1);
  }

  const convex = new ConvexHttpClient(url);
  const agents = await convex.query(api.agents.list, { limit: 200 });
  const stale = agents.filter(
    (a) => a.status === "running" || a.status === "spawned",
  );

  if (stale.length === 0) {
    console.log("No stale agents found.");
    return;
  }

  console.log(`Found ${stale.length} stale agent(s):`);
  for (const a of stale) {
    console.log(`  ${a.agentId} — "${a.name}" (${a.status} since ${new Date(a.startedAt).toISOString()})`);
    await convex.mutation(api.agents.update, {
      agentId: a.agentId,
      status: "cancelled",
      error: "Cancelled: stale from server restart",
    });
  }
  console.log(`Cancelled ${stale.length} stale agent(s).`);
}

main().catch(console.error);
