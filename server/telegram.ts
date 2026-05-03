import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";

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
