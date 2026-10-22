import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-outbound";
import {
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createStaticReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import { buildChannelOutboundSessionRoute } from "openclaw/plugin-sdk/core";
import { sendPayloadWithChunkedTextAndMedia } from "openclaw/plugin-sdk/reply-payload";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  chunkTextForOutbound,
  sanitizeAssistantVisibleText,
} from "openclaw/plugin-sdk/text-chunking";
import {
  inspectAccount,
  isAccountConfigured,
  listAccountIds,
  resolveAccount,
  type ResolvedYandexAccount,
} from "./accounts.js";
import { getSelf, sendText } from "./api.js";
import { redactForLog, sendMediaWithCaption, type MediaAccess } from "./media.js";
import { CaptionSender, mediaFailureNotice, resolveMediaMaxBytes } from "./media-policy.js";
import { monitorYandexProvider, TEXT_CHUNK_LIMIT } from "./monitor.js";
import {
  CHANNEL_ID,
  isGroupChatId,
  normalizeTarget,
  splitThreadTarget,
  toRecipient,
} from "./policy.js";

type ProbeResult = { ok: boolean; error?: string; bot?: { id: string; login: string } };

const meta = {
  id: CHANNEL_ID,
  label: "Yandex Messenger",
  selectionLabel: "Yandex Messenger (Яндекс 360 Bot API)",
  docsPath: "/channels/yandex-messenger",
  blurb: "Групповые чаты и треды Яндекс Мессенджера (Яндекс 360).",
  aliases: ["ym"],
  order: 90,
};

function stripPrefix(entry: string): string {
  return entry.trim().replace(/^(yandex-messenger|ym):/i, "");
}

type OutboundCtx = {
  cfg: OpenClawConfig;
  agentId?: string | null;
  to: string;
  text: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

function resolveOutboundTarget(ctx: OutboundCtx) {
  const account = resolveAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
  if (!account.token) {
    throw new Error(`${CHANNEL_ID}: token is not configured`);
  }
  const target = normalizeTarget(ctx.to);
  if (!target) {
    throw new Error(`${CHANNEL_ID}: empty target`);
  }
  const { chatId, threadId: targetThreadId } = splitThreadTarget(target);
  const explicitThreadId =
    ctx.threadId != null && String(ctx.threadId).trim() !== "" ? Number(ctx.threadId) : undefined;
  const threadId =
    targetThreadId ??
    (explicitThreadId !== undefined && Number.isSafeInteger(explicitThreadId) && explicitThreadId > 0
      ? explicitThreadId
      : undefined);
  return { account, recipient: toRecipient(chatId), threadId };
}

async function sendOutboundText(ctx: OutboundCtx): Promise<{ messageId: string }> {
  const { account, recipient, threadId } = resolveOutboundTarget(ctx);
  const text = sanitizeAssistantVisibleText(ctx.text);
  if (!text.trim()) {
    throw new Error(`${CHANNEL_ID}: nothing to send after sanitizing text`);
  }
  const result = await sendText(account.token, recipient, text, { threadId });
  return { messageId: String(result.message_id) };
}

async function sendOutboundMedia(
  ctx: OutboundCtx & {
    mediaUrl?: string;
    mediaAccess?: MediaAccess;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    forceDocument?: boolean;
  },
): Promise<{ messageId: string }> {
  if (!ctx.mediaUrl) {
    return await sendOutboundText(ctx);
  }
  const { account, recipient, threadId } = resolveOutboundTarget(ctx);
  const mediaUrl = ctx.mediaUrl;
  const caption = sanitizeAssistantVisibleText(ctx.text ?? "").trim();
  const sendOne = async (chunk: string) => {
    await sendText(account.token, recipient, chunk, { threadId });
  };
  const captionSender = new CaptionSender(chunkTextForOutbound(caption, TEXT_CHUNK_LIMIT), sendOne);
  try {
    const result = await sendMediaWithCaption({
      token: account.token,
      cfg: ctx.cfg,
      agentId: ctx.agentId ?? undefined,
      recipient,
      mediaUrl,
      threadId,
      maxBytes: resolveMediaMaxBytes(account.config.mediaMaxMb),
      forceDocument: ctx.forceDocument,
      access: {
        localRoots: ctx.mediaAccess?.localRoots ?? ctx.mediaLocalRoots,
        readFile: ctx.mediaAccess?.readFile ?? ctx.mediaReadFile,
        workspaceDir: ctx.mediaAccess?.workspaceDir,
      },
      sendCaption: captionSender.isEmpty ? undefined : () => captionSender.sendAll(),
    });
    return { messageId: String(result.message_id) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const notice = [captionSender.remainingText(), mediaFailureNotice(mediaUrl)]
      .filter(Boolean)
      .join("\n\n");
    let noticeDelivered = true;
    try {
      for (const chunk of chunkTextForOutbound(notice, TEXT_CHUNK_LIMIT)) {
        await sendOne(chunk);
      }
    } catch {
      noticeDelivered = false;
    }
    throw new Error(
      `${CHANNEL_ID}: media send failed (${redactForLog(mediaUrl)}): ${redactForLog(reason)}` +
        (noticeDelivered ? "" : "; failure notice was not delivered either"),
      { cause: err },
    );
  }
}

const sendResultAdapter = createAttachedChannelResultAdapter({
  channel: CHANNEL_ID,
  sendText: sendOutboundText,
  sendMedia: sendOutboundMedia,
});

const configAdapter = createScopedChannelConfigAdapter<ResolvedYandexAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveAccount),
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  clearBaseFields: ["token", "name"],
  resolveAllowFrom: (account: ResolvedYandexAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(yandex-messenger|ym):/i }),
});

const resolveDmPolicy = createScopedDmSecurityResolver<ResolvedYandexAccount>({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.config.dmPolicy ?? "allowlist",
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: stripPrefix,
});

async function probeAccount(account: ResolvedYandexAccount, timeoutMs?: number): Promise<ProbeResult> {
  if (!account.token) {
    return { ok: false, error: "token missing" };
  }
  try {
    const bot = await getSelf(account.token, timeoutMs);
    return { ok: true, bot: { id: bot.id, login: bot.login } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const yandexMessengerPlugin: ChannelPlugin<ResolvedYandexAccount, ProbeResult> =
  createChatChannelPlugin({
    base: {
      id: CHANNEL_ID,
      meta,
      capabilities: {
        chatTypes: ["direct", "group"],
        media: true,
        reactions: false,
        threads: true,
        polls: false,
        nativeCommands: false,
        blockStreaming: true,
      },
      reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
      config: {
        ...configAdapter,
        inspectAccount: adaptScopedAccountAccessor(inspectAccount),
        isConfigured: isAccountConfigured,
      },
      groups: {
        resolveRequireMention: () => true,
      },
      messaging: {
        targetPrefixes: [CHANNEL_ID, "ym"],
        normalizeTarget,
        inferTargetChatType: ({ to }) => {
          const target = normalizeTarget(to);
          if (!target) return undefined;
          return isGroupChatId(splitThreadTarget(target).chatId) ? "group" : "direct";
        },
        resolveOutboundSessionRoute: (params) => {
          const target = normalizeTarget(params.target);
          if (!target) return null;
          const { chatId, threadId } = splitThreadTarget(target);
          const isGroup = isGroupChatId(chatId);
          return buildChannelOutboundSessionRoute({
            cfg: params.cfg,
            agentId: params.agentId,
            channel: CHANNEL_ID,
            accountId: params.accountId,
            recipientSessionExact: true,
            peer: { kind: isGroup ? "group" : "direct", id: chatId },
            chatType: isGroup ? "group" : "direct",
            from: isGroup ? `${CHANNEL_ID}:group:${chatId}` : `${CHANNEL_ID}:${chatId}`,
            to: `${CHANNEL_ID}:${target}`,
            threadId,
          });
        },
        targetResolver: {
          looksLikeId: (raw: string) => Boolean(normalizeTarget(raw)),
          hint: "<chatId>[#threadId] или <login>",
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedYandexAccount, ProbeResult>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        probeAccount: async ({ account, timeoutMs }) => await probeAccount(account, timeoutMs),
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: isAccountConfigured(account),
          extra: {
            tokenSource: account.tokenSource,
            mode: "polling",
            dmPolicy: account.config.dmPolicy ?? "allowlist",
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          const bot = await getSelf(account.token);
          ctx.setStatus({ accountId: account.accountId, bot: { id: bot.id, login: bot.login } });
          ctx.log?.info(
            `[${account.accountId}] starting Yandex Messenger provider as ${bot.display_name ?? bot.login}`,
          );
          return await monitorYandexProvider({
            token: account.token,
            bot,
            account,
            config: ctx.cfg,
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
            statusSink: createAccountStatusSink({
              accountId: ctx.accountId,
              setStatus: ctx.setStatus,
            }),
          });
        },
      },
    },
    security: {
      resolveDmPolicy,
    },
    threading: {
      resolveReplyToMode: createStaticReplyToModeResolver("off"),
    },
    outbound: {
      deliveryMode: "direct",
      chunker: chunkTextForOutbound,
      chunkerMode: "text",
      textChunkLimit: TEXT_CHUNK_LIMIT,
      sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
      sendPayload: async (ctx) =>
        await sendPayloadWithChunkedTextAndMedia({
          ctx,
          textChunkLimit: TEXT_CHUNK_LIMIT,
          chunker: chunkTextForOutbound,
          sendText: (nextCtx) => sendResultAdapter.sendText!(nextCtx),
          sendMedia: (nextCtx) => sendResultAdapter.sendMedia!(nextCtx),
          emptyResult: createEmptyChannelResult(CHANNEL_ID),
          onResult: ctx.onDeliveryResult,
        }),
      ...sendResultAdapter,
    },
  });
