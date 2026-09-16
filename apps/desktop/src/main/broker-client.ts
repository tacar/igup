import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { BrokerCapabilities, BrokerEvent, Connection, Seminar, SeminarApplication, TrackedLink } from "./types.js";

export class BrokerUnavailableError extends Error {
  constructor(brokerUrl: string) {
    super(`認証サーバー（${brokerUrl}）に接続できません。サーバーが起動しているか、IGUP_BROKER_URL の設定を確認してください。`);
    this.name = "BrokerUnavailableError";
  }
}

export type UploadedMedia = { id: string; url: string; expiresAt: string };

/** Talks to the IGUP broker for everything that needs a public HTTPS host. */
export class BrokerClient {
  constructor(readonly brokerUrl: string) {}

  async capabilities(): Promise<BrokerCapabilities> {
    return this.call("GET", "/capabilities");
  }

  async health(): Promise<boolean> {
    try {
      await this.call("GET", "/health");
      return true;
    } catch {
      return false;
    }
  }

  events(connection: Connection, after: number, limit = 100): Promise<{ events: BrokerEvent[]; cursor: number }> {
    return this.call("GET", `/events?after=${after}&limit=${limit}`, connection);
  }

  async uploadBytes(connection: Connection, fileName: string, contentType: string, bytes: Uint8Array): Promise<UploadedMedia> {
    return this.call("POST", "/media", connection, new Blob([bytes as BlobPart]), { "content-type": contentType, "x-file-name": encodeURIComponent(fileName) });
  }

  async uploadFile(connection: Connection, filePath: string, contentType: string, fileName: string): Promise<UploadedMedia> {
    const { size } = await stat(filePath);
    return this.call("POST", "/media", connection, Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream, {
      "content-type": contentType,
      "content-length": String(size),
      "x-file-name": encodeURIComponent(fileName),
    });
  }

  deleteMedia(connection: Connection, id: string): Promise<{ ok: boolean }> {
    return this.call("DELETE", `/media/${encodeURIComponent(id)}`, connection);
  }

  listLinks(connection: Connection): Promise<{ links: TrackedLink[] }> {
    return this.call("GET", "/links", connection);
  }

  createLink(connection: Connection, input: { url: string; label: string; source: string; slug?: string }): Promise<{ link: TrackedLink }> {
    return this.call("POST", "/links", connection, JSON.stringify(input), { "content-type": "application/json" });
  }

  deleteLink(connection: Connection, slug: string): Promise<{ ok: boolean }> {
    return this.call("DELETE", `/links/${encodeURIComponent(slug)}`, connection);
  }

  saveSeminar(connection: Connection, seminar: Seminar): Promise<{ publicUrl: string }> {
    const { applications: _applications, ...definition } = seminar;
    return this.call("PUT", `/seminars/${encodeURIComponent(seminar.id)}`, connection, JSON.stringify(definition), { "content-type": "application/json" });
  }

  deleteSeminar(connection: Connection, id: string): Promise<{ ok: boolean }> {
    return this.call("DELETE", `/seminars/${encodeURIComponent(id)}`, connection);
  }

  seminarApplications(connection: Connection, id: string): Promise<{ applications: SeminarApplication[] }> {
    return this.call("GET", `/seminars/${encodeURIComponent(id)}/applications`, connection);
  }

  private async call<T>(method: string, path: string, connection?: Connection, body?: BodyInit, headers: Record<string, string> = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.brokerUrl), {
        method,
        headers: { ...(connection ? { authorization: `Bearer ${connection.accessToken}` } : {}), ...headers },
        ...(body !== undefined ? { body } : {}),
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      } as RequestInit);
    } catch (cause) {
      throw new BrokerUnavailableError(this.brokerUrl);
    }
    const text = await response.text();
    let result: unknown = null;
    try {
      result = text ? JSON.parse(text) : null;
    } catch {
      result = null;
    }
    if (!response.ok) {
      const message = (result as { error?: string } | null)?.error ?? `認証サーバーがエラーを返しました（HTTP ${response.status}）。`;
      throw new Error(message);
    }
    return result as T;
  }
}
