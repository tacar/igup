import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type StoredLink = {
  slug: string;
  ownerId: string;
  url: string;
  label: string;
  source: string;
  createdAt: string;
  total: number;
  daily: Record<string, number>;
  sources: Record<string, number>;
};

export type StoredSeminarDate = { id: string; startsAt: string; capacity: number | null };
export type StoredReminder = { id: string; hoursBefore: number; text: string };

export type StoredApplication = {
  id: string;
  dateId: string;
  name: string;
  email: string | null;
  lineUserId: string | null;
  createdAt: string;
};

export type SeminarDefinition = {
  title: string;
  description: string;
  dates: StoredSeminarDate[];
  liffId: string | null;
  thanksMessage: string;
  reminders: StoredReminder[];
  enabled: boolean;
};

export type StoredSeminar = SeminarDefinition & {
  id: string;
  ownerId: string;
  ownerKeys: string[];
  createdAt: string;
  updatedAt: string;
  applications: StoredApplication[];
};

export type StoredMedia = {
  id: string;
  ownerId: string;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: string;
  expiresAt: string;
};

export type StoredEvent = {
  id: number;
  at: string;
  type: "webhook" | "seminar.application";
  /** Account ids this event belongs to (Instagram professional account id and/or app-scoped id). */
  targets: string[];
  payload: unknown;
};

export type BrokerState = {
  links: Record<string, StoredLink>;
  seminars: Record<string, StoredSeminar>;
  media: Record<string, StoredMedia>;
};

export type EventState = { seq: number; events: StoredEvent[] };

/** A JSON document on disk with debounced, atomic writes. Memory-only when no path is given. */
export class Persisted<T> {
  value: T;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string | null, initial: T, migrate: (raw: unknown) => T | null = (raw) => raw as T) {
    this.value = initial;
    if (!filePath || !existsSync(filePath)) return;
    try {
      const migrated = migrate(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
      if (migrated) this.value = migrated;
    } catch (cause) {
      const backup = `${filePath}.broken-${Date.now()}`;
      renameSync(filePath, backup);
      console.error(`Could not read ${filePath}; moved it to ${backup}`, cause);
    }
  }

  save(): void {
    if (!this.filePath) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 200);
    this.timer.unref();
  }

  flush(): Promise<void> {
    if (!this.filePath || !this.dirty) return this.writing;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = false;
    const path = this.filePath;
    const json = JSON.stringify(this.value);
    this.writing = this.writing
      .then(async () => {
        await writeFile(`${path}.tmp`, json, "utf8");
        await rename(`${path}.tmp`, path);
      })
      .catch((cause) => {
        this.dirty = true;
        console.error(`Could not write ${path}`, cause);
      });
    return this.writing;
  }
}

export function emptyState(): BrokerState {
  return { links: {}, seminars: {}, media: {} };
}

/** Everything the broker remembers between restarts: links, seminars and transient media metadata. */
export class BrokerStore {
  readonly state: Persisted<BrokerState>;
  readonly events: Persisted<EventState>;
  readonly mediaDir: string;

  constructor(dataDir: string) {
    const root = resolve(dataDir);
    this.mediaDir = join(root, "media");
    mkdirSync(this.mediaDir, { recursive: true });
    this.state = new Persisted(join(root, "state.json"), emptyState(), migrateState);
    this.events = new Persisted(join(root, "events.json"), { seq: 0, events: [] }, migrateEvents);
  }

  async flush(): Promise<void> {
    await Promise.all([this.state.flush(), this.events.flush()]);
  }
}

function migrateState(raw: unknown): BrokerState | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<BrokerState>;
  return {
    links: isRecord(record.links) ? (record.links as BrokerState["links"]) : {},
    seminars: isRecord(record.seminars) ? (record.seminars as BrokerState["seminars"]) : {},
    media: isRecord(record.media) ? (record.media as BrokerState["media"]) : {},
  };
}

function migrateEvents(raw: unknown): EventState | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<EventState>;
  const events = Array.isArray(record.events) ? (record.events as StoredEvent[]) : [];
  const seq = typeof record.seq === "number" && Number.isFinite(record.seq) ? record.seq : events.reduce((max, event) => Math.max(max, event.id), 0);
  return { seq, events };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
