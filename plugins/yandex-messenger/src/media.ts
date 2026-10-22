import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { redactSensitiveUrlLikeString } from "openclaw/plugin-sdk/gateway-runtime";
import {
  buildOutboundMediaLoadOptions,
  extensionForMime,
  getAgentScopedMediaLocalRoots,
} from "openclaw/plugin-sdk/media-runtime";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { sendFile, sendImage, YandexApiError, type YandexRecipient, type YandexUpload } from "./api.js";
import { fallbackFileName, resolveUploadTimeoutMs, shouldSendAsImage } from "./media-policy.js";

const MEDIA_READ_IDLE_TIMEOUT_MS = 30_000;
// Ответы Яндекса «формат не принят» — на них картинку можно переотправить документом.
const IMAGE_FORMAT_REJECT_STATUSES = new Set([400, 415, 422]);

export type MediaAccess = {
  localRoots?: readonly string[];
  readFile?: (filePath: string) => Promise<Buffer>;
  workspaceDir?: string;
};

export function redactForLog(value: string): string {
  return redactSensitiveUrlLikeString(value);
}

async function loadUpload(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  mediaUrl: string;
  maxBytes: number;
  access?: MediaAccess;
}): Promise<YandexUpload> {
  const workspaceDir =
    params.access?.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const options = buildOutboundMediaLoadOptions({
    maxBytes: params.maxBytes,
    mediaAccess: params.access?.readFile
      ? { ...params.access, workspaceDir }
      : undefined,
    mediaLocalRoots:
      params.access?.localRoots ?? getAgentScopedMediaLocalRoots(params.cfg, params.agentId),
    workspaceDir,
  });
  const media = await loadWebMediaRaw(params.mediaUrl, {
    ...options,
    readIdleTimeoutMs: MEDIA_READ_IDLE_TIMEOUT_MS,
  });
  return {
    data: new Uint8Array(media.buffer),
    fileName:
      media.fileName?.trim() ||
      fallbackFileName(params.mediaUrl, extensionForMime(media.contentType)),
    contentType: media.contentType,
  };
}

// Файл загружается до подписи: если он недоступен, в чате не остаётся подписи без файла.
export async function sendMediaWithCaption(params: {
  token: string;
  cfg: OpenClawConfig;
  agentId?: string;
  recipient: YandexRecipient;
  mediaUrl: string;
  threadId?: number;
  maxBytes: number;
  access?: MediaAccess;
  forceDocument?: boolean;
  sendCaption?: () => Promise<void>;
}): Promise<{ message_id: number }> {
  const upload = await loadUpload(params);
  await params.sendCaption?.();
  const timeoutMs = resolveUploadTimeoutMs(upload.data.byteLength);
  const options = { threadId: params.threadId, timeoutMs };
  if (shouldSendAsImage(upload.contentType, params.forceDocument)) {
    try {
      return await sendImage(params.token, params.recipient, upload, options);
    } catch (err) {
      if (!(err instanceof YandexApiError) || !IMAGE_FORMAT_REJECT_STATUSES.has(err.status)) {
        throw err;
      }
    }
  }
  return await sendFile(params.token, params.recipient, upload, options);
}
