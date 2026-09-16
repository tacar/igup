import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { emptyData, DEFAULT_SETTINGS, type AppData, type LogCategory, type LogEntry } from "./types.js";
import { newId, nowIso } from "./ids.js";

const LOG_LIMIT = 2_000;
const SEEN_LIMIT = 5_000;
const WRITE_DELAY_MS = 250;

export type DataListener = (event: { type: string; payload?: unknown }) => void;

/** JSON-backed store for all non-secret application data (rules, schedules, logs, snapshots). */
export class DataStore {
  private data: AppData = emptyData();
  private writeTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<DataListener>();

  constructor(private readonly filePath: string) {}

  static inDirectory(directory: string): DataStore {
    return new DataStore(join(directory, "igup-data.json"));
  }

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<AppData>;
      this.data = normalize(parsed);
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
      if (code !== "ENOENT") throw new Error("保存データを読み込めませんでした。", { cause });
      this.data = emptyData();
    }
  }

  get(): AppData {
    return this.data;
  }

  /** Mutates the in-memory data and schedules a debounced atomic write. */
  update<T>(mutator: (data: AppData) => T, event?: string): T {
    const result = mutator(this.data);
    this.scheduleWrite();
    if (event) this.emit(event);
    return result;
  }

  replace(data: AppData): void {
    this.data = normalize(data);
    this.scheduleWrite();
    this.emit("data:replaced");
  }

  log(level: LogEntry["level"], category: LogCategory, title: string, detail = ""): LogEntry {
    const entry: LogEntry = { id: newId("log"), at: nowIso(), level, category, title, detail };
    this.update((data) => {
      data.logs.unshift(entry);
      if (data.logs.length > LOG_LIMIT) data.logs.length = LOG_LIMIT;
    });
    this.emit("log", entry);
    return entry;
  }

  markSeen(kind: "comments" | "messages", id: string): boolean {
    const list = this.data.seen[kind];
    if (list.includes(id)) return false;
    this.update((data) => {
      data.seen[kind].push(id);
      if (data.seen[kind].length > SEEN_LIMIT) data.seen[kind].splice(0, data.seen[kind].length - SEEN_LIMIT);
    });
    return true;
  }

  hasSeen(kind: "comments" | "messages", id: string): boolean {
    return this.data.seen[kind].includes(id);
  }

  subscribe(listener: DataListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
      await this.write();
    }
    await this.writing;
  }

  private emit(type: string, payload?: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(payload === undefined ? { type } : { type, payload });
      } catch {
        // listeners must not break persistence
      }
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.write();
    }, WRITE_DELAY_MS);
  }

  private write(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    }).catch(() => undefined);
    return this.writing;
  }
}

export function normalize(input: Partial<AppData>): AppData {
  const base = emptyData();
  const data: AppData = { ...base, ...input, version: 1 };
  data.settings = { ...DEFAULT_SETTINGS, ...(input.settings ?? {}) };
  data.seen = { ...base.seen, ...(input.seen ?? {}) };
  for (const key of ["rules", "posts", "memos", "pending", "logs", "accountSnapshots", "mediaSnapshots", "storySnapshots", "seminars", "links"] as const) {
    if (!Array.isArray(data[key])) (data as unknown as Record<string, unknown>)[key] = [];
  }
  if (!data.cooldowns || typeof data.cooldowns !== "object") data.cooldowns = {};
  if (!data.contacts || typeof data.contacts !== "object") data.contacts = {};
  return data;
}
