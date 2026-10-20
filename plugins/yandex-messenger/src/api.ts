const API_BASE = "https://botapi.messenger.yandex.net/bot/v1";
const DEFAULT_TIMEOUT_MS = 15_000;

export type YandexUser = {
  id: string;
  login?: string;
  display_name?: string;
  robot?: boolean;
};

export type YandexChat = {
  type: "private" | "group" | "channel";
  id: string;
  thread_id?: number;
};

export type YandexMessage = {
  update_id: number;
  message_id: number;
  timestamp: number;
  chat: YandexChat;
  from: YandexUser;
  text?: string;
  reply_to_message?: {
    message_id: number;
    from?: YandexUser;
    text?: string;
  };
  mentioned_users?: YandexUser[];
};

export type YandexBotInfo = {
  id: string;
  login: string;
  display_name?: string;
};

export class YandexApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "YandexApiError";
    this.status = status;
  }
}

async function call<T>(
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  if (method === "GET" && body) {
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `OAuth ${token}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    body: method === "POST" && body ? JSON.stringify(body) : undefined,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  const json = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!response.ok || json.ok === false) {
    throw new YandexApiError(
      `Yandex Messenger ${path} failed: ${response.status} ${json.description ?? ""}`.trim(),
      response.status,
    );
  }
  return json as T;
}

export async function getSelf(token: string, timeoutMs?: number): Promise<YandexBotInfo> {
  return await call<YandexBotInfo>(token, "GET", "/self/get", undefined, timeoutMs);
}

// offset подтверждает получение: сервер удаляет все обновления с update_id < offset.
export async function getUpdates(
  token: string,
  offset: number,
  signal?: AbortSignal,
): Promise<YandexMessage[]> {
  const result = await call<{ updates?: YandexMessage[] }>(
    token,
    "GET",
    "/messages/getUpdates/",
    { offset, limit: 100 },
    DEFAULT_TIMEOUT_MS,
    signal,
  );
  return result.updates ?? [];
}

export async function getChatName(token: string, chatId: string): Promise<string | undefined> {
  const result = await call<{ data?: { name?: string } }>(token, "GET", "/chats/getChat/", {
    chat_id: chatId,
  });
  return result.data?.name?.trim() || undefined;
}

export type YandexRecipient = { chat_id: string } | { login: string };

export async function sendText(
  token: string,
  recipient: YandexRecipient,
  text: string,
  options: { threadId?: number; replyMessageId?: number; payloadId?: string } = {},
): Promise<{ message_id: number }> {
  return await call<{ message_id: number }>(token, "POST", "/messages/sendText/", {
    ...recipient,
    text,
    thread_id: options.threadId,
    reply_message_id: options.replyMessageId,
    payload_id: options.payloadId,
  });
}

export async function sendTyping(
  token: string,
  recipient: YandexRecipient,
  threadId?: number,
): Promise<void> {
  await call(
    token,
    "POST",
    "/messages/sendTyping/",
    { ...recipient, thread_id: threadId, timeout: 10 },
    5_000,
  );
}
