import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

export type ApiHandler = (payload: unknown, query: URLSearchParams) => Promise<unknown> | unknown;

export type ApiRoute = { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; handler: ApiHandler };

const HOST = "127.0.0.1";
const BODY_LIMIT = 1_000_000;

/**
 * Small local HTTP API so AI tools (e.g. Claude Code) can read stats and create posts or rules
 * without touching the UI. Bound to 127.0.0.1 and protected by a bearer token.
 */
export class LocalApi {
  private server: Server | null = null;

  constructor(private readonly routes: ApiRoute[], private readonly token: () => Promise<string>) {}

  get port(): number | null {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : null;
  }

  async start(port: number): Promise<void> {
    await this.stop();
    const server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, HOST, () => resolve());
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    try {
      if (!(await this.authorized(request))) return send(401, { error: "Bearerトークンが正しくありません。設定画面のトークンを Authorization ヘッダーに指定してください。" });
      const route = this.routes.find((candidate) => candidate.method === request.method && matchPath(candidate.path, url.pathname));
      if (!route) return send(404, { error: `${request.method} ${url.pathname} は存在しません。` });
      const params = extractParams(route.path, url.pathname);
      const body = request.method === "GET" || request.method === "DELETE" ? null : await readJson(request);
      const payload = body && typeof body === "object" ? { ...params, ...(body as object) } : params;
      const result = await route.handler(payload, url.searchParams);
      send(200, result ?? { ok: true });
    } catch (cause) {
      send(400, { error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  private async authorized(request: IncomingMessage): Promise<boolean> {
    const header = request.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!provided) return false;
    const expected = await this.token();
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}

function matchPath(pattern: string, pathname: string): boolean {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
}

function extractParams(pattern: string, pathname: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pathParts = pathname.split("/");
  pattern.split("/").forEach((part, index) => {
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(pathParts[index] ?? "");
  });
  return params;
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("リクエスト本文が大きすぎます（1MBまで）。"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("JSONとして解釈できませんでした。"));
      }
    });
    request.on("error", reject);
  });
}
