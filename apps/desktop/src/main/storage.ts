import { app, safeStorage } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Connection } from "./types.js";

type StoredConnection = { encrypted: string; expiresAt: string | null };

export class ConnectionStorage {
  private get path(): string {
    return join(app.getPath("userData"), "connection.json");
  }

  async save(connection: Connection): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("この端末では安全な認証情報保存を利用できません。");
    }
    const stored: StoredConnection = {
      encrypted: safeStorage.encryptString(connection.accessToken).toString("base64"),
      expiresAt: connection.expiresAt,
    };
    await writeFile(this.path, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
  }

  async load(): Promise<Connection | null> {
    try {
      const stored = JSON.parse(await readFile(this.path, "utf8")) as StoredConnection;
      return {
        accessToken: safeStorage.decryptString(Buffer.from(stored.encrypted, "base64")),
        expiresAt: stored.expiresAt,
      };
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
      if (code === "ENOENT") return null;
      throw new Error("保存された接続情報を読み込めませんでした。", { cause });
    }
  }
}
