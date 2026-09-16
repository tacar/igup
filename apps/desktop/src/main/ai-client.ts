import type { AiSettings } from "./types.js";

/**
 * Caption / hashtag generation against a user-supplied AI API key.
 * Two providers: OpenAI-compatible (chat/completions, Bearer auth, JSON mode with a
 * plain-text fallback) and Anthropic (v1/messages, x-api-key + anthropic-version).
 * Raw fetch, no SDK dependency; the key never appears in error messages or logs.
 */

export type AiIdeas = { captions: string[]; hashtags: string[] };

export class AiError extends Error {}

const TIMEOUT_MS = 60_000;
const MAX_TOKENS = 2048;

const SYSTEM_PROMPT = [
  "あなたはInstagram・Threads運用のプロフェッショナルコピーライターです。日本語で、読者に行動を促す自然な投稿文を書きます。",
  "記号や絵文字は適度に使い、過度な誇張はしません。ハッシュタグは投稿の内容に合ったものを選びます。",
  '必ず次のJSON形式のみを出力してください。説明・挨拶・コードフェンスは一切書かないでください:',
  '{"captions": ["投稿文の案1", "投稿文の案2", "投稿文の案3"], "hashtags": ["#タグ1", "#タグ2", "#タグ3"]}',
].join("\n");

export type AiRequest = AiSettings & { apiKey: string; prompt: string };

export async function generateIdeas(request: AiRequest): Promise<AiIdeas> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const text = request.provider === "anthropic"
      ? await callAnthropic(request, controller.signal)
      : await callOpenAiCompatible(request, controller.signal);
    return normalizeIdeas(extractJson(text));
  } catch (cause) {
    if (cause instanceof AiError) throw cause;
    if (cause instanceof Error && cause.name === "AbortError") throw new AiError("AI APIがタイムアウトしました（60秒）。もう一度お試しください。");
    throw new AiError(`AI APIに接続できませんでした: ${messageOf(cause)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- providers

async function callOpenAiCompatible(request: AiRequest, signal: AbortSignal): Promise<string> {
  const base = request.baseUrl.trim().replace(/\/+$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${request.apiKey}` },
    body: JSON.stringify({
      model: request.model,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: request.prompt },
      ],
      response_format: { type: "json_object" },
    }),
    signal,
  });
  if (!response.ok) throw await httpError(response);
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new AiError("AIから応答がありませんでした。");
  return text;
}

async function callAnthropic(request: AiRequest, signal: AbortSignal): Promise<string> {
  const base = request.baseUrl.trim().replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": request.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: request.prompt }],
    }),
    signal,
  });
  if (!response.ok) throw await httpError(response);
  const data = (await response.json()) as { content?: { type: string; text?: string }[] };
  const text = (data.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
  if (!text.trim()) throw new AiError("AIから応答がありませんでした。");
  return text;
}

/** Maps HTTP failures to Japanese, actionable messages (never echoing the key). */
async function httpError(response: Response): Promise<AiError> {
  let detail = "";
  try {
    detail = (await response.text()).replace(/\s+/g, " ").slice(0, 200);
  } catch {
    // body unreadable — fall through to the generic message
  }
  if (response.status === 401 || response.status === 403) return new AiError("APIキーが無効か、権限がありません。設定画面でキーを確認してください。");
  if (response.status === 404) return new AiError("エンドポイントまたはモデルが見つかりません。ベースURLとモデル名を確認してください。");
  if (response.status === 429) return new AiError("AI APIの利用制限（レート制限）に達しました。しばらく待ってから再試行してください。");
  return new AiError(`AI APIエラー（${response.status}）${detail ? `: ${detail}` : ""}`);
}

// ---------------------------------------------------------------- response shaping

/** Tolerant JSON extraction: accepts fenced output and prose around the object. */
function extractJson(text: string): { captions?: unknown; hashtags?: unknown } {
  let value = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(value);
  if (fenced) value = fenced[1]!.trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start >= 0 && end > start) value = value.slice(start, end + 1);
  try {
    return JSON.parse(value) as { captions?: unknown; hashtags?: unknown };
  } catch {
    throw new AiError("AIの応答を読み取れませんでした。もう一度お試しください。");
  }
}

function normalizeIdeas(parsed: { captions?: unknown; hashtags?: unknown }): AiIdeas {
  const captions = stringList(parsed.captions).slice(0, 3);
  const hashtags = [...new Set(stringList(parsed.hashtags).map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)))].slice(0, 15);
  if (captions.length === 0 && hashtags.length === 0) throw new AiError("AIの応答に利用できる案が含まれていませんでした。もう一度お試しください。");
  return { captions, hashtags };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
