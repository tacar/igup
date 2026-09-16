import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature, webhookTargets } from "./webhook.js";

describe("verifySignature", () => {
  const secret = "shh";
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const sign = (payload: Buffer, key = secret) => `sha256=${createHmac("sha256", key).update(payload).digest("hex")}`;

  it("accepts a correctly signed body", () => {
    expect(verifySignature(body, sign(body), secret)).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    expect(verifySignature(body, sign(body, "other"), secret)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from(JSON.stringify({ hello: "mallory" }));
    expect(verifySignature(tampered, sign(body), secret)).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, "not-sha256=abc", secret)).toBe(false);
  });

  it("uses the first value when the header arrives as an array", () => {
    expect(verifySignature(body, [sign(body)], secret)).toBe(true);
  });
});

describe("webhookTargets", () => {
  it("collects the entry id and every message recipient, deduplicated", () => {
    const targets = webhookTargets({
      id: "17800",
      messaging: [{ recipient: { id: "17800" } }, { recipient: { id: "99" } }],
    });
    expect(targets.sort()).toEqual(["17800", "99"]);
  });

  it("returns an empty list when nothing identifies an owner", () => {
    expect(webhookTargets({})).toEqual([]);
  });
});
