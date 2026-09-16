import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_ACCOUNT_ID, emptyData, DEFAULT_SETTINGS, type AccountInfo, type AppData, type LogCategory, type LogEntry } from "./types.js";
import { newId, nowIso } from "./ids.js";

const LOG_LIMIT = 2_000;
const SEEN_LIMIT = 5_000;
const WRITE_DELAY_MS = 250;

const COLLECTION_KEYS = ["rules", "posts", "memos", "pending", "logs", "accountSnapshots", "mediaSnapshots", "storySnapshots", "seminars", "links"] as const;
/** Collections whose elements carry an accountId that must exist after migration. */
const ACCOUNT_SCOPED_KEYS = new Set(["rules", "posts", "pending", "accountSnapshots", "mediaSnapshots", "storySnapshots", "seminars"]);

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
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
      if (code !== "ENOENT") throw new Error("保存データを読み込めませんでした。", { cause });
      this.data = emptyData();
      return;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const isCurrent = Boolean(parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version === 2);
    if (parsed && !isCurrent) {
      // keep the pre-migration file around once, in case the user wants to roll back
      await writeFile(join(dirname(this.filePath), "igup-data.v1.bak.json"), raw, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
    }
    this.data = parsed ? normalize(parsed) : emptyData();
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

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function accountInfoOf(value: unknown): AccountInfo | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AccountInfo>;
  if (typeof candidate.id !== "string" || !candidate.id) return null;
  return {
    id: candidate.id,
    username: typeof candidate.username === "string" ? candidate.username : "",
    graphId: typeof candidate.graphId === "string" ? candidate.graphId : null,
    threadsUsername: typeof candidate.threadsUsername === "string" ? candidate.threadsUsername : null,
    addedAt: typeof candidate.addedAt === "string" ? candidate.addedAt : nowIso(),
  };
}

/** Records keyed by bare user id (v1) are re-keyed under the owning account. Already-prefixed keys pass through. */
function prefixedRecord<T>(value: unknown, accountId: string): Record<string, T> {
  const out: Record<string, T> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value)) {
    out[key.includes(":") ? key : `${accountId}:${key}`] = entry as T;
  }
  return out;
}

function recordOfStrings(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function recordOfNumbers(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

/** Legacy single-string fields (lastInsightsDate, lastStorySnapshotAt) become per-account records. */
function recordFromLegacyField(value: unknown, accountId: string): Record<string, string> {
  if (value && typeof value === "object") return recordOfStrings(value);
  return typeof value === "string" && value ? { [accountId]: value } : {};
}

function collectionOf(value: unknown, accountId: string): unknown[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => ({ accountId, ...(item as object) }));
}

/**
 * Pure upgrade of a v1 (single-account) data file to the v2 multi-account shape.
 * All pre-existing rules/posts/snapshots land on acc_default, contact & cooldown keys
 * gain the account prefix, and the broker event cursor is seeded for that account.
 * Tolerant of already-migrated v2 input so it can double as a repair path.
 */
export function migrateV1toV2(input: unknown): AppData {
  const source = (input ?? {}) as Partial<AppData> & {
    seen?: { comments?: unknown; messages?: unknown; brokerCursor?: unknown };
  };
  const data = emptyData();
  data.settings = { ...DEFAULT_SETTINGS, ...(source.settings ?? {}) };

  const accounts = Array.isArray(source.accounts) ? source.accounts.map(accountInfoOf).filter((a): a is AccountInfo => a !== null) : [];
  if (accounts.length > 0) {
    data.accounts = accounts;
  } else {
    // v1 had exactly one implicit connection; give it a stable local identity.
    data.accounts = [{ id: DEFAULT_ACCOUNT_ID, username: "", graphId: null, threadsUsername: null, addedAt: nowIso() }];
  }
  const activeId = data.accounts.some((account) => account.id === source.activeAccountId)
    ? (source.activeAccountId as string)
    : (data.accounts[0]?.id ?? null);
  data.activeAccountId = activeId;
  const owner = activeId ?? DEFAULT_ACCOUNT_ID;

  data.seen = { comments: stringList(source.seen?.comments), messages: stringList(source.seen?.messages) };
  const legacyCursor = source.seen?.brokerCursor;
  if (typeof legacyCursor === "number" && Number.isFinite(legacyCursor) && legacyCursor > 0) {
    data.cursors[owner] = legacyCursor;
  }
  data.cursors = { ...data.cursors, ...recordOfNumbers(source.cursors) };

  data.cooldowns = prefixedRecord(source.cooldowns, owner);
  data.contacts = prefixedRecord(source.contacts, owner);
  data.lastInsightsDate = recordFromLegacyField(source.lastInsightsDate, owner);
  data.lastStorySnapshotAt = recordFromLegacyField(source.lastStorySnapshotAt, owner);

  for (const key of COLLECTION_KEYS) {
    const items = collectionOf(source[key], owner);
    (data as unknown as Record<string, unknown>)[key] = ACCOUNT_SCOPED_KEYS.has(key) ? items : Array.isArray(source[key]) ? (source[key] as unknown[]).filter((item) => item && typeof item === "object") : [];
  }
  data.automationSince = typeof source.automationSince === "string" ? source.automationSince : null;
  return data;
}

function normalizeV2(source: Partial<AppData>): AppData {
  const data = migrateV1toV2(source);
  // already-v2 input only needs its loose edges trimmed; migrateV1toV2 is tolerant of it
  return data;
}

export function normalize(input: unknown): AppData {
  const source = (input ?? {}) as Partial<AppData>;
  if (source.version === 2) return normalizeV2(source);
  return migrateV1toV2(source);
}
