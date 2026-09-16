import { describe, expect, it } from "vitest";
import {
  cooldownKey,
  decodeChainPayload,
  encodeChainPayload,
  findMatchingRules,
  findQuickReplyByTitle,
  isCoolingDown,
  keywordMatches,
  normalizeText,
  pickReply,
  validateRule,
  withinMessagingWindow,
} from "./rules.js";
import { emptyMessage, emptyStats, type Rule } from "./types.js";

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "rule_1",
    name: "価格案内",
    enabled: true,
    sources: ["dm"],
    keywords: ["価格"],
    matchMode: "contains",
    mediaIds: [],
    publicReplies: [],
    message: null,
    followUps: [],
    cooldownHours: 0,
    stats: emptyStats(),
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeText", () => {
  it("folds full-width characters, lowercases, and collapses whitespace", () => {
    expect(normalizeText("　ＰＲＩＣＥ　　list ")).toBe("price list");
  });
});

describe("keywordMatches", () => {
  it("matches substrings in contains mode", () => {
    expect(keywordMatches({ keywords: ["価格"], matchMode: "contains" }, "価格を教えてください")).toBe(true);
    expect(keywordMatches({ keywords: ["価格"], matchMode: "contains" }, "こんにちは")).toBe(false);
  });

  it("requires a full match in exact mode", () => {
    expect(keywordMatches({ keywords: ["価格"], matchMode: "exact" }, "価格")).toBe(true);
    expect(keywordMatches({ keywords: ["価格"], matchMode: "exact" }, "価格を教えてください")).toBe(false);
  });

  it("ignores blank keywords and blank text", () => {
    expect(keywordMatches({ keywords: ["", "  "], matchMode: "contains" }, "何か")).toBe(false);
    expect(keywordMatches({ keywords: ["価格"], matchMode: "contains" }, "")).toBe(false);
  });
});

describe("findMatchingRules", () => {
  it("excludes disabled rules and rules for other sources", () => {
    const rules = [rule({ id: "a", enabled: false }), rule({ id: "b", sources: ["comment"] })];
    expect(findMatchingRules(rules, { source: "dm", text: "価格" })).toEqual([]);
  });

  it("requires a media id match for comment/live rules scoped to specific posts", () => {
    const scoped = rule({ id: "scoped", sources: ["comment"], mediaIds: ["media_1"] });
    expect(findMatchingRules([scoped], { source: "comment", text: "価格", mediaId: "media_2" })).toEqual([]);
    expect(findMatchingRules([scoped], { source: "comment", text: "価格", mediaId: "media_1" })).toEqual([scoped]);
  });

  it("does not scope dm/story rules by media id", () => {
    const dmRule = rule({ id: "dm", sources: ["dm"], mediaIds: ["media_1"] });
    expect(findMatchingRules([dmRule], { source: "dm", text: "価格" })).toEqual([dmRule]);
  });
});

describe("pickReply", () => {
  it("returns null when there are no usable patterns", () => {
    expect(pickReply([])).toBeNull();
    expect(pickReply(["  ", ""])).toBeNull();
  });

  it("filters blanks and picks deterministically from the injected random source", () => {
    const patterns = ["A", "", "B", "C"];
    expect(pickReply(patterns, () => 0)).toBe("A");
    expect(pickReply(patterns, () => 0.99)).toBe("C");
  });
});

describe("cooldownKey / isCoolingDown", () => {
  it("builds a stable composite key", () => {
    expect(cooldownKey("rule_1", "user_9")).toBe("rule_1:user_9");
  });

  it("treats non-positive cooldown hours as never cooling down", () => {
    expect(isCoolingDown({ k: new Date(0).toISOString() }, "k", 0, 1_000)).toBe(false);
  });

  it("is cooling down within the window and clear after it", () => {
    const cooldowns = { k: new Date(0).toISOString() };
    expect(isCoolingDown(cooldowns, "k", 1, 30 * 60_000)).toBe(true);
    expect(isCoolingDown(cooldowns, "k", 1, 2 * 3_600_000)).toBe(false);
  });

  it("is not cooling down when there is no prior record", () => {
    expect(isCoolingDown({}, "missing", 24, 1_000)).toBe(false);
  });
});

describe("withinMessagingWindow", () => {
  it("is false with no prior inbound message", () => {
    expect(withinMessagingWindow(null)).toBe(false);
    expect(withinMessagingWindow(undefined)).toBe(false);
  });

  it("is true inside the window and false once it elapses", () => {
    const lastInboundAt = new Date(0).toISOString();
    expect(withinMessagingWindow(lastInboundAt, 23 * 3_600_000)).toBe(true);
    expect(withinMessagingWindow(lastInboundAt, 25 * 3_600_000)).toBe(false);
  });
});

describe("encodeChainPayload / decodeChainPayload", () => {
  it("round-trips a chain payload", () => {
    const payload = encodeChainPayload("origin_1", "target_2");
    expect(decodeChainPayload(payload)).toEqual({ originRuleId: "origin_1", targetRuleId: "target_2" });
  });

  it("rejects malformed or foreign payloads", () => {
    expect(decodeChainPayload(null)).toBeNull();
    expect(decodeChainPayload("")).toBeNull();
    expect(decodeChainPayload("other:a:b")).toBeNull();
    expect(decodeChainPayload("igup:only-one-part")).toBeNull();
    expect(decodeChainPayload("igup::b")).toBeNull();
  });
});

describe("findQuickReplyByTitle", () => {
  it("finds the chain payload behind a tapped quick reply's title", () => {
    const message = { ...emptyMessage(), quickReplies: [{ title: "はい、お願いします", payload: encodeChainPayload("rule_a", "rule_b") }] };
    const rules = [rule({ id: "rule_a", message })];
    expect(findQuickReplyByTitle(rules, "  はい、お願いします ")).toEqual({ originRuleId: "rule_a", targetRuleId: "rule_b" });
  });

  it("also looks inside follow-up messages", () => {
    const followUpMessage = { ...emptyMessage(), quickReplies: [{ title: "もっと詳しく", payload: encodeChainPayload("rule_a", "rule_c") }] };
    const rules = [rule({ id: "rule_a", followUps: [{ id: "f1", delayMinutes: 5, message: followUpMessage }] })];
    expect(findQuickReplyByTitle(rules, "もっと詳しく")).toEqual({ originRuleId: "rule_a", targetRuleId: "rule_c" });
  });

  it("ignores disabled rules and returns null with no match", () => {
    const message = { ...emptyMessage(), quickReplies: [{ title: "はい", payload: encodeChainPayload("rule_a", "rule_b") }] };
    const rules = [rule({ id: "rule_a", enabled: false, message })];
    expect(findQuickReplyByTitle(rules, "はい")).toBeNull();
    expect(findQuickReplyByTitle([rule()], "存在しない")).toBeNull();
  });
});

describe("validateRule", () => {
  it("accepts a well-formed rule", () => {
    expect(validateRule(rule())).toEqual([]);
  });

  it("flags a missing name, no sources, and no keywords", () => {
    const problems = validateRule(rule({ name: "  ", sources: [], keywords: ["  "] }));
    expect(problems).toContain("ルール名を入力してください。");
    expect(problems).toContain("反応する入口（コメント / DM / ストーリーズ返信 / ライブ）を1つ以上選んでください。");
    expect(problems).toContain("キーワードを1つ以上入力してください。");
  });

  it("caps public replies at 3", () => {
    expect(validateRule(rule({ publicReplies: ["a", "b", "c", "d"] }))).toContain("公開返信は3パターンまでです。");
  });

  it("validates message buttons, quick replies and text length", () => {
    const message = {
      ...emptyMessage(),
      text: "a".repeat(1_001),
      buttons: [
        { type: "web_url" as const, title: "", url: "not-a-url" },
        { type: "postback" as const, title: "b2", payload: "p" },
        { type: "postback" as const, title: "b3", payload: "p" },
        { type: "postback" as const, title: "b4", payload: "p" },
      ],
      quickReplies: Array.from({ length: 14 }, (_, i) => ({ title: `q${i}`, payload: "p" })),
    };
    const problems = validateRule(rule({ message }));
    expect(problems).toContain("ボタンは3つまでです。");
    expect(problems).toContain("ボタンのタイトルを入力してください。");
    expect(problems.some((p) => p.includes("URLを確認してください"))).toBe(true);
    expect(problems).toContain("クイックリプライは13個までです。");
    expect(problems).toContain("DM本文は1,000文字以内にしてください。");
  });

  it("rejects a negative cooldown and out-of-range follow-up delays", () => {
    const problems = validateRule(
      rule({ cooldownHours: -1, followUps: [{ id: "f1", delayMinutes: 0, message: emptyMessage() }, { id: "f2", delayMinutes: 24 * 60, message: emptyMessage() }] }),
    );
    expect(problems).toContain("クールダウンは0時間以上にしてください。");
    expect(problems).toContain("時間差送信は1分以上後に設定してください。");
    expect(problems).toContain("時間差送信は23時間以内に設定してください（Instagramの24時間ルール）。");
  });
});
