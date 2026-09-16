import { createServer, type Server } from "node:http";
import { shell } from "electron";
import { BrokerUnavailableError } from "./broker-client.js";
import type { Connection, Provider } from "./types.js";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 42_813;

type StartResponse = { state: string; verifier: string; authorizationUrl: string };

export class DesktopAuth {
  private readonly pending = new Map<string, { verifier: string; provider: Provider; startedAt: number }>();
  private server: Server | null = null;

  constructor(
    private brokerUrl: string,
    private readonly onConnected: (connection: Connection, provider: Provider) => Promise<void>,
  ) {}

  setUrl(url: string): void {
    this.brokerUrl = url;
  }

  async start(provider: Provider = "instagram"): Promise<void> {
    await this.ensureCallbackServer();
    const url = new URL("/oauth/start", this.brokerUrl);
    if (provider !== "instagram") url.searchParams.set("provider", provider);
    let response: Response;
    try {
      response = await fetch(url, { method: "POST" });
    } catch {
      throw new BrokerUnavailableError(this.brokerUrl);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `認証サーバーを開始できませんでした（HTTP ${response.status}）。`);
    }
    const attempt = (await response.json()) as StartResponse;
    for (const [state, item] of this.pending) if (Date.now() - item.startedAt > 15 * 60_000) this.pending.delete(state);
    this.pending.set(attempt.state, { verifier: attempt.verifier, provider, startedAt: Date.now() });
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
        const provider = await this.handleCallback(url);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>IGUP</title><body style="font-family:sans-serif;padding:40px"><h1>${provider === "threads" ? "Threads" : "Instagram"}と接続しました</h1><p>IGUPへ戻ってください。この画面は閉じて構いません。</p><script>setTimeout(function(){window.close()},800)</script></body></html>`);
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

  private async handleCallback(url: URL): Promise<Provider> {
    const state = url.searchParams.get("state") ?? "";
    const pending = this.pending.get(state);
    if (!pending) throw new Error("認証状態が一致しません。IGUPから接続をやり直してください。");
    let response: Response;
    try {
      response = await fetch(new URL("/oauth/redeem", this.brokerUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, verifier: pending.verifier }),
      });
    } catch {
      throw new BrokerUnavailableError(this.brokerUrl);
    }
    const result = (await response.json()) as Connection | { error: string };
    if (!response.ok || "error" in result) throw new Error("error" in result ? result.error : "認証結果を取得できませんでした。");
    this.pending.delete(state);
    await this.onConnected(result, pending.provider);
    return pending.provider;
  }
}
