import { afterEach, describe, expect, it, vi } from "vitest";
import { AiError, generateIdeas } from "./ai-client.js";

const openai = { provider: "openai" as const, baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };
const anthropic = { provider: "anthropic" as const, baseUrl: "https://api.example.com", model: "claude-test", apiKey: "ak-test" };

type RecordedCall = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function mockFetch(responses: { status?: number; body?: unknown }[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: unknown) => {
    const headers = ((init as { headers?: Record<string, string> } | undefined)?.headers ?? {}) as Record<string, string>;
    const rawBody = (init as { body?: string } | undefined)?.body ?? "{}";
    calls.push({ url: String(url), headers, body: JSON.parse(rawBody) as Record<string, unknown> });
    const next = responses.shift() ?? { status: 500, body: "unexpected call" };
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("generateIdeas / OpenAI互換", () => {
  it("posts to chat/completions with a Bearer key and JSON mode", async () => {
    const calls = mockFetch([{ body: { choices: [{ message: { content: '{"captions":["案A","案B"],"hashtags":["タグ1","#タグ1","タグ2"]}' } }] } }]);
    const ideas = await generateIdeas({ ...openai, prompt: "テスト" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example.com/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(calls[0]!.body.model).toBe("test-model");
    expect(calls[0]!.body.response_format).toEqual({ type: "json_object" });
    expect(ideas.captions).toEqual(["案A", "案B"]);
    // tags get a # prefix and duplicates collapse
    expect(ideas.hashtags).toEqual(["#タグ1", "#タグ2"]);
  });

  it("parses fenced and prose-wrapped responses", async () => {
    mockFetch([{ body: { choices: [{ message: { content: 'はい、こちらです:\n```json\n{"captions":[" fenced "],"hashtags":[]}\n```' } }] } }]);
    expect((await generateIdeas({ ...openai, prompt: "x" })).captions).toEqual(["fenced"]);
    mockFetch([{ body: { choices: [{ message: { content: '結果はこちら {"captions":["plain"],"hashtags":["a"]} をご確認ください' } }] } }]);
    expect((await generateIdeas({ ...openai, prompt: "x" })).captions).toEqual(["plain"]);
  });
});

describe("generateIdeas / Anthropic", () => {
  it("posts to v1/messages with x-api-key and joins text blocks", async () => {
    const payload = { captions: ["クロード案"], hashtags: ["#coffee", "#coffee", "#珈琲"] };
    const calls = mockFetch([{ body: { content: [{ type: "thinking", thinking: "..." }, { type: "text", text: JSON.stringify(payload) }] } }]);
    const ideas = await generateIdeas({ ...anthropic, prompt: "テスト" });
    expect(calls[0]!.url).toBe("https://api.example.com/v1/messages");
    expect(calls[0]!.headers["x-api-key"]).toBe("ak-test");
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]!.body.system).toBeTruthy();
    expect(calls[0]!.body.max_tokens).toBeGreaterThan(0);
    expect(calls[0]!.body.messages).toEqual([{ role: "user", content: "テスト" }]);
    expect(ideas.captions).toEqual(["クロード案"]);
    expect(ideas.hashtags).toEqual(["#coffee", "#珈琲"]);
  });

  it("accepts a base URL that already ends with /v1", async () => {
    const calls = mockFetch([{ body: { content: [{ type: "text", text: '{"captions":["x"],"hashtags":[]}' }] } }]);
    await generateIdeas({ ...anthropic, baseUrl: "https://api.example.com/v1", prompt: "x" });
    expect(calls[0]!.url).toBe("https://api.example.com/v1/messages");
  });
});

describe("generateIdeas / errors", () => {
  it("maps HTTP failures to actionable Japanese messages", async () => {
    mockFetch([{ status: 401, body: { error: { message: "bad key" } } }]);
    await expect(generateIdeas({ ...openai, prompt: "x" })).rejects.toThrow("APIキーが無効");
    mockFetch([{ status: 429, body: {} }]);
    await expect(generateIdeas({ ...openai, prompt: "x" })).rejects.toThrow("レート制限");
    mockFetch([{ status: 404, body: {} }]);
    await expect(generateIdeas({ ...anthropic, prompt: "x" })).rejects.toThrow("見つかりません");
    mockFetch([{ status: 500, body: "oops" }]);
    await expect(generateIdeas({ ...openai, prompt: "x" })).rejects.toThrow("AI APIエラー（500）");
  });

  it("never leaks the API key in error messages", async () => {
    mockFetch([{ status: 401, body: { error: { message: "invalid key sk-test" } } }]);
    let error: AiError | undefined;
    try {
      await generateIdeas({ ...openai, prompt: "x" });
    } catch (cause) {
      error = cause as AiError;
    }
    expect(error).toBeInstanceOf(AiError);
    expect(error?.message ?? "").not.toContain("sk-test");
  });

  it("rejects unparsable or empty responses", async () => {
    mockFetch([{ body: { choices: [{ message: { content: "これはJSONではありません" } }] } }]);
    await expect(generateIdeas({ ...openai, prompt: "x" })).rejects.toThrow("読み取れませんでした");
    mockFetch([{ body: { choices: [{ message: { content: '{"captions":[],"hashtags":[]}' } }] } }]);
    await expect(generateIdeas({ ...openai, prompt: "x" })).rejects.toThrow("利用できる案が含まれていません");
    mockFetch([{ body: {} }]);
    await expect(generateIdeas({ ...openai, prompt: "x" })).rejects.toThrow("応答がありません");
  });

  it("reports an abort as a timeout", async () => {
    vi.stubGlobal("fetch", async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });
    await expect(generateIdeas({ ...openai, prompt: "x" })).rejects.toThrow("タイムアウト");
  });
});
