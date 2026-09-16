import { newId } from "./ids.js";
import type { StoredApplication, StoredReminder, StoredSeminar, StoredSeminarDate } from "./store.js";

export type SeminarDefinition = {
  title: string;
  description: string;
  dates: StoredSeminarDate[];
  liffId: string | null;
  thanksMessage: string;
  reminders: StoredReminder[];
  enabled: boolean;
};

export type PublicSeminar = SeminarDefinition & {
  id: string;
  publicUrl: string;
  createdAt: string;
  updatedAt: string;
  applications: StoredApplication[];
};

const MAX_DATES = 30;
const MAX_REMINDERS = 10;

export function parseSeminarInput(body: unknown): { ok: true; value: SeminarDefinition } | { ok: false; error: string } {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) return { ok: false, error: "セミナー名を入力してください。" };
  if (title.length > 200) return { ok: false, error: "セミナー名は200文字以内で入力してください。" };
  const description = typeof record.description === "string" ? record.description.slice(0, 5_000) : "";

  const rawDates = Array.isArray(record.dates) ? record.dates : [];
  if (rawDates.length === 0) return { ok: false, error: "日程を1つ以上追加してください。" };
  if (rawDates.length > MAX_DATES) return { ok: false, error: `日程は${MAX_DATES}件までです。` };
  const dates: StoredSeminarDate[] = [];
  for (const raw of rawDates) {
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const startsAt = typeof item.startsAt === "string" ? item.startsAt : "";
    const parsed = Date.parse(startsAt);
    if (!startsAt || Number.isNaN(parsed)) return { ok: false, error: "日程の日時が正しくありません。" };
    let capacity: number | null = null;
    if (item.capacity !== null && item.capacity !== undefined) {
      const value = Number(item.capacity);
      if (!Number.isInteger(value) || value < 1) return { ok: false, error: "定員は1以上の整数で入力してください。" };
      capacity = value;
    }
    dates.push({ id: typeof item.id === "string" && item.id ? item.id : newId("date"), startsAt: new Date(parsed).toISOString(), capacity });
  }

  const rawReminders = Array.isArray(record.reminders) ? record.reminders : [];
  if (rawReminders.length > MAX_REMINDERS) return { ok: false, error: `リマインドは${MAX_REMINDERS}件までです。` };
  const reminders: StoredReminder[] = [];
  for (const raw of rawReminders) {
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const hoursBefore = Number(item.hoursBefore);
    if (!Number.isFinite(hoursBefore) || hoursBefore <= 0) return { ok: false, error: "リマインドの時間は0より大きい数値で入力してください。" };
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) return { ok: false, error: "リマインドの本文を入力してください。" };
    reminders.push({ id: typeof item.id === "string" && item.id ? item.id : newId("rem"), hoursBefore, text: text.slice(0, 500) });
  }

  const liffId = typeof record.liffId === "string" && record.liffId.trim() ? record.liffId.trim().slice(0, 100) : null;
  const thanksMessage = typeof record.thanksMessage === "string" ? record.thanksMessage.slice(0, 1_000) : "";
  const enabled = record.enabled !== false;

  return { ok: true, value: { title, description, dates, liffId, thanksMessage, reminders, enabled } };
}

export function toPublicSeminar(stored: StoredSeminar, baseUrl: string): PublicSeminar {
  const { ownerId: _ownerId, ownerKeys: _ownerKeys, ...rest } = stored;
  return { ...rest, publicUrl: `${baseUrl}/s/${stored.id}` };
}

export type ApplicationInput = { dateId: string; name: string; email: string | null; lineUserId: string | null };

export function parseApplicationInput(body: unknown, seminar: StoredSeminar): { ok: true; value: ApplicationInput } | { ok: false; error: string } {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const dateId = typeof record.dateId === "string" ? record.dateId : "";
  const date = seminar.dates.find((item) => item.id === dateId);
  if (!date) return { ok: false, error: "日程を選択してください。" };
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return { ok: false, error: "お名前を入力してください。" };
  if (name.length > 100) return { ok: false, error: "お名前は100文字以内で入力してください。" };
  let email: string | null = null;
  if (typeof record.email === "string" && record.email.trim()) {
    email = record.email.trim().slice(0, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "メールアドレスの形式が正しくありません。" };
  }
  const lineUserId = typeof record.lineUserId === "string" && record.lineUserId.trim() ? record.lineUserId.trim().slice(0, 100) : null;
  if (date.capacity !== null) {
    const count = seminar.applications.filter((application) => application.dateId === dateId).length;
    if (count >= date.capacity) return { ok: false, error: "あいにく、この日程は満席になりました。" };
  }
  return { ok: true, value: { dateId, name, email, lineUserId } };
}

export function newApplication(input: ApplicationInput, now = Date.now()): StoredApplication {
  return { id: newId("app"), dateId: input.dateId, name: input.name, email: input.email, lineUserId: input.lineUserId, createdAt: new Date(now).toISOString() };
}
