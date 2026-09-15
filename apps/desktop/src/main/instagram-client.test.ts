import { describe, expect, it } from "vitest";
import { validatePublishInput } from "./instagram-client.js";

describe("validatePublishInput", () => {
  it("accepts a public HTTPS URL and boundary caption", () => {
    expect(() => validatePublishInput("https://example.com/image.jpg", "a".repeat(2_200))).not.toThrow();
  });

  it.each(["", "invalid", "http://example.com/image.jpg"])("rejects invalid URL %s", (url) => {
    expect(() => validatePublishInput(url, "caption")).toThrow();
  });

  it("rejects captions over the Instagram limit", () => {
    expect(() => validatePublishInput("https://example.com/image.jpg", "a".repeat(2_201))).toThrow();
  });
});
