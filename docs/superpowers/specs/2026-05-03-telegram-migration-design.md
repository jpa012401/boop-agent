# Telegram Migration Design

**Date:** 2026-05-03  
**Status:** Approved  
**Scope:** Replace SendBlue/iMessage with Telegram long-polling as Boop's sole messaging channel

## Context

Boop currently uses SendBlue to bridge Claude-powered agents with iMessage. This design replaces that integration with Telegram's Bot API using long-polling. The goal is a direct swap — same architecture, simpler infrastructure (no ngrok, no webhook registration, no provisioned phone number).

## Decisions

- **Long-polling** over webhooks — no public URL needed, simpler dev/prod setup
- **Raw `fetch`** over bot libraries (grammY, Telegraf) — text-only use case is too simple to justify a dependency
- **Full replacement** — SendBlue is removed entirely, not kept as a fallback
- **Conversation ID format:** `telegram:{chat_id}` (stable, immutable)
- **Text-only** — no media, no inline buttons, no rich formatting (for now)

## Architecture

```
Telegram Bot API ← getUpdates (long-poll, timeout=30)
       ↓
server/telegram.ts (polling loop)
       ↓
handleUserMessage() (interaction agent / dispatcher)
       ↓
sendMessage(chatId, reply) → POST /bot{token}/sendMessage
```

Three outbound paths:
1. **Direct replies** — from polling loop after dispatcher responds
2. **Automations** — scheduled tasks send results via `sendMessage()`
3. **Proactive notices** — Gmail watcher sends summaries via `sendMessage()`

## Core Module: `server/telegram.ts`

### Exports

| Function | Purpose |
|----------|---------|
| `startTelegramPoller()` | Starts long-polling loop on server boot |
| `stopTelegramPoller()` | Graceful shutdown (aborts pending `getUpdates`) |
| `sendMessage(chatId, text)` | Sends text, chunks at 4096 chars |
| `sendTypingIndicator(chatId)` | Calls `sendChatAction` with `typing`, looped every 5s |

### Polling loop

1. Call `GET /bot{token}/getUpdates?offset={lastId+1}&timeout=30`
2. For each update with a text message:
   - Extract `chat.id` and `message.text`
   - Construct `conversationId = "telegram:{chat.id}"`
   - Start typing indicator loop
   - Call `handleUserMessage(conversationId, text)`
   - Send reply via `sendMessage(chat.id, reply)`
   - Persist messages to Convex
   - Stop typing indicator
3. Update offset to highest `update_id + 1`
4. Repeat

### Bot API calls

All via `fetch` to `https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/`:

- `getUpdates` — receive messages (long-poll)
- `sendMessage` — send text
- `sendChatAction` — typing indicator
- `getMe` — token validation (setup script)

### Message formatting

- No markdown stripping needed (Telegram supports it natively)
- Chunk size: 4096 characters (Telegram's limit, up from SendBlue's 2900)

## Call Site Changes

### `server/index.ts`

- Remove: `app.use('/sendblue', sendblueRouter)`
- Add: `startTelegramPoller()` on server boot
- Add: graceful shutdown hook calling `stopTelegramPoller()`

### `server/automations.ts`

- Change: `conversationId.startsWith("sms:")` → `startsWith("telegram:")`
- Change: extract `chatId` from conversationId instead of phone number
- Change: `sendImessage(number, result)` → `sendMessage(chatId, result)`

### `server/proactive-email.ts`

- Change: `sendImessage(phone, summary)` → `sendMessage(chatId, summary)`
- Change: `BOOP_USER_PHONE` → `BOOP_USER_CHAT_ID`

### `server/interaction-agent.ts`

- Change: any `sendImessage()` ack calls → `sendMessage()`

## Data Model Changes

### Removed

- `sendblueDedup` table from `convex/schema.ts` — offset tracking replaces it
- `convex/sendblueDedup.ts` — delete entirely

### Unchanged

- `messages` table — already channel-agnostic (stores `conversationId`, `role`, `content`)
- `conversations` table — unchanged
- `memoryRecords`, `automations` — unchanged

### Note on existing data

Conversations with `sms:` prefix become orphaned. Harmless — can clean up later if desired.

## Configuration

### Environment variables

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather |
| `BOOP_USER_CHAT_ID` | Your Telegram chat ID (for proactive notices) |

### Removed env vars

- `SENDBLUE_API_KEY`
- `SENDBLUE_API_SECRET`
- `SENDBLUE_FROM_NUMBER`
- `SENDBLUE_AUTO_WEBHOOK`
- `BOOP_USER_PHONE`

## Scripts

### Created

- `scripts/telegram-check.mjs` — calls `getMe` to validate bot token during setup

### Deleted

- `scripts/sendblue-webhook.mjs`
- `scripts/sendblue-sync.mjs`

### Modified

- `scripts/dev.mjs` — remove ngrok dependency and webhook registration steps
- `package.json` — remove `sendblue:*` scripts, add `telegram:check`

## Files Summary

| Action | File |
|--------|------|
| Create | `server/telegram.ts` |
| Create | `scripts/telegram-check.mjs` |
| Modify | `server/index.ts` |
| Modify | `server/automations.ts` |
| Modify | `server/proactive-email.ts` |
| Modify | `server/interaction-agent.ts` |
| Modify | `convex/schema.ts` |
| Modify | `.env.example` |
| Modify | `package.json` |
| Modify | `scripts/dev.mjs` |
| Delete | `server/sendblue.ts` |
| Delete | `convex/sendblueDedup.ts` |
| Delete | `scripts/sendblue-webhook.mjs` |
| Delete | `scripts/sendblue-sync.mjs` |

## Setup (for users)

1. Message @BotFather on Telegram → `/newbot` → get token
2. Set `TELEGRAM_BOT_TOKEN` in `.env.local`
3. Message your bot once to establish a chat
4. Get your chat ID (via `getUpdates` response or @userinfobot)
5. Set `BOOP_USER_CHAT_ID` in `.env.local`
6. Run `npm run telegram:check` to verify
7. Start the server — polling begins automatically
