import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookEntry = {
  id?: string | number;
  time?: number;
  messaging?: { recipient?: { id?: string | number } }[];
  changes?: unknown[];
};

export type WebhookPayload = { object?: string; entry?: WebhookEntry[] };

/** Validates Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the app secret). */
export function verifySignature(rawBody: Uint8Array, header: string | string[] | undefined, secret: string): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = value.slice(7).trim().toLowerCase();
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
}

/** Account ids an entry is addressed to: the entry id plus every message recipient. */
export function webhookTargets(entry: WebhookEntry): string[] {
  const targets = new Set<string>();
  if (entry.id !== undefined && entry.id !== null && String(entry.id)) targets.add(String(entry.id));
  for (const item of entry.messaging ?? []) {
    const id = item?.recipient?.id;
    if (id !== undefined && id !== null && String(id)) targets.add(String(id));
  }
  return [...targets];
}
