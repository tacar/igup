import { describe, expect, it } from "vitest";
import { assetHasSource, contentTypeFor, isDue, isImageFile, isMissed, isVideoFile, validatePost } from "./posts.js";
import type { MediaAsset, ScheduledPost } from "./types.js";

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return { id: "a1", kind: "image", url: "https://example.com/a.jpg", localPath: null, brokerId: null, fileName: "a.jpg", size: 100, ...overrides };
}

function post(overrides: Partial<ScheduledPost> = {}): ScheduledPost {
  return {
    id: "post_1",
    kind: "image",
    scheduledAt: "2024-01-01T00:00:00.000Z",
    status: "scheduled",
    caption: "",
    media: [asset()],
    cover: null,
    shareToFeed: true,
    threads: [],
    attachRuleId: null,
    publishedId: null,
    permalink: null,
    publishedAt: null,
    error: null,
    attempts: 0,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("contentTypeFor / isImageFile / isVideoFile", () => {
  it("maps known extensions to their content type", () => {
    expect(contentTypeFor("photo.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("clip.mov")).toBe("video/quicktime");
  });

  it("falls back to a generic type for unknown extensions", () => {
    expect(contentTypeFor("file.xyz")).toBe("application/octet-stream");
    expect(isImageFile("file.xyz")).toBe(false);
    expect(isVideoFile("file.xyz")).toBe(false);
  });

  it("distinguishes images from videos", () => {
    expect(isImageFile("a.png")).toBe(true);
    expect(isVideoFile("a.png")).toBe(false);
    expect(isVideoFile("a.mp4")).toBe(true);
    expect(isImageFile("a.mp4")).toBe(false);
  });
});

describe("assetHasSource", () => {
  it("is true with a remote url or a local path, false with neither", () => {
    expect(assetHasSource(asset({ url: "https://example.com/a.jpg", localPath: null }))).toBe(true);
    expect(assetHasSource(asset({ url: null, localPath: "/tmp/a.jpg" }))).toBe(true);
    expect(assetHasSource(asset({ url: null, localPath: null }))).toBe(false);
  });
});

describe("validatePost", () => {
  it("flags an unparseable date, an over-length caption, and a missing file", () => {
    const problems = validatePost(post({ scheduledAt: "not a date", caption: "a".repeat(2_201), media: [asset({ url: null, localPath: null })] }));
    expect(problems).toContain("投稿日時を指定してください。");
    expect(problems.some((p) => p.includes("キャプションは"))).toBe(true);
    expect(problems.some((p) => p.includes("ファイルが見つかりません"))).toBe(true);
  });

  describe("image posts", () => {
    it("requires exactly one image and no video", () => {
      expect(validatePost(post({ kind: "image", media: [asset()] }))).toEqual([]);
      expect(validatePost(post({ kind: "image", media: [] }))).toContain("フィード画像投稿は画像1枚を選んでください。");
      expect(validatePost(post({ kind: "image", media: [asset(), asset({ id: "a2" })] }))).toContain("フィード画像投稿は画像1枚を選んでください。");
      expect(validatePost(post({ kind: "image", media: [asset(), asset({ id: "v1", kind: "video" })] }))).toContain("フィード画像投稿は画像1枚を選んでください。");
    });
  });

  describe("carousel posts", () => {
    it("requires between 2 and 10 items", () => {
      expect(validatePost(post({ kind: "carousel", media: [asset(), asset({ id: "a2" })] }))).toEqual([]);
      expect(validatePost(post({ kind: "carousel", media: [asset()] }))).toContain("カルーセルは2〜10枚の画像・動画を選んでください。");
      const eleven = Array.from({ length: 11 }, (_, i) => asset({ id: `a${i}` }));
      expect(validatePost(post({ kind: "carousel", media: eleven }))).toContain("カルーセルは2〜10枚の画像・動画を選んでください。");
    });
  });

  describe("reel posts", () => {
    it("requires exactly one video, no images, and an image cover", () => {
      const video = asset({ id: "v1", kind: "video" });
      expect(validatePost(post({ kind: "reel", media: [video] }))).toEqual([]);
      expect(validatePost(post({ kind: "reel", media: [] }))).toContain("リールは動画1本を選んでください。");
      expect(validatePost(post({ kind: "reel", media: [video, asset()] }))).toContain("リールは動画1本を選んでください。");
      expect(validatePost(post({ kind: "reel", media: [video], cover: asset({ id: "cover", kind: "video" }) }))).toContain("リールの表紙は画像を選んでください。");
    });
  });

  describe("story posts", () => {
    it("requires exactly one media item", () => {
      expect(validatePost(post({ kind: "story", media: [asset()] }))).toEqual([]);
      expect(validatePost(post({ kind: "story", media: [] }))).toContain("ストーリーズは画像または動画を1つ選んでください。");
      expect(validatePost(post({ kind: "story", media: [asset(), asset({ id: "a2" })] }))).toContain("ストーリーズは画像または動画を1つ選んでください。");
    });
  });

  describe("threads posts", () => {
    it("requires at least one item with text or media, within the text and media limits", () => {
      expect(validatePost(post({ kind: "threads", media: [], threads: [{ text: "hello", media: [] }] }))).toEqual([]);
      expect(validatePost(post({ kind: "threads", media: [], threads: [] }))).toContain("Threadsの投稿内容を入力してください。");
      expect(validatePost(post({ kind: "threads", media: [], threads: [{ text: "", media: [] }] }))).toContain("Threads 投稿: 本文か画像・動画を入れてください。");
      expect(validatePost(post({ kind: "threads", media: [], threads: [{ text: "a".repeat(501), media: [] }] }))).toContain("Threads 投稿: 本文は500文字以内にしてください。");
      const tooManyMedia = Array.from({ length: 21 }, (_, i) => asset({ id: `t${i}` }));
      expect(validatePost(post({ kind: "threads", media: [], threads: [{ text: "hi", media: tooManyMedia }] }))).toContain("Threads 投稿: 画像・動画は20枚までです。");
    });

    it("labels multiple items by position", () => {
      const problems = validatePost(post({ kind: "threads", media: [], threads: [{ text: "hi", media: [] }, { text: "", media: [] }] }));
      expect(problems).toContain("Threads 2件目: 本文か画像・動画を入れてください。");
    });
  });
});

describe("isDue / isMissed", () => {
  it("is due once scheduled and the time has arrived, but not before or for other statuses", () => {
    expect(isDue(post({ status: "scheduled", scheduledAt: "2024-01-01T00:00:00.000Z" }), Date.parse("2024-01-01T00:00:00.000Z"))).toBe(true);
    expect(isDue(post({ status: "scheduled", scheduledAt: "2024-01-02T00:00:00.000Z" }), Date.parse("2024-01-01T00:00:00.000Z"))).toBe(false);
    expect(isDue(post({ status: "published", scheduledAt: "2024-01-01T00:00:00.000Z" }), Date.parse("2024-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("is missed once due and past the grace period, not before it", () => {
    const scheduledAt = "2024-01-01T00:00:00.000Z";
    const due = Date.parse(scheduledAt);
    expect(isMissed(post({ scheduledAt }), 30, due + 10 * 60_000)).toBe(false);
    expect(isMissed(post({ scheduledAt }), 30, due + 31 * 60_000)).toBe(true);
    expect(isMissed(post({ scheduledAt, status: "published" }), 30, due + 31 * 60_000)).toBe(false);
  });
});
