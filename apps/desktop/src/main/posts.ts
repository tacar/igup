import { extname } from "node:path";
import type { MediaAsset, PostStatus, ScheduledPost } from "./types.js";
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
  return problems;
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
