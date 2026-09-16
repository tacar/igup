import { extname } from "node:path";
import { newId } from "./ids.js";
import type { MediaAsset, PostStatus, Recurrence, ScheduledPost } from "./types.js";
import { THREADS_CAROUSEL_LIMIT, THREADS_TEXT_LIMIT } from "./threads-client.js";

export const CAPTION_LIMIT = 2_200;
export const CAROUSEL_MIN = 2;
export const CAROUSEL_MAX = 10;

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
};

export function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

export function isVideoFile(fileName: string): boolean {
  return contentTypeFor(fileName).startsWith("video/");
}

export function isImageFile(fileName: string): boolean {
  return contentTypeFor(fileName).startsWith("image/");
}

export function assetHasSource(asset: MediaAsset): boolean {
  return Boolean(asset.url || asset.localPath);
}

/** Returns human-readable problems; an empty array means the post can be scheduled. */
export function validatePost(post: ScheduledPost): string[] {
  const problems: string[] = [];
  const images = post.media.filter((asset) => asset.kind === "image");
  const videos = post.media.filter((asset) => asset.kind === "video");

  if (Number.isNaN(Date.parse(post.scheduledAt))) problems.push("投稿日時を指定してください。");
  if (post.caption.length > CAPTION_LIMIT) problems.push(`キャプションは${CAPTION_LIMIT.toLocaleString("ja-JP")}文字以内にしてください。`);
  for (const asset of post.media) {
    if (!assetHasSource(asset)) problems.push(`「${asset.fileName}」のファイルが見つかりません。`);
  }

  switch (post.kind) {
    case "image":
      if (images.length !== 1 || videos.length > 0) problems.push("フィード画像投稿は画像1枚を選んでください。");
      break;
    case "carousel":
      if (post.media.length < CAROUSEL_MIN || post.media.length > CAROUSEL_MAX) problems.push(`カルーセルは${CAROUSEL_MIN}〜${CAROUSEL_MAX}枚の画像・動画を選んでください。`);
      break;
    case "reel":
      if (videos.length !== 1 || images.length > 0) problems.push("リールは動画1本を選んでください。");
      if (post.cover && post.cover.kind !== "image") problems.push("リールの表紙は画像を選んでください。");
      break;
    case "story":
      if (post.media.length !== 1) problems.push("ストーリーズは画像または動画を1つ選んでください。");
      break;
    case "threads": {
      if (post.threads.length === 0) problems.push("Threadsの投稿内容を入力してください。");
      post.threads.forEach((item, index) => {
        const label = post.threads.length > 1 ? `${index + 1}件目` : "投稿";
        if (!item.text.trim() && item.media.length === 0) problems.push(`Threads ${label}: 本文か画像・動画を入れてください。`);
        if (item.text.length > THREADS_TEXT_LIMIT) problems.push(`Threads ${label}: 本文は${THREADS_TEXT_LIMIT}文字以内にしてください。`);
        if (item.media.length > THREADS_CAROUSEL_LIMIT) problems.push(`Threads ${label}: 画像・動画は${THREADS_CAROUSEL_LIMIT}枚までです。`);
        for (const asset of item.media) {
          if (!assetHasSource(asset)) problems.push(`「${asset.fileName}」のファイルが見つかりません。`);
        }
      });
      break;
    }
  }
  if (post.recurrence) problems.push(...validateRecurrence(post.recurrence));
  return problems;
}

/** Returns human-readable problems with a repeat schedule; empty means it is usable. */
export function validateRecurrence(rec: Recurrence): string[] {
  const problems: string[] = [];
  if (!["daily", "weekly", "monthly"].includes(rec.freq)) problems.push("繰り返しの種別が不正です。");
  if (!Number.isInteger(rec.interval) || rec.interval < 1 || rec.interval > 365) problems.push("繰り返し間隔は1以上にしてください。");
  const [hours = Number.NaN, minutes = Number.NaN] = rec.time.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) problems.push("繰り返しの時刻は HH:MM 形式で指定してください。");
  if (rec.freq === "weekly" && rec.weekdays && (!Array.isArray(rec.weekdays) || rec.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) problems.push("曜日の指定が不正です。");
  if (rec.freq === "monthly" && rec.monthDay !== undefined && (!Number.isInteger(rec.monthDay) || rec.monthDay < 1 || rec.monthDay > 31)) problems.push("毎月の日付は1〜31で指定してください。");
  if (rec.endAt && Number.isNaN(Date.parse(`${rec.endAt}T00:00:00`))) problems.push("繰り返しの終了日が不正です。");
  return problems;
}

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

/** Human summary like「毎週(月,木) 20:00」or「毎月15日 10:00」. */
export function recurrenceLabel(rec: Recurrence): string {
  const parts: string[] = [];
  if (rec.freq === "daily") parts.push(rec.interval === 1 ? "毎日" : `${rec.interval}日ごと`);
  else if (rec.freq === "weekly") {
    const days = rec.weekdays?.length ? rec.weekdays.map((day) => WEEKDAY_LABELS[day] ?? "?").join(",") : null;
    if (rec.interval === 1) parts.push(days ? `毎週(${days})` : "毎週");
    else parts.push(days ? `${rec.interval}週ごと(${days})` : `${rec.interval}週ごと`);
  } else {
    const day = rec.monthDay !== undefined ? `${rec.monthDay}日` : null;
    parts.push(rec.interval === 1 ? (day ? `毎月${day}` : "毎月") : day ? `${rec.interval}ヶ月ごと(${day})` : `${rec.interval}ヶ月ごと`);
  }
  parts.push(` ${rec.time}`);
  if (rec.endAt) parts.push(`（${rec.endAt.replace(/-/g, "/")}まで）`);
  return parts.join("");
}

export function isDue(post: ScheduledPost, now = Date.now()): boolean {
  return post.status === "scheduled" && Date.parse(post.scheduledAt) <= now;
}

export function isMissed(post: ScheduledPost, graceMinutes: number, now = Date.now()): boolean {
  return isDue(post, now) && now - Date.parse(post.scheduledAt) > graceMinutes * 60_000;
}

export const POST_KIND_LABELS: Record<ScheduledPost["kind"], string> = {
  image: "フィード画像",
  carousel: "カルーセル",
  reel: "リール",
  story: "ストーリーズ",
  threads: "Threads",
};

export const POST_STATUS_LABELS: Record<PostStatus, string> = {
  scheduled: "予約中",
  publishing: "投稿中",
  published: "投稿済み",
  failed: "失敗",
  missed: "未投稿（時間超過）",
  canceled: "取り消し",
};

// ---------------------------------------------------------------- recurrence

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function atLocalTime(day: Date, hours: number, minutes: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
}

function addDays(day: Date, days: number): Date {
  const next = new Date(day);
  next.setDate(next.getDate() + days);
  return next;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function dateKeyOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Next occurrence of a repeat schedule strictly after `fromIso`, in local time.
 * Weekly with weekdays picks the first later matching weekday (interval > 1 shifts
 * whole weeks); monthly clamps the day to the month length (31 → 2/28). Returns
 * null when the next occurrence would fall after the inclusive endAt date.
 */
export function nextOccurrence(rec: Recurrence, fromIso: string): string | null {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return null;
  const [hours = Number.NaN, minutes = Number.NaN] = rec.time.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  let candidate: Date;

  if (rec.freq === "daily") {
    let day = startOfLocalDay(from);
    candidate = atLocalTime(day, hours, minutes);
    while (candidate.getTime() <= from.getTime()) {
      day = addDays(day, rec.interval);
      candidate = atLocalTime(day, hours, minutes);
    }
  } else if (rec.freq === "weekly" && rec.weekdays && rec.weekdays.length > 0) {
    const wanted = new Set(rec.weekdays);
    let day = addDays(startOfLocalDay(from), 1);
    while (!wanted.has(day.getDay())) day = addDays(day, 1);
    if (rec.interval > 1) day = addDays(day, (rec.interval - 1) * 7);
    candidate = atLocalTime(day, hours, minutes);
  } else if (rec.freq === "weekly") {
    let day = startOfLocalDay(from);
    candidate = atLocalTime(day, hours, minutes);
    while (candidate.getTime() <= from.getTime()) {
      day = addDays(day, 7 * rec.interval);
      candidate = atLocalTime(day, hours, minutes);
    }
  } else {
    const anchorDay = rec.monthDay ?? from.getDate();
    let year = from.getFullYear();
    let month = from.getMonth();
    do {
      month += rec.interval;
      year += Math.floor(month / 12);
      month = ((month % 12) + 12) % 12;
      candidate = new Date(year, month, Math.min(anchorDay, daysInMonth(year, month)), hours, minutes, 0, 0);
    } while (candidate.getTime() <= from.getTime());
  }

  if (rec.endAt && dateKeyOf(candidate) > rec.endAt) return null;
  return candidate.toISOString();
}

/**
 * Builds the next instance of a repeat series from a finished (published / failed /
 * missed) one. Media and cover are deep-cloned with broker hosting fields reset —
 * cleanupBrokerMedia mutates the previous instance's assets in place — and publish
 * results are cleared so the instance starts fresh.
 */
export function materializeNext(post: ScheduledPost, fromIso: string): ScheduledPost | null {
  if (!post.recurrence) return null;
  const scheduledAt = nextOccurrence(post.recurrence, fromIso);
  if (!scheduledAt) return null;
  const resetAsset = (asset: MediaAsset): MediaAsset => ({ ...asset, brokerId: null, url: asset.localPath ? null : asset.url });
  return {
    ...post,
    id: newId("post"),
    seriesId: post.seriesId ?? post.id,
    scheduledAt,
    status: "scheduled",
    media: post.media.map(resetAsset),
    cover: post.cover ? resetAsset(post.cover) : null,
    threads: post.threads.map((item) => ({ ...item, media: item.media.map(resetAsset) })),
    publishedId: null,
    permalink: null,
    publishedAt: null,
    error: null,
    attempts: 0,
  };
}
