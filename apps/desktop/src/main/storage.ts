import { app, safeStorage } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_ACCOUNT_ID, type Connection, type Provider } from "./types.js";

type StoredConnection = { encrypted: string; expiresAt: string | null };

export type StoredAccountSecrets = { instagram: StoredConnection | null; threads: StoredConnection | null };


export type StoredSecrets = {
  version: 3;
  accounts: Record<string, StoredAccountSecrets>;
  aiApiKey: string | null;
  lineChannelToken: string | null;
  localApiToken: string | null;
};

/** Shape of the pre-multi-account secrets files (v2 object form, v1 bare connection). */
type LegacySecrets = {
  version?: number;
  accounts?: Record<string, Partial<StoredAccountSecrets>>;
  connections?: Partial<Record<Provider, StoredConnection>>;
  aiApiKey?: unknown;
  lineChannelToken?: unknown;
  localApiToken?: unknown;
  encrypted?: string;
  expiresAt?: string | null;
};

export function emptySecrets(): StoredSecrets {
  return { version: 3, accounts: {}, aiApiKey: null, lineChannelToken: null, localApiToken: null };
}

function storedConnection(value: unknown): StoredConnection | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { encrypted?: unknown; expiresAt?: unknown };
  if (typeof candidate.encrypted !== "string") return null;
  return { encrypted: candidate.encrypted, expiresAt: typeof candidate.expiresAt === "string" ? candidate.expiresAt : null };
}

/**
 * Pure (Electron-free) upgrade of any older secrets file to the current shape:
 * v1 = a single connection object, v2 = {connections: {instagram?, threads?}},
 * v3 = per-account connections. Everything pre-multi-account lands on acc_default.
 */
export function migrateSecrets(parsed: unknown): StoredSecrets {
  const secrets = emptySecrets();
  if (!parsed || typeof parsed !== "object") return secrets;
  const source = parsed as LegacySecrets;
  if (source.version === 3 && source.accounts && typeof source.accounts === "object") {
    for (const [id, entry] of Object.entries(source.accounts)) {
      const instagram = storedConnection(entry?.instagram);
      const threads = storedConnection(entry?.threads);
      if (!instagram && !threads) continue;
      secrets.accounts[id] = { instagram, threads };
    }
  } else {
    const legacy: StoredAccountSecrets = { instagram: null, threads: null };
    if (source.version === 2 && source.connections && typeof source.connections === "object") {
      legacy.instagram = storedConnection(source.connections.instagram);
      legacy.threads = storedConnection(source.connections.threads);
    } else if (typeof source.encrypted === "string") {
      legacy.instagram = { encrypted: source.encrypted, expiresAt: source.expiresAt ?? null };
    }
    if (legacy.instagram || legacy.threads) {
      secrets.accounts[DEFAULT_ACCOUNT_ID] = legacy;
    }
  }
  secrets.aiApiKey = typeof source.aiApiKey === "string" ? source.aiApiKey : null;
  secrets.lineChannelToken = typeof source.lineChannelToken === "string" ? source.lineChannelToken : null;
  secrets.localApiToken = typeof source.localApiToken === "string" ? source.localApiToken : null;
  return secrets;
}

function accountSlot(secrets: StoredSecrets, accountId: string): StoredAccountSecrets {
  const existing = secrets.accounts[accountId];
  if (existing) return existing;
  const created: StoredAccountSecrets = { instagram: null, threads: null };
  secrets.accounts[accountId] = created;
  return created;
}

/**
 * Secret values (OAuth tokens per account, AI API key, LINE channel token, local API token)
 * live in one file encrypted with the OS keychain / DPAPI through Electron safeStorage.
 */
export class ConnectionStorage {
  private cache: StoredSecrets | null = null;

  constructor(private readonly directory = app.getPath("userData")) {}

  private get path(): string {
    return join(this.directory, "connection.json");
  }

  async save(connection: Connection, provider: Provider = "instagram", accountId: string = DEFAULT_ACCOUNT_ID): Promise<void> {
    const secrets = await this.read();
    accountSlot(secrets, accountId)[provider] = { encrypted: this.encrypt(connection.accessToken), expiresAt: connection.expiresAt };
    await this.write(secrets);
  }

  async load(provider: Provider = "instagram", accountId: string = DEFAULT_ACCOUNT_ID): Promise<Connection | null> {
    const stored = (await this.read()).accounts[accountId]?.[provider];
    if (!stored) return null;
    return { accessToken: this.decrypt(stored.encrypted), expiresAt: stored.expiresAt };
  }

  async remove(provider: Provider, accountId: string = DEFAULT_ACCOUNT_ID): Promise<void> {
    const secrets = await this.read();
    const slot = secrets.accounts[accountId];
    if (!slot) return;
    slot[provider] = null;
    if (!slot.instagram && !slot.threads) delete secrets.accounts[accountId];
    await this.write(secrets);
  }

  async accountIds(): Promise<string[]> {
    const secrets = await this.read();
    return Object.keys(secrets.accounts).filter((id) => secrets.accounts[id]?.instagram || secrets.accounts[id]?.threads);
  }

  async saveAiKey(key: string | null): Promise<void> {
    const secrets = await this.read();
    secrets.aiApiKey = key ? this.encrypt(key) : null;
    await this.write(secrets);
  }

  async loadAiKey(): Promise<string | null> {
    const stored = (await this.read()).aiApiKey;
    return stored ? this.decrypt(stored) : null;
  }

  async saveLineChannelToken(token: string | null): Promise<void> {
    const secrets = await this.read();
    secrets.lineChannelToken = token ? this.encrypt(token) : null;
    await this.write(secrets);
  }

  async loadLineChannelToken(): Promise<string | null> {
    const stored = (await this.read()).lineChannelToken;
    return stored ? this.decrypt(stored) : null;
  }

  async localApiToken(regenerate = false): Promise<string> {
    const secrets = await this.read();
    if (!secrets.localApiToken || regenerate) {
      secrets.localApiToken = this.encrypt(randomBytes(24).toString("base64url"));
      await this.write(secrets);
    }
    return this.decrypt(secrets.localApiToken);
  }

  private encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("この端末では安全な認証情報保存を利用できません。");
    }
    return safeStorage.encryptString(value).toString("base64");
  }

  private decrypt(value: string): string {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  }

  private async read(): Promise<StoredSecrets> {
    if (this.cache) return this.cache;
    let raw: string | null = null;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
      if (code !== "ENOENT") throw new Error("保存された接続情報を読み込めませんでした。", { cause });
      this.cache = emptySecrets();
      return this.cache;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const isCurrent = Boolean(parsed && typeof parsed === "object" && (parsed as LegacySecrets).version === 3);
    this.cache = parsed ? migrateSecrets(parsed) : emptySecrets();
    if (parsed && !isCurrent) {
      // keep the pre-migration file around once, in case the OS keychain contents are needed again
      await writeFile(join(this.directory, "connection.v2.bak.json"), raw, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
    }
    return this.cache;
  }

  private async write(secrets: StoredSecrets): Promise<void> {
    this.cache = secrets;
    await writeFile(this.path, JSON.stringify(secrets), { encoding: "utf8", mode: 0o600 });
  }
}
