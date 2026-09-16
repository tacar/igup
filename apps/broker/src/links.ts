import { randomBytes } from "node:crypto";
import type { StoredLink } from "./store.js";

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const PREVIEW_BOTS = /facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|TelegramBot|line-poker|Applebot|Googlebot|bingbot|SkypeUriPreview|Embedly|Iframely|Pinterest|vkShare|redditbot|Snapchat/i;
const MAX_DAILY_KEYS = 400;

export type LinkInput = { url: string; label: string; source: string; slug: string | null };
export type PublicLink = Omit<StoredLink, "ownerId"> & { trackedUrl: string };

export function generateSlug(length = 7): string {
  const bytes = randomBytes(length);
  let slug = "";
  for (const byte of bytes) slug += ALPHABET[byte % ALPHABET.length];
  return slug;
}

export function parseLinkInput(body: unknown): { ok: true; value: LinkInput } | { ok: false; error: string } {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const url = typeof record.url === "string" ? record.url.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "URLを正しく入力してください。" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "URLはhttp(s)で始まる必要があります。" };
  if (url.length > 2_000) return { ok: false, error: "URLが長すぎます（2,000文字まで）。" };
  const label = typeof record.label === "string" ? record.label.trim().slice(0, 100) : "";
  const source = typeof record.source === "string" && record.source.trim() ? record.source.trim().slice(0, 40) : "other";
  let slug: string | null = null;
  if (typeof record.slug === "string" && record.slug.trim()) {
    slug = record.slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return { ok: false, error: "短縮名は半角英数字とハイフン（2〜40文字）で指定してください。" };
  }
  return { ok: true, value: { url, label: label || parsed.hostname, source, slug } };
}

/** Which medium a click came from: an explicit ?s= tag wins, then the referer, then "direct". */
export function classifySource(override: unknown, referer: string | undefined): string {
  if (typeof override === "string" && override.trim()) {
    const cleaned = override.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
    if (cleaned) return cleaned;
  }
  if (!referer) return "direct";
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
  if (/(^|\.)threads\.(net|com)$/.test(host)) return "threads";
  if (/(^|\.)(line\.me|line-apps\.com)$/.test(host)) return "line";
  if (/(^|\.)(facebook\.com|fb\.com|fb\.me)$/.test(host)) return "facebook";
  if (/(^|\.)(twitter\.com|x\.com)$/.test(host) || host === "t.co") return "x";
  return "other";
}

export function isPreviewBot(userAgent: string | undefined): boolean {
  return Boolean(userAgent && PREVIEW_BOTS.test(userAgent));
}

/** YYYY-MM-DD in the owner's time zone, so "today" matches what they see in the app. */
export function dateKey(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

export function recordClick(link: StoredLink, source: string, key: string): void {
  link.total += 1;
  link.daily[key] = (link.daily[key] ?? 0) + 1;
  link.sources[source] = (link.sources[source] ?? 0) + 1;
  const keys = Object.keys(link.daily).sort();
  while (keys.length > MAX_DAILY_KEYS) {
    const oldest = keys.shift();
    if (oldest) delete link.daily[oldest];
  }
}

export function publicLink(link: StoredLink, baseUrl: string): PublicLink {
  const { ownerId: _ownerId, ...rest } = link;
  return { ...rest, trackedUrl: `${baseUrl}/l/${link.slug}` };
}
