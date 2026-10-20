import type { YandexBotInfo, YandexMessage, YandexRecipient } from "./api.js";

export const CHANNEL_ID = "yandex-messenger";
const TARGET_PREFIX_RE = /^(yandex-messenger|ym):/i;

export const DEFAULT_DM_DENY_TEXT =
  "Извини, {name}, со мной напрямую может общаться только Андрей.";

export function normalizeTarget(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim().replace(TARGET_PREFIX_RE, "").trim();
  return trimmed || undefined;
}

// Групповые чаты Яндекса имеют вид "0/0/<uuid>", личные — "<userId>_<botId>".
// В логинах Яндекса нет "_", поэтому всё без "/" и "_" считается логином.
export function isGroupChatId(target: string): boolean {
  return target.includes("/");
}

export function toRecipient(target: string): YandexRecipient {
  if (isGroupChatId(target) || target.includes("_")) {
    return { chat_id: target };
  }
  return { login: target };
}

export function isGroupMessage(message: YandexMessage): boolean {
  return message.chat.type === "group" || message.chat.type === "channel";
}

// Тред в Яндексе нумеруется message_id корневого сообщения. Упоминание в общем чате
// открывает новый тред под этим сообщением, поэтому корнем становится оно само.
export function resolveThreadRoot(message: YandexMessage): number | undefined {
  if (!isGroupMessage(message)) {
    return undefined;
  }
  return message.chat.thread_id ?? message.message_id;
}

// Цель вида "<chatId>#<threadId>" адресует тред; без "#" — общий чат.
export function splitThreadTarget(target: string): { chatId: string; threadId?: number } {
  const hashIndex = target.lastIndexOf("#");
  if (hashIndex <= 0) {
    return { chatId: target };
  }
  const threadId = Number(target.slice(hashIndex + 1));
  return Number.isSafeInteger(threadId) && threadId > 0
    ? { chatId: target.slice(0, hashIndex), threadId }
    : { chatId: target };
}

export type MentionFacts = {
  explicit: boolean;
  replyToBot: boolean;
  hasAnyMention: boolean;
};

export function resolveMentionFacts(message: YandexMessage, bot: YandexBotInfo): MentionFacts {
  const mentioned = message.mentioned_users ?? [];
  return {
    explicit: mentioned.some((user) => user.id === bot.id),
    replyToBot: message.reply_to_message?.from?.id === bot.id,
    hasAnyMention: mentioned.length > 0,
  };
}

// Логин бота нечитаем («yndx-mssngr-…-bot»), агенту он передаётся отображаемым именем.
export function buildAgentBody(message: YandexMessage, bot: YandexBotInfo): string {
  const botName = bot.display_name?.trim() || "бот";
  const text = (message.text ?? "").split(`@${bot.login}`).join(`@${botName}`).trim();
  const quoted = message.reply_to_message?.text?.trim();
  if (!quoted) {
    return text;
  }
  const author = message.reply_to_message?.from?.display_name ?? "собеседник";
  return `[в ответ на сообщение ${author}: «${quoted}»]\n${text}`;
}

export function formatDmDenyText(template: string | undefined, name: string | undefined): string {
  return (template?.trim() || DEFAULT_DM_DENY_TEXT).replaceAll("{name}", name?.trim() || "коллега");
}

// Отказ в личке одному человеку — не чаще раза в интервал, чтобы не вести переписку с автоответчиком.
export class DenyRateLimiter {
  private readonly lastSentAt = new Map<string, number>();
  private readonly intervalMs: number;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  shouldSend(senderId: string, now = Date.now()): boolean {
    const last = this.lastSentAt.get(senderId);
    if (last !== undefined && now - last < this.intervalMs) {
      return false;
    }
    this.lastSentAt.set(senderId, now);
    return true;
  }
}
