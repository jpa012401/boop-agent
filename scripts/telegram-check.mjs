#!/usr/bin/env node
// Validates the TELEGRAM_BOT_TOKEN by calling getMe.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const envPath = resolve(root, ".env.local");

// Read token from .env.local
let token = process.env.TELEGRAM_BOT_TOKEN;
if (!token && existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^TELEGRAM_BOT_TOKEN=(.+?)(?:\s+#.*)?$/);
    if (m) token = m[1].trim();
  }
}

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set in .env.local or environment.");
  console.error("Get one from @BotFather on Telegram: https://t.me/BotFather");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
const data = await res.json();

if (!data.ok) {
  console.error("Token is invalid:", data.description);
  process.exit(1);
}

console.log("Bot token is valid!");
console.log(`  Username: @${data.result.username}`);
console.log(`  Name:     ${data.result.first_name}`);
console.log(`  Bot ID:   ${data.result.id}`);
console.log("\nTo find your chat ID:");
console.log("  1. Send any message to your bot on Telegram");
console.log("  2. Run: curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates");
console.log("  3. Look for chat.id in the response");
console.log("  4. Set BOOP_USER_CHAT_ID in .env.local");
