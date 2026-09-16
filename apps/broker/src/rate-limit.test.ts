import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  it("allows up to the configured limit within the window, then blocks", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.allow("k", 0)).toBe(true);
    expect(limiter.allow("k", 10)).toBe(true);
    expect(limiter.allow("k", 20)).toBe(true);
    expect(limiter.allow("k", 30)).toBe(false);
  });

  it("forgets hits once they fall outside the window", () => {
    const limiter = new RateLimiter(1, 1_000);
    expect(limiter.allow("k", 0)).toBe(true);
    expect(limiter.allow("k", 500)).toBe(false);
    expect(limiter.allow("k", 1_001)).toBe(true);
  });

  it("tracks separate keys independently", () => {
    const limiter = new RateLimiter(1, 1_000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("b", 0)).toBe(true);
  });
});
