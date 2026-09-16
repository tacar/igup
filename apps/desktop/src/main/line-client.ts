const LINE_API = "https://api.line.me/v2/bot";

/** Minimal LINE Messaging API client (push messages only). */
export class LineClient {
  async push(channelAccessToken: string, to: string, text: string): Promise<void> {
    const response = await fetch(`${LINE_API}/message/push`, {
      method: "POST",
      headers: { authorization: `Bearer ${channelAccessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 5_000) }] }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message ?? `LINE APIがエラーを返しました（HTTP ${response.status}）。`);
    }
  }

  async botInfo(channelAccessToken: string): Promise<{ displayName: string; basicId: string }> {
    const response = await fetch(`${LINE_API}/info`, { headers: { authorization: `Bearer ${channelAccessToken}` } });
    if (!response.ok) throw new Error(`LINEチャネルアクセストークンを確認できませんでした（HTTP ${response.status}）。`);
    return (await response.json()) as { displayName: string; basicId: string };
  }
}
