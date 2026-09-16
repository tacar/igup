import { randomBytes } from "node:crypto";

export function newId(prefix = ""): string {
  const random = randomBytes(9).toString("base64url");
  return prefix ? `${prefix}_${random}` : random;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
