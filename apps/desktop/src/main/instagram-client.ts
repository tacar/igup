import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Account, Connection, OutgoingMessage } from "./types.js";

export class InstagramApiError extends Error {
  constructor(message: string, readonly code: number | null, readonly subcode: number | null, readonly status: number) {
    super(message);
    this.name = "InstagramApiError";
  }

  get isRateLimit(): boolean {
    return this.code === 4 || this.code === 17 || this.code === 32 || this.code === 613 || this.code === 80_007;
  }

  get isAuth(): boolean {
    return this.code === 190 || this.status === 401;
  }
}

export type MediaItem = {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  thumbnail_url?: string;
  media_url?: string;
  like_count?: number;
  comments_count?: number;
};

export type CommentItem = {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  parent_id?: string;
  from?: { id: string; username?: string };
};

export type MediaWithComments = MediaItem & { comments?: { data: CommentItem[] } };

export type MessageItem = {
  id: string;
  created_time?: string;
  message?: string;
  from?: { id: string; username?: string };
  to?: { data: { id: string; username?: string }[] };
  story?: { reply_to?: { link?: string; id?: string }; mention?: { link?: string; id?: string } };
  is_unsupported?: boolean;
};

export type ConversationItem = {
  id: string;
  updated_time?: string;
  participants?: { data: { id: string; username?: string }[] };
  messages?: { data: MessageItem[] };
};

export type ContainerStatus = { id: string; status_code?: string; status?: string };

export type InsightValue = { name: string; period?: string; values?: { value: number | Record<string, number>; end_time?: string }[]; total_value?: { value: number } };

export type StoryItem = { id: string; media_type?: string; media_url?: string; timestamp?: string; permalink?: string };

const GRAPH_HOST = "https://graph.instagram.com";

export class InstagramClient {
  constructor(private readonly graphVersion = "v23.0") {}

  async getAccount(connection: Connection): Promise<Account> {
    return this.request<Account>("/me", connection, {
      fields: "id,user_id,username,account_type,media_count,name,profile_picture_url,followers_count,follows_count",
    });
  }

  async refreshToken(connection: Connection): Promise<Connection> {
    const url = new URL(`${GRAPH_HOST}/refresh_access_token`);
    url.search = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: connection.accessToken }).toString();
    const result = await parseResponse<{ access_token: string; expires_in?: number }>(await fetch(url));
    return {
      accessToken: result.access_token,
      expiresAt: result.expires_in ? new Date(Date.now() + result.expires_in * 1_000).toISOString() : connection.expiresAt,
    };
  }

  /** Legacy single-image publish used by the first release. */
  async publishImage(connection: Connection, accountId: string, imageUrl: string, caption: string): Promise<{ id: string }> {
    validatePublishInput(imageUrl, caption);
    const container = await this.createContainer(connection, { image_url: imageUrl, caption });
    return this.publishContainer(connection, container.id);
  }

  listMedia(connection: Connection, limit = 25): Promise<{ data: MediaItem[] }> {
    return this.request("/me/media", connection, {
      fields: "id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url,like_count,comments_count",
      limit: String(limit),
    });
  }

  listMediaWithComments(connection: Connection, limit = 10, commentLimit = 50): Promise<{ data: MediaWithComments[] }> {
    return this.request("/me/media", connection, {
      fields: `id,media_type,media_product_type,timestamp,comments.limit(${commentLimit}){id,text,username,timestamp,parent_id,from}`,
      limit: String(limit),
    });
  }

  listLiveMedia(connection: Connection): Promise<{ data: { id: string; status?: string }[] }> {
    return this.request("/me/live_media", connection, { fields: "id,status,timestamp" });
  }

  listComments(connection: Connection, mediaId: string, limit = 50): Promise<{ data: CommentItem[] }> {
    return this.request(`/${mediaId}/comments`, connection, { fields: "id,text,username,timestamp,parent_id,from", limit: String(limit) });
  }

  replyToComment(connection: Connection, commentId: string, message: string): Promise<{ id: string }> {
    return this.request(`/${commentId}/replies`, connection, { message }, "POST");
  }

  sendPrivateReply(connection: Connection, commentId: string, text: string): Promise<{ recipient_id: string; message_id: string }> {
    return this.requestJson("/me/messages", connection, { recipient: { comment_id: commentId }, message: { text } });
  }

  async sendMessage(connection: Connection, recipientId: string, message: OutgoingMessage): Promise<{ recipient_id: string; message_id: string }[]> {
    const results: { recipient_id: string; message_id: string }[] = [];
    for (const payload of buildMessagePayloads(message)) {
      results.push(await this.requestJson("/me/messages", connection, { recipient: { id: recipientId }, message: payload }));
    }
    return results;
  }

  listConversations(connection: Connection, limit = 20, messageLimit = 5): Promise<{ data: ConversationItem[] }> {
    return this.request("/me/conversations", connection, {
      platform: "instagram",
      fields: `id,updated_time,participants,messages.limit(${messageLimit}){id,created_time,from,to,message,story,is_unsupported}`,
      limit: String(limit),
    });
  }

  createContainer(connection: Connection, parameters: Record<string, string>): Promise<{ id: string; uri?: string }> {
    return this.request("/me/media", connection, parameters, "POST");
  }

  containerStatus(connection: Connection, containerId: string): Promise<ContainerStatus> {
    return this.request(`/${containerId}`, connection, { fields: "id,status_code,status" });
  }

  publishContainer(connection: Connection, containerId: string): Promise<{ id: string }> {
    return this.request("/me/media_publish", connection, { creation_id: containerId }, "POST");
  }

  getMedia(connection: Connection, mediaId: string, fields = "id,permalink,media_type,media_product_type,timestamp"): Promise<MediaItem> {
    return this.request(`/${mediaId}`, connection, { fields });
  }

  /** Uploads a local video through Meta's resumable upload endpoint (no public URL needed). */
  async uploadVideo(connection: Connection, uploadUri: string, filePath: string, onProgress?: (sent: number, total: number) => void): Promise<void> {
    const { size } = await stat(filePath);
    let sent = 0;
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      sent += chunk.length;
      onProgress?.(sent, size);
    });
    const response = await fetch(uploadUri, {
      method: "POST",
      headers: {
        authorization: `OAuth ${connection.accessToken}`,
        offset: "0",
        file_size: String(size),
        "content-type": "application/octet-stream",
      },
      body: Readable.toWeb(stream) as unknown as ReadableStream,
      // @ts-expect-error duplex is required by undici for streaming request bodies
      duplex: "half",
    });
    const result = await parseResponse<{ success?: boolean; message?: string }>(response);
    if (result.success === false) throw new Error(result.message ?? "動画のアップロードに失敗しました。");
  }

  accountInsights(connection: Connection, parameters: Record<string, string>): Promise<{ data: InsightValue[] }> {
    return this.request("/me/insights", connection, parameters);
  }

  mediaInsights(connection: Connection, mediaId: string, metrics: string): Promise<{ data: InsightValue[] }> {
    return this.request(`/${mediaId}/insights`, connection, { metric: metrics });
  }

  listStories(connection: Connection): Promise<{ data: StoryItem[] }> {
    return this.request("/me/stories", connection, { fields: "id,media_type,media_url,timestamp,permalink" });
  }

  subscribeWebhooks(connection: Connection, fields: string): Promise<{ success?: boolean }> {
    return this.request("/me/subscribed_apps", connection, { subscribed_fields: fields }, "POST");
  }

  private async request<T>(path: string, connection: Connection, parameters: Record<string, string>, method = "GET"): Promise<T> {
    const url = new URL(`${GRAPH_HOST}/${this.graphVersion}${path}`);
    let body: URLSearchParams | undefined;
    const values = new URLSearchParams({ ...parameters, access_token: connection.accessToken });
    if (method === "GET") url.search = values.toString();
    else body = values;

    const response = await fetch(url, {
      method,
      ...(body ? { body, headers: { "content-type": "application/x-www-form-urlencoded" } } : {}),
    });
    return parseResponse<T>(response);
  }

  private async requestJson<T>(path: string, connection: Connection, payload: unknown): Promise<T> {
    const url = new URL(`${GRAPH_HOST}/${this.graphVersion}${path}`);
    url.search = new URLSearchParams({ access_token: connection.accessToken }).toString();
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return parseResponse<T>(response);
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let result: unknown = null;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = null;
  }
  if (!response.ok) {
    const error = (result as { error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } } | null)?.error;
    const message = error?.error_user_msg ?? error?.message ?? `Instagram API returned HTTP ${response.status}`;
    throw new InstagramApiError(message, error?.code ?? null, error?.error_subcode ?? null, response.status);
  }
  return result as T;
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

export const MESSAGE_TEXT_LIMIT = 1_000;
export const TEMPLATE_TEXT_LIMIT = 640;
export const BUTTON_TITLE_LIMIT = 20;
export const QUICK_REPLY_LIMIT = 13;
export const BUTTON_LIMIT = 3;

/**
 * Splits one logical message into the Send API payloads it needs:
 * a button template carries up to 3 buttons, quick replies ride on a text message.
 */
export function buildMessagePayloads(message: OutgoingMessage): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  const buttons = message.buttons.slice(0, BUTTON_LIMIT).map((button) =>
    button.type === "web_url"
      ? { type: "web_url", title: button.title.slice(0, BUTTON_TITLE_LIMIT), url: button.url }
      : { type: "postback", title: button.title.slice(0, BUTTON_TITLE_LIMIT), payload: button.payload },
  );
  const quickReplies = message.quickReplies.slice(0, QUICK_REPLY_LIMIT).map((reply) => ({
    content_type: "text",
    title: reply.title.slice(0, BUTTON_TITLE_LIMIT),
    payload: reply.payload,
  }));
  const text = message.text.trim();

  if (buttons.length > 0) {
    payloads.push({
      attachment: {
        type: "template",
        payload: { template_type: "button", text: (text || message.buttonPrompt || "👇").slice(0, TEMPLATE_TEXT_LIMIT), buttons },
      },
    });
    if (quickReplies.length > 0) {
      payloads.push({ text: (message.buttonPrompt || "次はどうしますか？").slice(0, MESSAGE_TEXT_LIMIT), quick_replies: quickReplies });
    }
    return payloads;
  }

  const textPayload: Record<string, unknown> = { text: (text || message.buttonPrompt || "…").slice(0, MESSAGE_TEXT_LIMIT) };
  if (quickReplies.length > 0) textPayload.quick_replies = quickReplies;
  payloads.push(textPayload);
  return payloads;
}
