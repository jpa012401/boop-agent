/**
 * One-shot migration: backfill `provider: "claude"` on all usageRecords rows
 * that were created before the provider field was introduced.
 *
 * Usage:
 *   npx tsx scripts/migrate-usage-provider.ts
 *
 * The script reads CONVEX_URL from .env.local or the environment, calls the
 * `migrations:backfillUsageProvider` mutation in batches, and exits when
 * no rows remain.
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

// Load .env.local then .env from the project root (same pattern as env-setup.ts)
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
for (const name of [".env.local", ".env"]) {
  const path = resolve(root, name);
  if (existsSync(path)) config({ path });
}

const BATCH_SIZE = 100;

async function main() {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    console.error(
      "CONVEX_URL is not set. Run `npm run setup` or `npx convex dev` first.",
    );
    process.exit(1);
  }

  const client = new ConvexHttpClient(convexUrl);

  console.log(`Connecting to Convex at ${convexUrl}`);
  console.log(`Backfilling provider="claude" on usageRecords (batch size: ${BATCH_SIZE})...\n`);

  let totalMigrated = 0;

  while (true) {
    const { migrated, remaining } = await client.mutation(
      api.migrations.backfillUsageProvider,
      { batchSize: BATCH_SIZE },
    );

    totalMigrated += migrated;

    if (migrated === 0 && remaining === 0) {
      break;
    }

    console.log(`Migrated ${totalMigrated} rows so far... (${remaining > 0 ? "more remaining" : "checking done"})`);

    if (remaining === 0) {
      break;
    }
  }

  console.log(`\nDone. Total rows migrated: ${totalMigrated}`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
