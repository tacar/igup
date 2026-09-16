import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrokerClient } from "./broker-client.js";
import { DataStore } from "./data-store.js";
import { AutomationEngine } from "./engine.js";
import { InstagramApiError, type InstagramClient } from "./instagram-client.js";
import type { ConnectionStorage } from "./storage.js";
import { DEFAULT_ACCOUNT_ID, emptyStats, type AccountInfo, type Connection, type Rule } from "./types.js";

const directories: string[] = [];

function account(id: string, username: string): AccountInfo {
  return { id, username, graphId: null, threadsUsername: null, addedAt: "2026-01-01T00:00:00.000Z" };
}

function ruleFixture(id: string, accountId: string, keyword: string): Rule {
  return {
    id,
    accountId,
    name: id,
    enabled: true,
    sources: ["comment"],
    keywords: [keyword],
    matchMode: "contains",
    mediaIds: [],
    publicReplies: ["どうぞ！"],
    message: null,
    followUps: [],
    cooldownHours: 0,
    stats: emptyStats(),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "igup-engine-"));
  directories.push(dir);
  const data = DataStore.inDirectory(dir);
  data.update((store) => {
    store.accounts = [account("acc_a", "a"), account("acc_b", "b")];
    store.activeAccountId = "acc_a";
    store.settings.automationEnabled = true;
    store.settings.pollingMode = "always";
    store.rules.push(ruleFixture("rule_a", "acc_a", "価格"));
    store.rules.push(ruleFixture("rule_b", "acc_b", "資料請求"));
  });

  const sent: { to: string; text: string }[] = [];
  const secrets = {
    load: async (provider: string, accountId = DEFAULT_ACCOUNT_ID) => {
      if (provider !== "instagram") return null;
      if (accountId === "acc_a") return { accessToken: "tok_a", expiresAt: null } satisfies Connection;
      if (accountId === "acc_b") return { accessToken: "tok_b", expiresAt: null } satisfies Connection;
      return null;
    },
    save: async () => undefined,
  } as unknown as ConnectionStorage;

  const instagram = {
    async getAccount(connection: Connection) {
      return connection.accessToken === "tok_a" ? { id: "ig_a", user_id: "uga" } : { id: "ig_b", user_id: "ugb" };
    },
    async listMediaWithComments(connection: Connection) {
      if (connection.accessToken === "tok_b") throw new InstagramApiError("呼び出し上限に達しました", 4, null, 400);
      return {
        data: [{
          id: "media_a1",
          comments: {
            data: [{ id: "cmt_a1", text: "価格", from: { id: "user_1", username: "u1" }, parent_id: "", timestamp: new Date().toISOString() }],
          },
        }],
      };
    },
    async listConversations() {
      return { data: [] };
    },
    async replyToComment(_connection: Connection, _commentId: string, text: string) {
      sent.push({ to: "comment", text });
      return { id: "reply_1" };
    },
    async sendPrivateReply() {
      return { recipient_id: "user_1" };
    },
    async sendMessage(_connection: Connection, to: string, message: { text: string }) {
      sent.push({ to, text: message.text });
    },
  } as unknown as InstagramClient;

  const broker = {
    async events(connection: Connection, cursor: number) {
      const latest = connection.accessToken === "tok_a" ? 101 : 202;
      if (cursor >= latest) return { events: [] };
      return {
        events: [{
          id: latest,
          at: "2026-01-01T00:00:00.000Z",
          type: "webhook",
          payload: {
            entry: [{
              changes: [{
                field: "comments",
                value: { id: `cmt_w_${latest}`, text: "価格", from: { id: "user_2", username: "u2" }, media: { id: "media_a1" } },
              }],
            }],
          },
        }],
      };
    },
    async capabilities() {
      return { webhooks: false, threads: false, media: false, links: false, seminars: false, publicBaseUrl: "" };
    },
  } as unknown as BrokerClient;

  const engine = new AutomationEngine({ data, secrets, instagram, broker });
  return { data, engine, sent };
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AutomationEngine with multiple accounts", () => {
  it("polls every connected account and keeps one account's rate limit from stopping the other", async () => {
    const { data, engine } = setup();
    await engine.pollInstagram(true);

    const ruleA = data.get().rules.find((rule) => rule.id === "rule_a")!;
    expect(ruleA.stats.matched).toBe(1);
    expect(ruleA.stats.publicReplied).toBe(1);

    const status = engine.status();
    const statusB = status.accounts.find((entry) => entry.accountId === "acc_b");
    expect(statusB?.backoffUntil).toBeTruthy();
    expect(status.lastError).toBe("呼び出し上限に達しました");
    const statusA = status.accounts.find((entry) => entry.accountId === "acc_a");
    expect(statusA?.backoffUntil).toBeFalsy();
  });

  it("keeps broker event cursors and rule matching separate per account", async () => {
    const { data, engine } = setup();
    await engine.drainBroker();

    expect(data.get().cursors.acc_a).toBe(101);
    expect(data.get().cursors.acc_b).toBe(202);

    // account A's webhook comment matched its rule; the same text arriving on B did not
    const ruleA = data.get().rules.find((rule) => rule.id === "rule_a")!;
    const ruleB = data.get().rules.find((rule) => rule.id === "rule_b")!;
    expect(ruleA.stats.matched).toBe(1);
    expect(ruleB.stats.matched).toBe(0);
  });

  it("does not process the same comment twice (seen ids are account-scoped)", async () => {
    const { data, engine } = setup();
    await engine.pollInstagram(true);
    await engine.pollInstagram(true);
    const ruleA = data.get().rules.find((rule) => rule.id === "rule_a")!;
    expect(ruleA.stats.matched).toBe(1);
    expect(data.get().seen.comments).toEqual(["acc_a:cmt_a1"]);
  });
});
