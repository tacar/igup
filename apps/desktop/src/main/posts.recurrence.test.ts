import { describe, expect, it } from "vitest";
import { materializeNext, nextOccurrence, recurrenceLabel, validateRecurrence } from "./posts.js";
import { DEFAULT_ACCOUNT_ID, type MediaAsset, type Recurrence, type ScheduledPost } from "./types.js";

function rec(overrides: Partial<Recurrence> = {}): Recurrence {
  return { freq: "daily", interval: 1, weekdays: undefined, monthDay: undefined, time: "20:00", endAt: null, ...overrides };
}

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return { id: "a1", kind: "image", url: null, localPath: "/tmp/a.jpg", brokerId: "br_1", fileName: "a.jpg", size: 100, ...overrides };
}

function post(overrides: Partial<ScheduledPost> = {}): ScheduledPost {
  return {
    id: "post_1",
    accountId: DEFAULT_ACCOUNT_ID,
    kind: "image",
    scheduledAt: "2026-01-05T00:00:00.000Z",
    status: "published",
    caption: "hello",
    media: [],
    cover: null,
    shareToFeed: true,
    threads: [],
    attachRuleId: null,
    recurrence: null,
    seriesId: null,
    publishedId: "ig_1",
    permalink: "https://instagram.com/p/1",
    publishedAt: null,
    error: null,
    attempts: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Local-time Date for expectations, so tests are timezone independent. */
const local = (year: number, month: number, day: number, time: string) => {
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString();
};

describe("nextOccurrence", () => {
  it("advances daily by interval at the given local time", () => {
    // Fri 2026-01-02 20:00 → Sat 2026-01-03 20:00
    expect(nextOccurrence(rec(), local(2026, 1, 2, "20:00"))).toBe(local(2026, 1, 3, "20:00"));
    expect(nextOccurrence(rec({ interval: 3 }), local(2026, 1, 2, "20:00"))).toBe(local(2026, 1, 5, "20:00"));
  });

  it("keeps the same day when the publish happened before the repeat time", () => {
    // published 09:00, repeat at 20:00 → today 20:00
    expect(nextOccurrence(rec(), local(2026, 1, 2, "09:00"))).toBe(local(2026, 1, 2, "20:00"));
  });

  it("wraps weekly over selected weekdays", () => {
    // 2026-01-05 is Monday, 2026-01-08 is Thursday
    const weekly = rec({ freq: "weekly", weekdays: [1, 4] });
    expect(nextOccurrence(weekly, local(2026, 1, 5, "20:00"))).toBe(local(2026, 1, 8, "20:00")); // Mon → Thu
    expect(nextOccurrence(weekly, local(2026, 1, 8, "20:00"))).toBe(local(2026, 1, 12, "20:00")); // Thu → Mon
    expect(nextOccurrence(weekly, local(2026, 1, 9, "20:00"))).toBe(local(2026, 1, 12, "20:00")); // Fri → Mon
  });

  it("keeps the same weekday without weekdays and respects weekly interval", () => {
    const plain = rec({ freq: "weekly", weekdays: undefined });
    expect(nextOccurrence(plain, local(2026, 1, 5, "20:00"))).toBe(local(2026, 1, 12, "20:00"));
    const biweekly = rec({ freq: "weekly", weekdays: undefined, interval: 2 });
    expect(nextOccurrence(biweekly, local(2026, 1, 5, "20:00"))).toBe(local(2026, 1, 19, "20:00"));
  });

  it("clamps monthly day-of-month to the month length", () => {
    const monthly = rec({ freq: "monthly", monthDay: 31 });
    // from Jan 31 → Feb 28 (2026 is not a leap year)
    expect(nextOccurrence(monthly, local(2026, 1, 31, "20:00"))).toBe(local(2026, 2, 28, "20:00"));
    // from Feb 28 → Mar 31
    expect(nextOccurrence(monthly, local(2026, 2, 28, "20:00"))).toBe(local(2026, 3, 31, "20:00"));
  });

  it("monthly without monthDay keeps the anchor day", () => {
    const monthly = rec({ freq: "monthly", monthDay: undefined });
    expect(nextOccurrence(monthly, local(2026, 1, 15, "20:00"))).toBe(local(2026, 2, 15, "20:00"));
    expect(nextOccurrence(monthly, local(2026, 1, 31, "20:00"))).toBe(local(2026, 2, 28, "20:00")); // clamped from the 31st
  });

  it("stops at the inclusive endAt date", () => {
    expect(nextOccurrence(rec({ endAt: "2026-01-03" }), local(2026, 1, 2, "20:00"))).toBe(local(2026, 1, 3, "20:00"));
    expect(nextOccurrence(rec({ endAt: "2026-01-02" }), local(2026, 1, 2, "20:00"))).toBeNull();
  });

  it("rejects an unparsable time", () => {
    expect(nextOccurrence(rec({ time: "99:99" }), local(2026, 1, 2, "20:00"))).toBeNull();
  });
});

describe("validateRecurrence / recurrenceLabel", () => {
  it("accepts a valid schedule and reports problems for a broken one", () => {
    expect(validateRecurrence(rec({ freq: "weekly", weekdays: [1] }))).toEqual([]);
    const problems = validateRecurrence(rec({ interval: 0, time: "25:00", freq: "monthly", monthDay: 40, endAt: "not-a-date" }));
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it("labels schedules in Japanese", () => {
    expect(recurrenceLabel(rec())).toBe("毎日 20:00");
    expect(recurrenceLabel(rec({ interval: 2 }))).toBe("2日ごと 20:00");
    expect(recurrenceLabel(rec({ freq: "weekly", weekdays: [1, 4] }))).toBe("毎週(月,木) 20:00");
    expect(recurrenceLabel(rec({ freq: "weekly", weekdays: undefined, interval: 2 }))).toBe("2週ごと 20:00");
    expect(recurrenceLabel(rec({ freq: "monthly", monthDay: 15 }))).toBe("毎月15日 10:00".replace("10:00", "20:00"));
    expect(recurrenceLabel(rec({ endAt: "2026-03-31" }))).toBe("毎日 20:00（2026/03/31まで）");
  });
});

describe("materializeNext", () => {
  it("creates the next instance with publish state cleared", () => {
    const source = post({
      scheduledAt: local(2026, 1, 2, "20:00"),
      publishedAt: local(2026, 1, 2, "20:03"),
      recurrence: rec(),
      media: [asset()],
    });
    const next = materializeNext(source, source.publishedAt!)!;
    expect(next.id).not.toBe(source.id);
    expect(next.seriesId).toBe(source.id); // root id becomes the series id
    expect(next.scheduledAt).toBe(local(2026, 1, 3, "20:00"));
    expect(next.status).toBe("scheduled");
    expect(next.publishedId).toBeNull();
    expect(next.permalink).toBeNull();
    expect(next.publishedAt).toBeNull();
    expect(next.error).toBeNull();
    expect(next.attempts).toBe(0);
  });

  it("keeps the seriesId of an existing series", () => {
    const instance = post({ seriesId: "post_root", recurrence: rec(), publishedAt: local(2026, 1, 2, "20:03") });
    const next = materializeNext(instance, instance.publishedAt!)!;
    expect(next.seriesId).toBe("post_root");
  });

  it("deep-clones media and resets broker hosting so the finished instance stays untouched", () => {
    const media = asset({ brokerId: "br_1", url: "https://broker.example.com/f/1", localPath: "/tmp/a.jpg" });
    const cover = asset({ id: "a2", brokerId: "br_2", url: "https://broker.example.com/f/2", localPath: "/tmp/c.jpg" });
    const source = post({ recurrence: rec(), media: [media], cover, threads: [] });
    const next = materializeNext(source, source.scheduledAt)!;
    expect(next.media[0]).not.toBe(source.media[0]);
    expect(next.media[0]!.brokerId).toBeNull();
    expect(next.media[0]!.url).toBeNull(); // local file → broker URL is dropped
    expect(next.cover!.brokerId).toBeNull();
    expect(source.media[0]!.brokerId).toBe("br_1"); // original untouched
    expect(source.media[0]!.url).toBe("https://broker.example.com/f/1");
    expect(source.cover!.brokerId).toBe("br_2");
  });

  it("keeps remote-only asset URLs because they are user provided", () => {
    const remote = asset({ localPath: null, url: "https://cdn.example.com/video.mp4", brokerId: null, kind: "video" });
    const source = post({ recurrence: rec(), media: [remote] });
    const next = materializeNext(source, source.scheduledAt)!;
    expect(next.media[0]!.url).toBe("https://cdn.example.com/video.mp4");
  });

  it("returns null without recurrence or after the end date", () => {
    expect(materializeNext(post({ recurrence: null }), new Date().toISOString())).toBeNull();
    const bounded = post({ recurrence: rec({ endAt: "2026-01-02" }), scheduledAt: local(2026, 1, 2, "20:00") });
    expect(materializeNext(bounded, bounded.scheduledAt)).toBeNull();
  });
});
