import { query } from "./_generated/server";

// Cap per-table scans so a long-lived install doesn't hit Convex's 16,384
// .collect() ceiling and break the dashboard. Metrics reflect the most
// recent N rows per table; `truncated` surfaces when we've hit the cap.
const METRICS_SCAN_LIMIT = 5000;

export const metrics = query({
  args: {},
  handler: async (ctx) => {
    const [messages, memories, agents, automationRuns, usageRows] = await Promise.all([
      ctx.db.query("messages").order("desc").take(METRICS_SCAN_LIMIT),
      ctx.db.query("memoryRecords").order("desc").take(METRICS_SCAN_LIMIT),
      ctx.db.query("executionAgents").order("desc").take(METRICS_SCAN_LIMIT),
      ctx.db.query("automationRuns").order("desc").take(METRICS_SCAN_LIMIT),
      ctx.db.query("usageRecords").order("desc").take(METRICS_SCAN_LIMIT),
    ]);
    const truncated =
      messages.length === METRICS_SCAN_LIMIT ||
      memories.length === METRICS_SCAN_LIMIT ||
      agents.length === METRICS_SCAN_LIMIT ||
      automationRuns.length === METRICS_SCAN_LIMIT;

    const activeMem = memories.filter((m) => m.lifecycle === "active");

    // Build daily buckets from usageRecords (which carry the provider field)
    // so the dashboard can filter charts by provider on the client side.
    type DailyBucket = {
      day: string;
      provider: string;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      agentsSpawned: number;
      agentsCompleted: number;
      agentsFailed: number;
      agentsCancelled: number;
      automationRuns: number;
    };
    const buckets = new Map<string, DailyBucket>();

    function keyFor(ts: number) {
      return new Date(ts).toISOString().slice(0, 10);
    }
    function bucketKey(day: string, provider: string) {
      return `${day}|${provider}`;
    }
    function bucketFor(day: string, provider: string) {
      const key = bucketKey(day, provider);
      let b = buckets.get(key);
      if (!b) {
        b = {
          day,
          provider,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          agentsSpawned: 0,
          agentsCompleted: 0,
          agentsFailed: 0,
          agentsCancelled: 0,
          automationRuns: 0,
        };
        buckets.set(key, b);
      }
      return b;
    }

    // Usage records carry provider — use these for cost/token daily data.
    for (const r of usageRows) {
      const prov = r.provider ?? "unknown";
      const b = bucketFor(keyFor(r.createdAt), prov);
      b.costUsd += r.costUsd;
      b.inputTokens += r.inputTokens;
      b.outputTokens += r.outputTokens;
    }

    // Agent status counts go into every provider bucket for that day (they're
    // provider-independent counts). We attribute them to "all" so the client
    // can aggregate when showing unfiltered.
    for (const a of agents) {
      const b = bucketFor(keyFor(a.startedAt), "_agents");
      b.agentsSpawned += 1;
      if (a.status === "completed") b.agentsCompleted += 1;
      else if (a.status === "failed") b.agentsFailed += 1;
      else if (a.status === "cancelled") b.agentsCancelled += 1;
    }
    for (const r of automationRuns) {
      const b = bucketFor(keyFor(r.startedAt), "_agents");
      b.automationRuns += 1;
    }

    const dailyBuckets = [...buckets.values()].sort((a, b) =>
      a.day.localeCompare(b.day) || a.provider.localeCompare(b.provider),
    );

    // Group usage records by provider
    const byProvider: Record<string, { costUsd: number; inputTokens: number; outputTokens: number; count: number }> = {};
    for (const r of usageRows) {
      const prov = r.provider ?? "unknown";
      const bucket = (byProvider[prov] ??= { costUsd: 0, inputTokens: 0, outputTokens: 0, count: 0 });
      bucket.costUsd += r.costUsd;
      bucket.inputTokens += r.inputTokens;
      bucket.outputTokens += r.outputTokens;
      bucket.count += 1;
    }

    return {
      messages: messages.length,
      memories: {
        total: activeMem.length,
        shortTerm: activeMem.filter((m) => m.tier === "short").length,
        longTerm: activeMem.filter((m) => m.tier === "long").length,
        permanent: activeMem.filter((m) => m.tier === "permanent").length,
      },
      agents: {
        total: agents.length,
        completed: agents.filter((a) => a.status === "completed").length,
        failed: agents.filter((a) => a.status === "failed").length,
        cancelled: agents.filter((a) => a.status === "cancelled").length,
        running: agents.filter(
          (a) => a.status === "running" || a.status === "spawned",
        ).length,
      },
      cost: {
        total: usageRows.reduce((s, r) => s + r.costUsd, 0),
      },
      tokens: {
        input: usageRows.reduce((s, r) => s + r.inputTokens, 0),
        output: usageRows.reduce((s, r) => s + r.outputTokens, 0),
      },
      dailyBuckets,
      byProvider,
      truncated,
      scanLimit: METRICS_SCAN_LIMIT,
    };
  },
});
