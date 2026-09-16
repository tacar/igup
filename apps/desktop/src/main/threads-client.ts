import type { Connection, ThreadsAccount } from "./types.js";

const THREADS_HOST = "https://graph.threads.net/v1.0";

export type ThreadsContainer = { id: string };
export type ThreadsStatus = { id: string; status?: "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED"; error_message?: string };

export class ThreadsClient {
  getProfile(connection: Connection): Promise<ThreadsAccount> {
    return this.request("/me", connection, { fields: "id,username,threads_profile_picture_url" });
  }

  async refreshToken(connection: Connection): Promise<Connection> {
    const url = new URL(`${THREADS_HOST.replace("/v1.0", "")}/refresh_access_token`);
    url.search = new URLSearchParams({ grant_type: "th_refresh_token", access_token: connection.accessToken }).toString();
    const result = await parse<{ access_token: string; expires_in?: number }>(await fetch(url));
    return {
      accessToken: result.access_token,
      expiresAt: result.expires_in ? new Date(Date.now() + result.expires_in * 1_000).toISOString() : connection.expiresAt,
    };
  }

  createContainer(connection: Connection, parameters: Record<string, string>): Promise<ThreadsContainer> {
    return this.request("/me/threads", connection, parameters, "POST");
  }

  status(connection: Connection, containerId: string): Promise<ThreadsStatus> {
    return this.request(`/${containerId}`, connection, { fields: "id,status,error_message" });
  }

  publish(connection: Connection, containerId: string): Promise<{ id: string }> {
    return this.request("/me/threads_publish", connection, { creation_id: containerId }, "POST");
  }

  getPost(connection: Connection, postId: string): Promise<{ id: string; permalink?: string }> {
    return this.request(`/${postId}`, connection, { fields: "id,permalink" });
  }

  private async request<T>(path: string, connection: Connection, parameters: Record<string, string>, method = "GET"): Promise<T> {
    const url = new URL(`${THREADS_HOST}${path}`);
    const values = new URLSearchParams({ ...parameters, access_token: connection.accessToken });
    let body: URLSearchParams | undefined;
    if (method === "GET") url.search = values.toString();
    else body = values;
    const response = await fetch(url, { method, ...(body ? { body, headers: { "content-type": "application/x-www-form-urlencoded" } } : {}) });
    return parse<T>(response);
  }
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let result: unknown = null;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = null;
  }
  if (!response.ok) {
    const error = (result as { error?: { message?: string } } | null)?.error;
    throw new Error(error?.message ?? `Threads API returned HTTP ${response.status}`);
  }
  return result as T;
}

export const THREADS_TEXT_LIMIT = 500;
export const THREADS_CAROUSEL_LIMIT = 20;
