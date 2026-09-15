import type { Account, Connection } from "./types.js";

export class InstagramClient {
  constructor(private readonly graphVersion = "v23.0") {}

  async getAccount(connection: Connection): Promise<Account> {
    return this.request<Account>("/me", connection, {
      fields: "id,user_id,username,account_type,media_count",
    });
  }

  async publishImage(connection: Connection, accountId: string, imageUrl: string, caption: string): Promise<{ id: string }> {
    validatePublishInput(imageUrl, caption);
    const container = await this.request<{ id: string }>(`/${accountId}/media`, connection, {
      image_url: imageUrl,
      caption,
    }, "POST");
    return this.request<{ id: string }>(`/${accountId}/media_publish`, connection, {
      creation_id: container.id,
    }, "POST");
  }

  private async request<T>(path: string, connection: Connection, parameters: Record<string, string>, method = "GET"): Promise<T> {
    const url = new URL(`https://graph.instagram.com/${this.graphVersion}${path}`);
    let body: URLSearchParams | undefined;
    const values = new URLSearchParams({ ...parameters, access_token: connection.accessToken });
    if (method === "GET") url.search = values.toString();
    else body = values;

    const response = await fetch(url, {
      method,
      ...(body ? { body, headers: { "content-type": "application/x-www-form-urlencoded" } } : {}),
    });
    const result = (await response.json()) as T | { error?: { message?: string } };
    if (!response.ok) {
      const message = (result as { error?: { message?: string } }).error?.message;
      throw new Error(message ?? `Instagram API returned HTTP ${response.status}`);
    }
    return result as T;
  }
}

export function validatePublishInput(imageUrl: string, caption: string): void {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error("画像URLを正しく入力してください。");
  }
  if (parsed.protocol !== "https:") throw new Error("画像URLは公開されたHTTPS URLを指定してください。");
  if (caption.length > 2_200) throw new Error("キャプションは2,200文字以内で入力してください。");
}
