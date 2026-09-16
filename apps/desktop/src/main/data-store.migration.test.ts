import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DataStore, migrateV1toV2, normalize } from "./data-store.js";
import { DEFAULT_ACCOUNT_ID } from "./types.js";

const directories: string[] = [];

function tempDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "igup-migration-"));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migrateV1toV2", () => {
  const v1 = {
    version: 1,
    settings: { pollIntervalSec: 120 },
    rules: [{ id: "rule_1", name: "価格案内" }],
    posts: [{ id: "post_1", kind: "image", scheduledAt: "2024-06-01T10:00:00.000Z", status: "scheduled", caption: "", media: [], cover: null, shareToFeed: true, threads: [], attachRuleId: null, publishedId: null, permalink: null, publishedAt: null, error: null, attempts: 0, createdAt: "", updatedAt: "" }],
    seen: { comments: ["c1"], messages: [], brokerCursor: 42 },
    cooldowns: { user_1: "2024-05-01T00:00:00.000Z" },
    contacts: { user_1: { username: "u1", lastInboundAt: null, lastOutboundAt: null, lastOutboundRuleId: null, lastReadAt: null, readCounted: false } },
    lastInsightsDate: "2024-05-31",
    lastStorySnapshotAt: "2024-05-31T03:00:00.000Z",
  };

  it("moves all single-account data onto the default account", () => {
    const data = migrateV1toV2(v1);
    expect(data.version).toBe(2);
    expect(data.accounts.map((account) => account.id)).toEqual([DEFAULT_ACCOUNT_ID]);
    expect(data.activeAccountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(data.cursors[DEFAULT_ACCOUNT_ID]).toBe(42);
    expect(data.rules[0]?.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(data.posts[0]?.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(data.cooldowns[`${DEFAULT_ACCOUNT_ID}:user_1`]).toBe("2024-05-01T00:00:00.000Z");
    expect(data.contacts[`${DEFAULT_ACCOUNT_ID}:user_1`]?.username).toBe("u1");
    expect(data.lastInsightsDate[DEFAULT_ACCOUNT_ID]).toBe("2024-05-31");
    expect(data.lastStorySnapshotAt[DEFAULT_ACCOUNT_ID]).toBe("2024-05-31T03:00:00.000Z");
    expect(data.seen).toEqual({ comments: ["c1"], messages: [] });
    expect(data.settings.pollIntervalSec).toBe(120);
  });

  it("is tolerant of already-migrated v2 input (no double prefixing)", () => {
    const migrated = migrateV1toV2(v1);
    const again = migrateV1toV2(JSON.parse(JSON.stringify(migrated)));
    expect(again.cooldowns[`${DEFAULT_ACCOUNT_ID}:user_1`]).toBeDefined();
    expect(again.cooldowns[`${DEFAULT_ACCOUNT_ID}:${DEFAULT_ACCOUNT_ID}:user_1`]).toBeUndefined();
    expect(again.cursors[DEFAULT_ACCOUNT_ID]).toBe(42);
  });

  it("keeps explicit v2 accounts untouched", () => {
    const v2 = normalize({
      version: 2,
      accounts: [
        { id: "acc_a", username: "a", graphId: "1", threadsUsername: null, addedAt: "" },
        { id: "acc_b", username: "b", graphId: "2", threadsUsername: null, addedAt: "" },
      ],
      activeAccountId: "acc_b",
      cursors: { acc_a: 5 },
    });
    expect(v2.accounts.map((account) => account.id)).toEqual(["acc_a", "acc_b"]);
    expect(v2.activeAccountId).toBe("acc_b");
    expect(v2.cursors.acc_a).toBe(5);
  });
});

describe("DataStore.load migration", () => {
  it("backs up the v1 file once and loads it as v2", async () => {
    const dir = tempDirectory();
    writeFileSync(join(dir, "igup-data.json"), JSON.stringify({ version: 1, seen: { comments: [], messages: [], brokerCursor: 7 } }), "utf8");
    const store = DataStore.inDirectory(dir);
    await store.load();
    expect(existsSync(join(dir, "igup-data.v1.bak.json"))).toBe(true);
    expect(store.get().version).toBe(2);
    expect(store.get().cursors[DEFAULT_ACCOUNT_ID]).toBe(7);
    expect(store.get().accounts[0]?.id).toBe(DEFAULT_ACCOUNT_ID);
    await store.flush();
  });

  it("does not touch a current v2 file", async () => {
    const dir = tempDirectory();
    writeFileSync(join(dir, "igup-data.json"), JSON.stringify(normalize({ version: 2 })), "utf8");
    const store = DataStore.inDirectory(dir);
    await store.load();
    expect(existsSync(join(dir, "igup-data.v1.bak.json"))).toBe(false);
    expect(store.get().version).toBe(2);
  });

  it("starts empty when no file exists", async () => {
    const store = DataStore.inDirectory(join(tempDirectory(), "igup-data.json"));
    await store.load();
    expect(store.get().version).toBe(2);
    expect(store.get().accounts).toEqual([]);
  });
});
