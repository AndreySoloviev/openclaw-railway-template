import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  implicitMentionKindWhen,
  resolveChannelInboundRouteEnvelope,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelImplicitMentions } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedYandexAccount } from "./accounts.js";
import {
  getChatName,
  getUpdates,
  sendText,
  sendTyping,
  YandexApiError,
  type YandexBotInfo,
  type YandexMessage,
} from "./api.js";
import {
  buildAgentBody,
  CHANNEL_ID,
  DenyRateLimiter,
  formatDmDenyText,
  isGroupMessage,
  resolveMentionFacts,
  resolveThreadRoot,
} from "./policy.js";
import { getYandexRuntime } from "./runtime.js";
import { PluginStateFile, resolvePluginStatePath } from "./state-file.js";

export const TEXT_CHUNK_LIMIT = 4000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const ERROR_BACKOFF_MS = 5000;
const MAX_ERROR_BACKOFF_MS = 60_000;

type CoreRuntime = ReturnType<typeof getYandexRuntime>;

export type StatusSink = (patch: {
  connected?: boolean;
  lifecycle?: "ready" | "recovering";
  lastError?: string | null;
  lastInboundAt?: number;
  lastOutboundAt?: number;
}) => void;

export type RuntimeLog = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type MonitorContext = {
  token: string;
  bot: YandexBotInfo;
  account: ResolvedYandexAccount;
  config: OpenClawConfig;
  runtime: RuntimeLog;
  core: CoreRuntime;
  statusSink?: StatusSink;
  denyLimiter: DenyRateLimiter;
  chatNames: Map<string, string | undefined>;
  state: PluginStateFile;
};

function botThreadKey(chatId: string, threadRoot: number): string {
  return `${chatId}#${threadRoot}`;
}

function normalizeAllowEntry(value: string): string {
  return value.trim().replace(/^(yandex-messenger|ym):/i, "").trim().toLowerCase();
}

function logVerbose(ctx: MonitorContext, message: string): void {
  if (ctx.core.logging.shouldLogVerbose()) {
    ctx.runtime.log?.(`[${CHANNEL_ID}] ${message}`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function resolveChatLabel(ctx: MonitorContext, chatId: string): Promise<string | undefined> {
  if (ctx.chatNames.has(chatId)) {
    return ctx.chatNames.get(chatId);
  }
  try {
    const name = await getChatName(ctx.token, chatId);
    ctx.chatNames.set(chatId, name);
    return name;
  } catch {
    return undefined;
  }
}

async function sendDmDeny(ctx: MonitorContext, message: YandexMessage): Promise<void> {
  const senderId = message.from.id;
  const intervalHours = ctx.account.config.dmDenyIntervalHours ?? 24;
  if (!ctx.denyLimiter.shouldSend(senderId)) {
    logVerbose(ctx, `drop dm ${senderId}: deny already sent within ${intervalHours}h`);
    return;
  }
  const text = formatDmDenyText(ctx.account.config.dmDenyText, message.from.display_name);
  await sendText(ctx.token, { chat_id: message.chat.id }, text);
  ctx.statusSink?.({ lastOutboundAt: Date.now() });
  ctx.runtime.log?.(`[${CHANNEL_ID}] dm denied for ${senderId} (not in allowFrom)`);
}

async function handleMessage(ctx: MonitorContext, message: YandexMessage): Promise<void> {
  const { core, config, account } = ctx;
  const rawBody = message.text?.trim() ?? "";
  if (!rawBody || message.from.robot || message.from.id === ctx.bot.id) {
    return;
  }

  const isGroup = isGroupMessage(message);
  const chatId = message.chat.id;
  const senderId = message.from.id;
  const senderName = message.from.display_name?.trim() || message.from.login;
  const dmPolicy = account.config.dmPolicy ?? "allowlist";
  const groupPolicy = account.config.groupPolicy ?? "open";

  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const resolveIngress = async (
    contextBinding?: Parameters<typeof core.channel.inbound.ingress.resolveStable>[0]["contextBinding"],
  ) =>
    await core.channel.inbound.ingress.resolveStable({
      channelId: CHANNEL_ID,
      accountId: account.accountId,
      identity: {
        key: "yandex-messenger-user-id",
        normalize: normalizeAllowEntry,
        sensitivity: "pii",
        entryIdPrefix: "yandex-messenger-entry",
      },
      cfg: config,
      readStoreAllowFrom: async () => [],
      subject: { stableId: senderId },
      conversation: { kind: isGroup ? "group" : "direct", id: chatId },
      contextBinding,
      providerMissingFallbackApplied: false,
      dmPolicy,
      groupPolicy,
      policy: { groupAllowFromFallbackToAllowFrom: false },
      allowFrom: normalizeStringEntries(account.config.allowFrom),
      groupAllowFrom: normalizeStringEntries(account.config.groupAllowFrom),
      command: shouldComputeAuth ? {} : undefined,
    });

  const access = await resolveIngress();
  if (!access.senderAccess.allowed) {
    if (isGroup) {
      logVerbose(ctx, `drop group ${chatId} sender ${senderId}: ${access.senderAccess.reasonCode}`);
      return;
    }
    if (dmPolicy === "disabled") {
      logVerbose(ctx, `drop dm ${senderId}: dmPolicy=disabled`);
      return;
    }
    await sendDmDeny(ctx, message);
    return;
  }

  const commandAuthorized = access.commandAccess.requested
    ? access.commandAccess.authorized
    : undefined;
  const hasControlCommand = core.channel.commands.isControlCommandMessage(rawBody, config);

  const threadRoot = resolveThreadRoot(message);
  const inExistingThread = message.chat.thread_id != null;
  let wasMentioned = false;
  if (isGroup && threadRoot !== undefined) {
    const isBotOwnedThread =
      inExistingThread && ctx.state.hasBotThread(botThreadKey(chatId, threadRoot));
    const facts = resolveMentionFacts(message, ctx.bot);
    const decision = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: facts.explicit,
        hasAnyMention: facts.hasAnyMention,
        implicitMentionKinds: implicitMentionKindWhen("reply_to_bot", facts.replyToBot),
      },
      policy: {
        isGroup: true,
        // В треде, который открыл сам Леонид, разговор продолжается без упоминаний.
        requireMention: !isBotOwnedThread,
        implicitMentions: resolveChannelImplicitMentions({
          cfg: config,
          channel: CHANNEL_ID,
          accountId: account.accountId,
        }),
        allowTextCommands: true,
        hasControlCommand,
        commandAuthorized: commandAuthorized === true,
      },
    });
    if (decision.shouldSkip) {
      logVerbose(
        ctx,
        `skip group ${chatId} msg ${message.message_id}: no mention (thread=${inExistingThread ? threadRoot : "-"}, botThread=${isBotOwnedThread})`,
      );
      return;
    }
    wasMentioned = decision.effectiveWasMentioned;
    if (hasControlCommand && commandAuthorized !== true) {
      logVerbose(ctx, `drop control command from unauthorized sender ${senderId}`);
      return;
    }
  }

  const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: isGroup ? "group" : "direct", id: chatId },
  });
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: route.sessionKey,
    threadId: threadRoot !== undefined ? String(threadRoot) : undefined,
    parentSessionKey: route.sessionKey,
  });
  const sessionKey = threadKeys.sessionKey;
  const channelIngress = await resolveIngress({
    agentId: route.agentId,
    sessionKey,
    messageId: String(message.message_id),
    inboundEventKind: "user_request",
  });
  if (!channelIngress.senderAccess.allowed) {
    logVerbose(ctx, `authorization changed before dispatch for ${senderId}`);
    return;
  }

  const groupName = isGroup ? await resolveChatLabel(ctx, chatId) : undefined;
  const fromLabel = isGroup
    ? `${groupName ?? "group"} (${chatId}) — ${senderName ?? senderId}`
    : (senderName ?? `user:${senderId}`);
  const agentBody = buildAgentBody(message, ctx.bot);
  const timestamp = message.timestamp * 1000;
  const body = buildEnvelope({
    channel: "Yandex Messenger",
    from: fromLabel,
    timestamp,
    body: agentBody,
  });

  const ctxPayload = core.channel.inbound.buildContext({
    channelIngress,
    channel: CHANNEL_ID,
    accountId: route.accountId,
    messageId: String(message.message_id),
    timestamp,
    from: isGroup ? `${CHANNEL_ID}:group:${chatId}` : `${CHANNEL_ID}:${senderId}`,
    sender: { id: senderId, name: senderName || undefined },
    conversation: {
      kind: isGroup ? "group" : "direct",
      id: chatId,
      label: isGroup ? (groupName ?? chatId) : fromLabel,
      threadId: threadRoot !== undefined ? String(threadRoot) : undefined,
      parentId: threadRoot !== undefined ? chatId : undefined,
      routePeer: { kind: isGroup ? "group" : "direct", id: chatId },
    },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: sessionKey,
      parentSessionKey: threadKeys.parentSessionKey,
    },
    reply: {
      to: threadRoot !== undefined
        ? `${CHANNEL_ID}:${chatId}#${threadRoot}`
        : `${CHANNEL_ID}:${chatId}`,
      messageThreadId: threadRoot,
      sourceReplyDeliveryMode: threadRoot !== undefined ? "thread" : "direct",
    },
    message: {
      body,
      bodyForAgent: agentBody,
      rawBody,
      commandBody: rawBody,
    },
    extra: {
      CommandAuthorized: commandAuthorized,
      GroupSubject: groupName,
      WasMentioned: isGroup ? wasMentioned : undefined,
    },
  });

  // Тред отмечается до ответа модели: уточнение без упоминания, отправленное в тред,
  // пока модель думает, иначе было бы отброшено.
  if (isGroup && threadRoot !== undefined && !inExistingThread && wasMentioned) {
    await ctx.state.addBotThread(botThreadKey(chatId, threadRoot)).catch((err: unknown) => {
      ctx.runtime.error?.(`[${CHANNEL_ID}] failed to remember thread ${threadRoot}: ${String(err)}`);
    });
  }

  await core.channel.inbound.dispatch({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey },
    ctxPayload,
    delivery: {
      deliver: async (payload: OutboundReplyPayload) => {
        const reply = resolveSendableOutboundReplyParts(payload);
        const chunkMode = core.channel.text.resolveChunkMode(config, CHANNEL_ID, account.accountId);
        await deliverTextOrMediaReply({
          payload,
          text: reply.text,
          chunkText: (value: string) =>
            core.channel.text.chunkMarkdownTextWithMode(value, TEXT_CHUNK_LIMIT, chunkMode),
          sendText: async (chunk: string) => {
            await sendText(ctx.token, { chat_id: chatId }, chunk, { threadId: threadRoot });
            ctx.statusSink?.({ lastOutboundAt: Date.now() });
          },
          sendMedia: async ({ mediaUrl, caption }: { mediaUrl: string; caption?: string }) => {
            const text = [caption, mediaUrl].filter(Boolean).join("\n");
            await sendText(ctx.token, { chat_id: chatId }, text, { threadId: threadRoot });
            ctx.statusSink?.({ lastOutboundAt: Date.now() });
          },
        });
      },
      onError: (err: unknown, info: { kind: string }) => {
        ctx.runtime.error?.(`[${CHANNEL_ID}] ${info.kind} reply failed: ${describeError(err)}`);
      },
    },
    replyPipeline: {
      typing: {
        start: async () => {
          await sendTyping(ctx.token, { chat_id: chatId }, threadRoot);
        },
        onStartError: (err: unknown) => {
          logTypingFailure({
            log: (line: string) => logVerbose(ctx, line),
            channel: CHANNEL_ID,
            action: "start",
            target: chatId,
            error: err,
          });
        },
      },
    },
    record: {
      onRecordError: (err: unknown) => {
        ctx.runtime.error?.(`[${CHANNEL_ID}] failed updating session meta: ${String(err)}`);
      },
    },
  });
}

export type MonitorOptions = {
  token: string;
  bot: YandexBotInfo;
  account: ResolvedYandexAccount;
  config: OpenClawConfig;
  runtime: RuntimeLog;
  abortSignal: AbortSignal;
  statusSink?: StatusSink;
};

export async function monitorYandexProvider(options: MonitorOptions): Promise<void> {
  const { token, account, runtime, abortSignal, statusSink } = options;
  const core = getYandexRuntime();
  const state = new PluginStateFile(resolvePluginStatePath(account.accountId));
  await state.load();
  if (state.loadError) {
    runtime.error?.(`[${account.accountId}] ${state.loadError}`);
  }
  let offset = state.offset;
  let errorBackoffMs = ERROR_BACKOFF_MS;
  const pollIntervalMs = account.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const ctx: MonitorContext = {
    token,
    bot: options.bot,
    account,
    config: options.config,
    runtime,
    core,
    statusSink,
    denyLimiter: new DenyRateLimiter((account.config.dmDenyIntervalHours ?? 24) * 3_600_000),
    chatNames: new Map(),
    state,
  };

  runtime.log?.(
    `[${account.accountId}] Yandex Messenger polling started offset=${offset} interval=${pollIntervalMs}ms`,
  );

  while (!abortSignal.aborted) {
    let received = 0;
    try {
      const updates = await getUpdates(token, offset, abortSignal);
      statusSink?.(channelReadyPatch());
      errorBackoffMs = ERROR_BACKOFF_MS;
      received = updates.length;
      for (const update of updates) {
        if (abortSignal.aborted) break;
        if (!Number.isSafeInteger(update.update_id)) continue;
        // Offset сохраняется до обработки: при падении посреди ответа сообщение
        // теряется, но не обрабатывается повторно и не даёт дублей в чате.
        offset = Math.max(offset, update.update_id + 1);
        await state.setOffset(offset);
        statusSink?.({ lastInboundAt: Date.now() });
        void handleMessage(ctx, update).catch((err: unknown) => {
          runtime.error?.(`[${CHANNEL_ID}] update ${update.update_id} failed: ${describeError(err)}`);
        });
      }
    } catch (err) {
      if (abortSignal.aborted) break;
      const error = err instanceof YandexApiError ? err.message : describeError(err);
      runtime.error?.(
        `[${account.accountId}] Yandex Messenger polling error (retry in ${errorBackoffMs / 1000}s): ${error}`,
      );
      statusSink?.({ connected: false, lifecycle: "recovering", lastError: error });
      await sleepWithAbort(errorBackoffMs, abortSignal).catch(() => undefined);
      errorBackoffMs = Math.min(errorBackoffMs * 2, MAX_ERROR_BACKOFF_MS);
      continue;
    }
    if (received === 0) {
      await sleepWithAbort(pollIntervalMs, abortSignal).catch(() => undefined);
    }
  }
  runtime.log?.(`[${account.accountId}] Yandex Messenger polling stopped`);
}
