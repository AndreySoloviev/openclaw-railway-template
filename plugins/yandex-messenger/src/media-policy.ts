const DEFAULT_MEDIA_MAX_MB = 50;
// Форматы, которые Мессенджер показывает картинкой; остальное уходит документом.
const INLINE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MIN_UPLOAD_TIMEOUT_MS = 120_000;
const MIN_UPLOAD_BYTES_PER_SECOND = 256 * 1024;

export function resolveMediaMaxBytes(mediaMaxMb: number | undefined): number {
  const mb = typeof mediaMaxMb === "number" && mediaMaxMb > 0 ? mediaMaxMb : DEFAULT_MEDIA_MAX_MB;
  return Math.floor(mb * 1024 * 1024);
}

export function resolveUploadTimeoutMs(bytes: number): number {
  return Math.max(MIN_UPLOAD_TIMEOUT_MS, Math.ceil((bytes / MIN_UPLOAD_BYTES_PER_SECOND) * 1000));
}

function lastPathSegment(mediaUrl: string): string | undefined {
  let path = mediaUrl;
  if (/^https?:\/\//i.test(mediaUrl)) {
    try {
      path = new URL(mediaUrl).pathname;
    } catch {
      return undefined;
    }
  }
  const segment = path.split(/[?#]/)[0].split("/").pop()?.trim();
  if (!segment) return undefined;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // сегмент с битым percent-encoding оставляем как есть
  }
  // %2F и %5C после декодирования снова дают разделители — берём только последнее имя.
  return decoded.split(/[\\/]/).pop()?.trim() || undefined;
}

// extension — расширение без точки (например, из extensionForMime).
export function fallbackFileName(mediaUrl: string, extension?: string): string {
  const fromPath = lastPathSegment(mediaUrl);
  if (fromPath) return fromPath;
  const ext = extension?.replace(/^\./, "");
  return ext ? `file.${ext}` : "file";
}

export function shouldSendAsImage(contentType: string | undefined, forceDocument?: boolean): boolean {
  return !forceDocument && INLINE_IMAGE_TYPES.has((contentType ?? "").split(";")[0].trim().toLowerCase());
}

export function mediaFailureNotice(mediaUrl: string): string {
  return `Не получилось отправить файл «${fallbackFileName(mediaUrl)}».`;
}

// Подпись к файлу уходит частями; при сбое досылается только то, что ещё не отправлено,
// чтобы ни одна часть не пришла дважды.
export class CaptionSender {
  private sent = 0;
  private readonly chunks: string[];
  private readonly sendOne: (chunk: string) => Promise<void>;

  constructor(chunks: string[], sendOne: (chunk: string) => Promise<void>) {
    this.chunks = chunks.filter((chunk) => chunk.trim());
    this.sendOne = sendOne;
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  async sendAll(): Promise<void> {
    while (this.sent < this.chunks.length) {
      await this.sendOne(this.chunks[this.sent]);
      this.sent += 1;
    }
  }

  remainingText(): string {
    return this.chunks.slice(this.sent).join("\n");
  }
}
