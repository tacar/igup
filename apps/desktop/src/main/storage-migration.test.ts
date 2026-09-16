import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "./types.js";
import { emptySecrets, migrateSecrets } from "./storage.js";

describe("migrateSecrets", () => {
  it("wraps v2 connections under the default account", () => {
    const migrated = migrateSecrets({
      version: 2,
      connections: {
        instagram: { encrypted: "ENC_IG", expiresAt: "2026-01-01T00:00:00.000Z" },
        threads: { encrypted: "ENC_TH", expiresAt: null },
      },
      lineChannelToken: "ENC_LINE",
      localApiToken: "ENC_API",
    });
    expect(migrated.version).toBe(3);
    expect(migrated.accounts[DEFAULT_ACCOUNT_ID]).toEqual({
      instagram: { encrypted: "ENC_IG", expiresAt: "2026-01-01T00:00:00.000Z" },
      threads: { encrypted: "ENC_TH", expiresAt: null },
    });
    expect(migrated.lineChannelToken).toBe("ENC_LINE");
    expect(migrated.localApiToken).toBe("ENC_API");
    expect(migrated.aiApiKey).toBeNull();
  });

  it("accepts the bare v1 connection object", () => {
    const migrated = migrateSecrets({ encrypted: "ENC_V1", expiresAt: null });
    expect(migrated.accounts[DEFAULT_ACCOUNT_ID]?.instagram).toEqual({ encrypted: "ENC_V1", expiresAt: null });
    expect(migrated.accounts[DEFAULT_ACCOUNT_ID]?.threads).toBeNull();
  });

  it("keeps every account of an already-current file and drops broken entries", () => {
    const migrated = migrateSecrets({
      version: 3,
      accounts: {
        acc_a: { instagram: { encrypted: "ENC_A", expiresAt: null }, threads: null },
        acc_b: { instagram: null, threads: { encrypted: "ENC_B", expiresAt: null } },
        acc_broken: { instagram: { expiresAt: null }, threads: null },
      },
      aiApiKey: "ENC_AI",
    });
    expect(Object.keys(migrated.accounts).sort()).toEqual(["acc_a", "acc_b"]);
    expect(migrated.accounts.acc_a?.instagram?.encrypted).toBe("ENC_A");
    expect(migrated.accounts.acc_b?.threads?.encrypted).toBe("ENC_B");
    expect(migrated.aiApiKey).toBe("ENC_AI");
  });

  it("returns an empty store for garbage input", () => {
    expect(migrateSecrets(null)).toEqual(emptySecrets());
    expect(migrateSecrets("nope")).toEqual(emptySecrets());
    expect(migrateSecrets({ version: 2, connections: {} }).accounts).toEqual({});
  });
});
