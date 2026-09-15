import type { BrokerConfig } from "./config.js";

type TokenResponse = { access_token: string; token_type?: string; expires_in?: number };

export class MetaClient {
  constructor(private readonly config: BrokerConfig) {}

  authorizationUrl(state: string): string {
    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.search = new URLSearchParams({
      enable_fb_login: "0",
      force_authentication: "1",
      client_id: this.config.appId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: "instagram_business_basic,instagram_business_content_publish",
      state,
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; expiresAt: string | null }> {
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
    return {
      accessToken: longToken.access_token,
      expiresAt: longToken.expires_in
        ? new Date(Date.now() + longToken.expires_in * 1_000).toISOString()
        : null,
    };
  }
}

async function parseMetaResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T | { error?: { message?: string } };
  if (!response.ok) {
    const message = "error" in (body as object) ? (body as { error?: { message?: string } }).error?.message : undefined;
    throw new Error(message ?? `Meta API returned HTTP ${response.status}`);
  }
  return body as T;
}
