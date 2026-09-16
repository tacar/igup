import { describe, expect, it } from "vitest";
import { classifySource, generateSlug, isPreviewBot, parseLinkInput, recordClick, SLUG_PATTERN } from "./links.js";
import type { StoredLink } from "./store.js";

function link(overrides: Partial<StoredLink> = {}): StoredLink {
  return { slug: "abc1234", ownerId: "owner", url: "https://example.com", label: "example", source: "other", createdAt: "2024-01-01T00:00:00.000Z", total: 0, daily: {}, sources: {}, ...overrides };
}

describe("generateSlug", () => {
  it("produces slugs matching the accepted slug pattern", () => {
    for (let i = 0; i < 20; i += 1) expect(generateSlug()).toMatch(SLUG_PATTERN);
  });

  it("varies output across calls", () => {
    const slugs = new Set(Array.from({ length: 20 }, () => generateSlug()));
    expect(slugs.size).toBeGreaterThan(1);
  });
});

describe("parseLinkInput", () => {
  it("accepts a valid https URL and fills defaults", () => {
    const result = parseLinkInput({ url: "https://example.com/path" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.label).toBe("example.com");
      expect(result.value.source).toBe("other");
      expect(result.value.slug).toBeNull();
    }
  });

  it("rejects an unparseable URL", () => {
    expect(parseLinkInput({ url: "not a url" })).toEqual({ ok: false, error: "URLを正しく入力してください。" });
  });

  it("rejects non-http(s) protocols", () => {
    expect(parseLinkInput({ url: "ftp://example.com/file" }).ok).toBe(false);
  });

  it("rejects URLs longer than 2000 characters", () => {
    const longUrl = `https://example.com/${"a".repeat(2_000)}`;
    expect(parseLinkInput({ url: longUrl })).toEqual({ ok: false, error: "URLが長すぎます（2,000文字まで）。" });
  });

  it("validates a custom slug against the slug pattern", () => {
    const tooShort = parseLinkInput({ url: "https://example.com", slug: "a" });
    expect(tooShort.ok).toBe(false);
    const withSymbol = parseLinkInput({ url: "https://example.com", slug: "a!b" });
    expect(withSymbol.ok).toBe(false);
    const valid = parseLinkInput({ url: "https://example.com", slug: "MyLink" });
    expect(valid).toEqual({ ok: true, value: expect.objectContaining({ slug: "mylink" }) });
  });
});

describe("classifySource", () => {
  it("prefers a cleaned explicit override", () => {
    expect(classifySource("Story Highlight!", undefined)).toBe("storyhighlight");
  });

  it("falls back to direct with no referer", () => {
    expect(classifySource(undefined, undefined)).toBe("direct");
  });

  it("recognizes known social referers", () => {
    expect(classifySource(undefined, "https://l.instagram.com/foo")).toBe("instagram");
    expect(classifySource(undefined, "https://www.threads.net/t/123")).toBe("threads");
    expect(classifySource(undefined, "https://t.co/abc")).toBe("x");
    expect(classifySource(undefined, "https://lin.ee/abc")).toBe("other");
  });

  it("returns other for an unrecognized or malformed referer", () => {
    expect(classifySource(undefined, "https://news.example.com/a")).toBe("other");
    expect(classifySource(undefined, "not a url")).toBe("other");
  });
});

describe("isPreviewBot", () => {
  it("flags known link-preview crawlers", () => {
    expect(isPreviewBot("facebookexternalhit/1.1")).toBe(true);
    expect(isPreviewBot("Slackbot-LinkExpanding 1.0")).toBe(true);
  });

  it("does not flag a regular browser or missing header", () => {
    expect(isPreviewBot("Mozilla/5.0 (Macintosh)")).toBe(false);
    expect(isPreviewBot(undefined)).toBe(false);
  });
});

describe("recordClick", () => {
  it("increments total, daily and source counters", () => {
    const item = link();
    recordClick(item, "instagram", "2024-01-01");
    recordClick(item, "instagram", "2024-01-01");
    recordClick(item, "direct", "2024-01-02");
    expect(item.total).toBe(3);
    expect(item.daily).toEqual({ "2024-01-01": 2, "2024-01-02": 1 });
    expect(item.sources).toEqual({ instagram: 2, direct: 1 });
  });

  it("evicts the oldest daily key once more than 400 days are tracked", () => {
    const item = link();
    for (let i = 0; i <= 400; i += 1) recordClick(item, "direct", `d${String(i).padStart(4, "0")}`);
    const keys = Object.keys(item.daily);
    expect(keys).toHaveLength(400);
    expect(item.daily["d0000"]).toBeUndefined();
    expect(item.daily["d0400"]).toBe(1);
  });
});
