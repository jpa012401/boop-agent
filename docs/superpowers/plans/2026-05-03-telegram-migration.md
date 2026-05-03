# Telegram Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SendBlue/iMessage with Telegram Bot API long-polling as Boop's sole messaging channel.

**Architecture:** A single `server/telegram.ts` module runs a long-polling loop (`getUpdates`) on server boot, processes inbound text messages through the existing dispatcher, and sends replies via the Bot API. No webhooks, no ngrok, no external dependencies.

**Tech Stack:** Node.js, Express (unchanged), Telegram Bot API (raw fetch), Convex (unchanged)

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `server/telegram.ts` | Polling loop, sendMessage, typing indicator |
| Create | `scripts/telegram-check.mjs` | Validate bot token via `getMe` |
| Modify | `server/index.ts` | Start/stop poller, remove SendBlue router |
| Modify | `server/interaction-agent.ts` | Switch send_ack from sendImessage to sendTelegramMessage |
| Modify | `server/automations.ts` | Switch notification send to Telegram |
| Modify | `server/proactive-email.ts` | Switch proactive dispatch to Telegram |
| Modify | `convex/schema.ts` | Remove `sendblueDedup` table |
| Modify | `.env.example` | Replace SendBlue vars with Telegram vars |
| Modify | `package.json` | Replace sendblue scripts with telegram:check |
| Modify | `scripts/dev.mjs` | Remove ngrok/SendBlue webhook logic |
| Delete | `server/sendblue.ts` | — |
| Delete | `convex/sendblueDedup.ts` | — |
| Delete | `scripts/sendblue-webhook.mjs` | — |
| Delete | `scripts/sendblue-sync.mjs` | — |

---

### Task 1: Create `server/telegram.ts`

**Files:**
- Create: `server/telegram.ts`

- [ ] **Step 1: Create the module with Bot API helpers**

```typescript
// server/telegram.ts
const MAX_CHUNK = 4096;

function botUrl(method: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  return `https://api.telegram.org/bot${token}/${method}`;
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export async function sendMessage(chatId: string, text: string): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set — not sending");
    return;
  }
  for (const part of chunk(text)) {
    const res = await fetch(botUrl("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: part }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[telegram] sendMessage failed ${res.status}: ${body}`);
    } else {
      console.log(`[telegram] → sent ${part.length} chars to ${chatId}`);
    }
  }
}

export async function sendTypingIndicator(chatId: string): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(botUrl("sendChatAction"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch {
    /* non-fatal */
  }
}

export function startTypingLoop(chatId: string): () => void {
  sendTypingIndicator(chatId);
  const timer = setInterval(() => sendTypingIndicator(chatId), 5000);
  return () => clearInterval(timer);
}
```

- [ ] **Step 2: Add the polling loop**

Append to `server/telegram.ts`:

```typescript
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";

let polling = false;
let abortController: AbortController | null = null;

export async function startTelegramPoller(): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set — poller disabled");
    return;
  }
  polling = true;
  let offset = 0;
  console.log("[telegram] poller started");

  while (polling) {
    abortController = new AbortController();
    try {
      const res = await fetch(
        botUrl("getUpdates") + `?offset=${offset}&timeout=30`,
        { signal: abortController.signal },
      );
      if (!res.ok) {
        console.error(`[telegram] getUpdates failed ${res.status}`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      const data = await res.json();
      const updates = data.result ?? [];

      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text || !msg?.chat?.id) continue;

        const chatId = String(msg.chat.id);
        const content = msg.text;
        const conversationId = `telegram:${chatId}`;
        const turnTag = Math.random().toString(36).slice(2, 8);
        const preview = content.length > 100 ? content.slice(0, 100) + "…" : content;
        console.log(`[turn ${turnTag}] ← telegram ${chatId}: ${JSON.stringify(preview)}`);
        const start = Date.now();

        broadcast("message_in", { conversationId, content, chatId });

        // Save inbound message
        await convex.mutation(api.messages.send, {
          conversationId,
          role: "user",
          content,
        });

        const stopTyping = startTypingLoop(chatId);
        try {
          const reply = await handleUserMessage({
            conversationId,
            content,
            turnTag,
            onThinking: (t) => broadcast("thinking", { conversationId, t }),
          });
          if (reply) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            const replyPreview = reply.length > 100 ? reply.slice(0, 100) + "…" : reply;
            console.log(
              `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
            );
            await sendMessage(chatId, reply);
            await convex.mutation(api.messages.send, {
              conversationId,
              role: "assistant",
              content: reply,
            });
          } else {
            console.log(`[turn ${turnTag}] → (no reply)`);
          }
        } catch (err) {
          console.error(`[turn ${turnTag}] handler error`, err);
        } finally {
          stopTyping();
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") break;
      console.error("[telegram] poll error", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.log("[telegram] poller stopped");
}

export function stopTelegramPoller(): void {
  polling = false;
  abortController?.abort();
}
```

- [ ] **Step 3: Verify the file compiles**

Run: `npx tsc --noEmit --skipLibCheck server/telegram.ts`
Expected: No errors (or only pre-existing unrelated errors)

- [ ] **Step 4: Commit**

```bash
git add server/telegram.ts
git commit -m "feat: add Telegram Bot API module with long-polling"
```

---

### Task 2: Wire up the poller in `server/index.ts`

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Replace SendBlue imports and router with Telegram poller**

In `server/index.ts`, make these changes:

1. Remove import:
```typescript
// REMOVE:
import { createSendblueRouter } from "./sendblue.js";
```

2. Add import:
```typescript
import { startTelegramPoller, stopTelegramPoller } from "./telegram.js";
```

3. Remove the router mount (line 55):
```typescript
// REMOVE:
app.use("/sendblue", createSendblueRouter());
```

4. After `server.listen(...)`, start the poller:
```typescript
server.listen(port, () => {
  console.log(`boop-agent server listening on :${port}`);
  console.log(`  health      GET  http://localhost:${port}/health`);
  console.log(`  chat        POST http://localhost:${port}/chat`);
  console.log(`  telegram    polling (long-poll getUpdates)`);
  console.log(`  websocket   WS   ws://localhost:${port}/ws`);
  startTelegramPoller();
});
```

5. Add graceful shutdown before the `main().catch(...)` block:
```typescript
process.on("SIGINT", () => {
  stopTelegramPoller();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopTelegramPoller();
  process.exit(0);
});
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat: wire Telegram poller into server startup"
```

---

### Task 3: Update `server/interaction-agent.ts` (send_ack)

**Files:**
- Modify: `server/interaction-agent.ts`

- [ ] **Step 1: Replace sendImessage import with sendMessage from telegram**

Change:
```typescript
import { sendImessage } from "./sendblue.js";
```
To:
```typescript
import { sendMessage } from "./telegram.js";
```

- [ ] **Step 2: Update the send_ack tool handler**

Find the send_ack handler (around line 225). Change:
```typescript
if (opts.conversationId.startsWith("sms:") && opts.kind !== "proactive") {
  const number = opts.conversationId.slice(4);
  await sendImessage(number, text);
}
```
To:
```typescript
if (opts.conversationId.startsWith("telegram:") && opts.kind !== "proactive") {
  const chatId = opts.conversationId.slice("telegram:".length);
  await sendMessage(chatId, text);
}
```

- [ ] **Step 3: Update the system prompt**

In the `INTERACTION_SYSTEM` string (line 16), change:
```
You are Boop, a personal agent the user texts from iMessage.
```
To:
```
You are Boop, a personal agent the user messages on Telegram.
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 5: Commit**

```bash
git add server/interaction-agent.ts
git commit -m "feat: switch interaction agent send_ack to Telegram"
```

---

### Task 4: Update `server/automations.ts`

**Files:**
- Modify: `server/automations.ts`

- [ ] **Step 1: Replace sendImessage import**

Change:
```typescript
import { sendImessage } from "./sendblue.js";
```
To:
```typescript
import { sendMessage } from "./telegram.js";
```

- [ ] **Step 2: Update the notification logic in `runAutomation`**

Find the notification block (around line 70-75). Change:
```typescript
if (a.notifyConversationId && res.result) {
  if (a.notifyConversationId.startsWith("sms:")) {
    const number = a.notifyConversationId.slice(4);
    const preamble = `[${a.name}]\n\n`;
    await sendImessage(number, preamble + res.result);
  }
```
To:
```typescript
if (a.notifyConversationId && res.result) {
  if (a.notifyConversationId.startsWith("telegram:")) {
    const chatId = a.notifyConversationId.slice("telegram:".length);
    const preamble = `[${a.name}]\n\n`;
    await sendMessage(chatId, preamble + res.result);
  }
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add server/automations.ts
git commit -m "feat: switch automation notifications to Telegram"
```

---

### Task 5: Update `server/proactive-email.ts`

**Files:**
- Modify: `server/proactive-email.ts`

- [ ] **Step 1: Replace sendImessage import**

Change:
```typescript
import { sendImessage } from "./sendblue.js";
```
To:
```typescript
import { sendMessage } from "./telegram.js";
```

- [ ] **Step 2: Replace `dispatchProactiveNotice` function**

Replace the entire `normalizeProactivePhone` function and `dispatchProactiveNotice` function (lines ~281-328) with:

```typescript
async function dispatchProactiveNotice(summary: string): Promise<void> {
  const chatId = process.env.BOOP_USER_CHAT_ID;
  if (!chatId) {
    console.warn("[proactive] BOOP_USER_CHAT_ID not set; skipping dispatch");
    return;
  }
  const conversationId = `telegram:${chatId}`;
  const reply = await handleUserMessage({
    conversationId,
    content: `[proactive notice] ${summary}`,
    kind: "proactive",
  });
  if (reply && reply !== "(no reply)") {
    await sendMessage(chatId, reply);
    await convex.mutation(api.messages.send, {
      conversationId,
      role: "assistant",
      content: reply,
    });
  } else {
    await sendMessage(chatId, summary);
    await convex.mutation(api.messages.send, {
      conversationId,
      role: "assistant",
      content: summary,
    });
    console.log(`[proactive] IA produced no reply; sent raw summary`);
  }
}
```

- [ ] **Step 3: Remove the `normalizeProactivePhone` function** (lines ~281-288) — no longer needed.

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 5: Commit**

```bash
git add server/proactive-email.ts
git commit -m "feat: switch proactive email notices to Telegram"
```

---

### Task 6: Remove SendBlue dedup from Convex

**Files:**
- Modify: `convex/schema.ts`
- Delete: `convex/sendblueDedup.ts`

- [ ] **Step 1: Remove `sendblueDedup` table from schema**

In `convex/schema.ts`, remove lines 170-173:
```typescript
// REMOVE:
  sendblueDedup: defineTable({
    handle: v.string(),
    claimedAt: v.number(),
  }).index("by_handle", ["handle"]),
```

- [ ] **Step 2: Delete the dedup mutation file**

```bash
rm convex/sendblueDedup.ts
```

- [ ] **Step 3: Verify Convex schema is valid**

Run: `npx convex dev --once --typecheck=disable`
Expected: Deploys successfully (or dry-run passes)

Note: The actual table removal from the Convex database happens on deploy. Existing data is harmless.

- [ ] **Step 4: Commit**

```bash
git add convex/schema.ts
git rm convex/sendblueDedup.ts
git commit -m "chore: remove sendblueDedup table (Telegram uses offset tracking)"
```

---

### Task 7: Delete `server/sendblue.ts` and SendBlue scripts

**Files:**
- Delete: `server/sendblue.ts`
- Delete: `scripts/sendblue-webhook.mjs`
- Delete: `scripts/sendblue-sync.mjs`

- [ ] **Step 1: Delete the files**

```bash
rm server/sendblue.ts
rm scripts/sendblue-webhook.mjs
rm scripts/sendblue-sync.mjs
```

- [ ] **Step 2: Verify no remaining imports of sendblue**

Run: `grep -r "sendblue" server/ scripts/ --include="*.ts" --include="*.mjs" --include="*.js"`
Expected: No matches (or only comments/docs)

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git rm server/sendblue.ts scripts/sendblue-webhook.mjs scripts/sendblue-sync.mjs
git commit -m "chore: remove SendBlue module and scripts"
```

---

### Task 8: Create `scripts/telegram-check.mjs`

**Files:**
- Create: `scripts/telegram-check.mjs`

- [ ] **Step 1: Create the validation script**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add scripts/telegram-check.mjs
git commit -m "feat: add telegram:check script to validate bot token"
```

---

### Task 9: Update `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Replace SendBlue section with Telegram section**

Remove the entire SendBlue section (lines 8-17):
```
# ---- Sendblue (iMessage bridge) ----
# Sign up at https://sendblue.com, get your API keys + provisioned number.
# Webhook URL you'll set in Sendblue dashboard:  <PUBLIC_URL>/sendblue/webhook
#
# SENDBLUE_FROM_NUMBER MUST be your Sendblue-provisioned number (the one
# people text TO), not your personal cell. Sendblue's API requires it.
SENDBLUE_API_KEY=
SENDBLUE_API_SECRET=
SENDBLUE_FROM_NUMBER=
```

Replace with:
```
# ---- Telegram (Bot API) ----
# Create a bot via @BotFather on Telegram → /newbot → copy the token.
# Run `npm run telegram:check` to verify.
TELEGRAM_BOT_TOKEN=
```

- [ ] **Step 2: Replace BOOP_USER_PHONE with BOOP_USER_CHAT_ID**

Change:
```
# Phone number that receives proactive iMessage notices when the Gmail watcher
# decides an inbound email is worth surfacing. Single-user assumption for v1.
# Without this, the webhook still registers but notices are dropped.
BOOP_USER_PHONE=
```
To:
```
# Telegram chat ID that receives proactive notices when the Gmail watcher
# decides an inbound email is worth surfacing. Single-user assumption for v1.
# Find your chat ID by messaging your bot and running `npm run telegram:check`.
BOOP_USER_CHAT_ID=
```

- [ ] **Step 3: Remove ngrok/SendBlue auto-webhook vars**

Remove these lines:
```
# Optional: ngrok RESERVED domain (paid plan). Example: "boop.ngrok.app".
# When set, `npm run dev` launches ngrok with --domain=$NGROK_DOMAIN so your
# public URL stays the same across restarts.
# NGROK_DOMAIN=

# When free-plan ngrok is in use, `npm run dev` auto-registers the new tunnel
# URL with Sendblue as the inbound (receive) webhook so you don't have to
# paste it into the dashboard. Set to "false" to disable this behavior.
# SENDBLUE_AUTO_WEBHOOK=true
```

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "docs: update .env.example for Telegram"
```

---

### Task 10: Update `package.json` scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Replace sendblue scripts with telegram:check**

Remove:
```json
"sendblue:sync": "node scripts/sendblue-sync.mjs",
"sendblue:webhook": "node scripts/sendblue-webhook.mjs",
```

Add:
```json
"telegram:check": "node scripts/telegram-check.mjs",
```

- [ ] **Step 2: Update the description**

Change:
```json
"description": "Text-an-agent starter: iMessage your Claude agent, it runs sub-agents, remembers you, and grows with integrations you add.",
```
To:
```json
"description": "Text-an-agent starter: Telegram your Claude agent, it runs sub-agents, remembers you, and grows with integrations you add.",
```

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: update package.json scripts for Telegram"
```

---

### Task 11: Simplify `scripts/dev.mjs`

**Files:**
- Modify: `scripts/dev.mjs`

- [ ] **Step 1: Remove ngrok and SendBlue webhook logic**

Major changes to `scripts/dev.mjs`:

1. Remove all ngrok-related variables and logic:
   - Remove `ngrokDomain`, `useNgrok`, `ngrokInstalled` variables
   - Remove the `hasBinary("ngrok")` check
   - Remove `waitForNgrokUrl()` function
   - Remove `autoRegisterWebhook()` function  
   - Remove ngrok child process spawn
   - Remove the ngrok color from `C` object

2. Remove `showBanner()` function entirely and replace with a simpler version:
```javascript
function showBanner() {
  const line = "═".repeat(68);
  const dashboard = `http://localhost:5173`;
  console.log(`
${C.banner}${line}
  Boop is ready — Telegram poller is active.

  🐶 Debug dashboard (click me):   ${dashboard}
  📮 Telegram:                     long-polling (no public URL needed)
${line}${C.reset}
`);
}
```

3. Simplify the `Promise.all` at the end — just wait for server + convex + debug, then show banner:
```javascript
Promise.all([serverChild.ready, convexChild.ready, debugChild.ready])
  .then(() => showBanner())
  .catch(() => {});
```

4. Remove `autoRegisterComposioWebhook` only if Composio webhook also used ngrok URL. Keep it if it uses `PUBLIC_URL` independently.

5. Keep `envVars.SENDBLUE_FROM_NUMBER` reference in banner removed.

- [ ] **Step 2: Verify dev.mjs runs without syntax errors**

Run: `node --check scripts/dev.mjs`
Expected: No output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add scripts/dev.mjs
git commit -m "chore: simplify dev.mjs — remove ngrok/SendBlue webhook registration"
```

---

### Task 12: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: Clean (no errors)

- [ ] **Step 2: Grep for any remaining SendBlue references**

Run: `grep -ri "sendblue\|sendImessage\|SENDBLUE\|send_imessage" --include="*.ts" --include="*.mjs" --include="*.js" --include="*.json" server/ scripts/ convex/ package.json .env.example`
Expected: No matches

- [ ] **Step 3: Grep for any remaining "sms:" conversation ID references**

Run: `grep -rn "sms:" --include="*.ts" server/`
Expected: No matches in the modified files (may appear in unrelated files — verify they're not in message routing)

- [ ] **Step 4: Test the bot token check script**

Run: `npm run telegram:check`
Expected: Either "Bot token is valid!" (if configured) or clear error about missing token

- [ ] **Step 5: Commit any fixups**

```bash
git add -A
git commit -m "chore: fix any remaining SendBlue references"
```

(Only if Step 2 or 3 found issues to fix)
