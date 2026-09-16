import type { Provider, TokenResult } from "./attempt-store.js";
import type { BrokerConfig, ThreadsConfig } from "./config.js";

type TokenResponse = { access_token: string; token_type?: string; expires_in?: number; user_id?: string | number };

export type Owner = { id: string; userId: string | null; username: string | null };

export class MetaApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null) {
    super(message);
    this.name = "MetaApiError";
  }

  /** True when the token itself is rejected rather than the request. */
  get isAuth(): boolean {
    return this.status === 401 || this.code === 190 || this.code === 102;
  }
}

/** The only component that ever sees the app secrets. Handles OAuth for Instagram and Threads plus owner lookups. */
export class MetaClient {
  constructor(private readonly config: BrokerConfig) {}

  authorizationUrl(state: string, provider: Provider = "instagram"): string {
    if (provider === "threads") {
      const threads = this.requireThreads();
      const url = new URL("https://threads.net/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: threads.appId,
        redirect_uri: threads.redirectUri,
        response_type: "code",
        scope: threads.scopes,
        state,
      }).toString();
      return url.toString();
    }
    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.search = new URLSearchParams({
      enable_fb_login: "0",
      force_authentication: "1",
      client_id: this.config.appId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: this.config.scopes,
      state,
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string, provider: Provider = "instagram"): Promise<TokenResult> {
    if (provider === "threads") return this.exchangeThreadsCode(code);

    const shortResponse = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        grant_type: "authorization_code",
        redirect_uri: this.config.redirectUri,
        code,
      }),
    });
    const shortToken = await parseMetaResponse<TokenResponse>(shortResponse);

    const longUrl = new URL("https://graph.instagram.com/access_token");
    longUrl.search = new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: this.config.appSecret,
      access_token: shortToken.access_token,
    }).toString();
    const longToken = await parseMetaResponse<TokenResponse>(await fetch(longUrl));
    return toResult(longToken);
  }

  /** Looks up who a desktop token belongs to; used to scope links, media, seminars and events. */
  async resolveOwner(accessToken: string): Promise<Owner> {
    const url = new URL(`https://graph.instagram.com/${this.config.graphVersion}/me`);
    url.search = new URLSearchParams({ fields: "id,user_id,username", access_token: accessToken }).toString();
    const me = await parseMetaResponse<{ id: string | number; user_id?: string | number; username?: string }>(await fetch(url));
    return {
      id: String(me.id),
      userId: me.user_id !== undefined && me.user_id !== null ? String(me.user_id) : null,
      username: me.username ?? null,
    };
  }

  private async exchangeThreadsCode(code: string): Promise<TokenResult> {
    const threads = this.requireThreads();
    const shortResponse = await fetch("https://graph.threads.net/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: threads.appId,
        client_secret: threads.appSecret,
        grant_type: "authorization_code",
        redirect_uri: threads.redirectUri,
        code,
      }),
    });
    const shortToken = await parseMetaResponse<TokenResponse>(shortResponse);

    const longUrl = new URL("https://graph.threads.net/access_token");
    longUrl.search = new URLSearchParams({
      grant_type: "th_exchange_token",
      client_secret: threads.appSecret,
      access_token: shortToken.access_token,
    }).toString();
    const longToken = await parseMetaResponse<TokenResponse>(await fetch(longUrl));
    return toResult(longToken);
  }

  private requireThreads(): ThreadsConfig {
    if (!this.config.threads) throw new Error("Threads is not configured on this broker");
    return this.config.threads;
  }
}

function toResult(token: TokenResponse): TokenResult {
  return {
    accessToken: token.access_token,
    expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1_000).toISOString() : null,
  };
}

async function parseMetaResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = (body as { error?: { message?: string; code?: number } } | null)?.error;
    throw new MetaApiError(error?.message ?? `Meta API returned HTTP ${response.status}`, response.status, error?.code ?? null);
  }
  return body as T;
}
