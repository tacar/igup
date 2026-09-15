import { createServer, type Server } from "node:http";
import { shell } from "electron";
import type { Connection } from "./types.js";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 42_813;

type StartResponse = { state: string; verifier: string; authorizationUrl: string };

export class DesktopAuth {
  private pending: { state: string; verifier: string } | null = null;
  private server: Server | null = null;

  constructor(
    private readonly brokerUrl: string,
    private readonly onConnected: (connection: Connection) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    if (this.pending) throw new Error("認証処理はすでに進行中です。");
    await this.ensureCallbackServer();
    const response = await fetch(new URL("/oauth/start", this.brokerUrl), { method: "POST" });
    if (!response.ok) throw new Error("認証サーバーを開始できませんでした。");
    const attempt = (await response.json()) as StartResponse;
    this.pending = { state: attempt.state, verifier: attempt.verifier };
    await shell.openExternal(attempt.authorizationUrl);
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  private ensureCallbackServer(): Promise<void> {
    if (this.server?.listening) return Promise.resolve();
    this.server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
      if (url.pathname !== "/oauth/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      try {
        await this.handleCallback(url);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\"><title>IGUP</title><body><h1>接続しました</h1><p>IGUPへ戻ってください。この画面は閉じられます。</p><script>window.close()</script></body></html>");
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "認証に失敗しました。";
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(message);
      }
    });
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(CALLBACK_PORT, CALLBACK_HOST, resolve);
    });
  }

  private async handleCallback(url: URL): Promise<void> {
    const state = url.searchParams.get("state");
    if (!this.pending || state !== this.pending.state) throw new Error("認証状態が一致しません。");
    const response = await fetch(new URL("/oauth/redeem", this.brokerUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.pending),
    });
    const result = (await response.json()) as Connection | { error: string };
    if (!response.ok || "error" in result) throw new Error("error" in result ? result.error : "認証結果を取得できませんでした。");
    this.pending = null;
    await this.onConnected(result);
  }
}
