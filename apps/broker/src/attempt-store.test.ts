import { describe, expect, it } from "vitest";
import { AttemptStore } from "./attempt-store.js";

describe("AttemptStore", () => {
  it("redeems a completed result exactly once", () => {
    const store = new AttemptStore();
    const attempt = store.create(1_000);
    const connection = { accessToken: "secret", expiresAt: null };
    expect(store.complete(attempt.state, connection, 2_000)).toBe(true);
    expect(store.redeem(attempt.state, attempt.verifier, 3_000)).toEqual(connection);
    expect(store.redeem(attempt.state, attempt.verifier, 3_000)).toBeNull();
  });

  it("rejects the wrong verifier and expired attempts", () => {
    const store = new AttemptStore();
    const attempt = store.create(1_000);
    store.complete(attempt.state, { accessToken: "secret", expiresAt: null }, 2_000);
    expect(store.redeem(attempt.state, "wrong", 3_000)).toBeNull();
    expect(store.exists(attempt.state, 700_001)).toBe(false);
  });
});
