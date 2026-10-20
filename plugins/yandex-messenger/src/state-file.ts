import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const THREAD_TTL_MS = 90 * 24 * 3_600_000;
const MAX_THREADS = 20_000;

type StateData = {
  offset: number;
  botThreads: Record<string, number>;
};

export function resolvePluginStatePath(accountId: string): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
  return join(stateDir, "yandex-messenger", `${accountId}.json`);
}

// Хранилище плагина: offset polling и треды, которые открыл бот.
// keyedStore из SDK недоступен локальным плагинам, поэтому состояние живёт в файле
// каталога состояния OpenClaw (на томе), запись атомарна через rename.
export class PluginStateFile {
  private data: StateData = { offset: 0, botThreads: {} };
  private writeChain: Promise<void> = Promise.resolve();
  private writeSeq = 0;
  loadError?: string;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StateData> | null;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("state file is not an object");
      }
      this.data = {
        offset: Number.isSafeInteger(parsed?.offset) ? (parsed?.offset as number) : 0,
        botThreads:
          parsed?.botThreads && typeof parsed.botThreads === "object" ? parsed.botThreads : {},
      };
    } catch {
      this.loadError = `corrupt state file ${this.path}, starting from empty state`;
    }
    this.prune(Date.now());
  }

  get offset(): number {
    return this.data.offset;
  }

  async setOffset(offset: number): Promise<void> {
    if (offset <= this.data.offset) return;
    this.data.offset = offset;
    await this.persist();
  }

  hasBotThread(key: string, now = Date.now()): boolean {
    const openedAt = this.data.botThreads[key];
    return openedAt !== undefined && now - openedAt < THREAD_TTL_MS;
  }

  async addBotThread(key: string, now = Date.now()): Promise<void> {
    if (this.data.botThreads[key] !== undefined) return;
    this.data.botThreads[key] = now;
    this.prune(now);
    await this.persist();
  }

  private prune(now: number): void {
    const entries = Object.entries(this.data.botThreads).filter(
      ([, openedAt]) => now - openedAt < THREAD_TTL_MS,
    );
    entries.sort((a, b) => b[1] - a[1]);
    this.data.botThreads = Object.fromEntries(entries.slice(0, MAX_THREADS));
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.${process.pid}.${++this.writeSeq}.tmp`;
        await writeFile(tmp, snapshot, { mode: 0o600 });
        await rename(tmp, this.path);
      });
    return this.writeChain;
  }
}
