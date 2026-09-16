import { app, safeStorage } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Connection, Provider } from "./types.js";

type LegacyStoredConnection = { encrypted: string; expiresAt: string | null };

type StoredSecrets = {
  version: 2;
  connections: Partial<Record<Provider, { encrypted: string; expiresAt: string | null }>>;
  lineChannelToken: string | null;
  localApiToken: string | null;
};

/**
 * Secret values (OAuth tokens, LINE channel token, local API token) live in one file
 * encrypted with the OS keychain / DPAPI through Electron safeStorage.
 */
export class ConnectionStorage {
  private cache: StoredSecrets | null = null;

  constructor(private readonly directory = app.getPath("userData")) {}

  private get path(): string {
    return join(this.directory, "connection.json");
  }

  async save(connection: Connection, provider: Provider = "instagram"): Promise<void> {
    const secrets = await this.read();
    secrets.connections[provider] = { encrypted: this.encrypt(connection.accessToken), expiresAt: connection.expiresAt };
    await this.write(secrets);
  }

  async load(provider: Provider = "instagram"): Promise<Connection | null> {
    const stored = (await this.read()).connections[provider];
    if (!stored) return null;
    return { accessToken: this.decrypt(stored.encrypted), expiresAt: stored.expiresAt };
  }

  async remove(provider: Provider): Promise<void> {
    const secrets = await this.read();
    delete secrets.connections[provider];
    await this.write(secrets);
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
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as StoredSecrets | LegacyStoredConnection;
      if ("version" in parsed && parsed.version === 2) {
        this.cache = { ...parsed, connections: parsed.connections ?? {} };
      } else {
        const legacy = parsed as LegacyStoredConnection;
        this.cache = { version: 2, connections: { instagram: { encrypted: legacy.encrypted, expiresAt: legacy.expiresAt } }, lineChannelToken: null, localApiToken: null };
      }
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
      if (code !== "ENOENT") throw new Error("保存された接続情報を読み込めませんでした。", { cause });
      this.cache = { version: 2, connections: {}, lineChannelToken: null, localApiToken: null };
    }
    return this.cache;
  }

  private async write(secrets: StoredSecrets): Promise<void> {
    this.cache = secrets;
    await writeFile(this.path, JSON.stringify(secrets), { encoding: "utf8", mode: 0o600 });
  }
}
