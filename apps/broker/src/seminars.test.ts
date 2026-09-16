import { describe, expect, it } from "vitest";
import { newApplication, parseApplicationInput, parseSeminarInput } from "./seminars.js";
import type { StoredSeminar } from "./store.js";

function validSeminarBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "秋の集客セミナー",
    description: "オンライン開催です。",
    dates: [{ startsAt: "2024-10-01T10:00:00.000Z", capacity: 2 }],
    liffId: null,
    thanksMessage: "お申し込みありがとうございます。",
    reminders: [],
    ...overrides,
  };
}

describe("parseSeminarInput", () => {
  it("accepts a well-formed submission", () => {
    const result = parseSeminarInput(validSeminarBody());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("秋の集客セミナー");
      expect(result.value.dates).toHaveLength(1);
      expect(result.value.dates[0]?.capacity).toBe(2);
      expect(result.value.enabled).toBe(true);
    }
  });

  it("requires a non-empty title", () => {
    expect(parseSeminarInput(validSeminarBody({ title: "" })).ok).toBe(false);
    expect(parseSeminarInput(validSeminarBody({ title: "a".repeat(201) })).ok).toBe(false);
  });

  it("requires at least one date and caps the count at 30", () => {
    expect(parseSeminarInput(validSeminarBody({ dates: [] })).ok).toBe(false);
    const tooMany = Array.from({ length: 31 }, () => ({ startsAt: "2024-10-01T10:00:00.000Z" }));
    expect(parseSeminarInput(validSeminarBody({ dates: tooMany })).ok).toBe(false);
  });

  it("rejects an unparseable date or an invalid capacity", () => {
    expect(parseSeminarInput(validSeminarBody({ dates: [{ startsAt: "not a date" }] })).ok).toBe(false);
    expect(parseSeminarInput(validSeminarBody({ dates: [{ startsAt: "2024-10-01T10:00:00.000Z", capacity: 0 }] })).ok).toBe(false);
    expect(parseSeminarInput(validSeminarBody({ dates: [{ startsAt: "2024-10-01T10:00:00.000Z", capacity: 1.5 }] })).ok).toBe(false);
  });

  it("rejects reminders with no positive lead time or empty text", () => {
    expect(parseSeminarInput(validSeminarBody({ reminders: [{ hoursBefore: 0, text: "hi" }] })).ok).toBe(false);
    expect(parseSeminarInput(validSeminarBody({ reminders: [{ hoursBefore: 24, text: "" }] })).ok).toBe(false);
  });

  it("treats enabled as true unless explicitly false", () => {
    expect(parseSeminarInput(validSeminarBody()).ok && parseSeminarInput(validSeminarBody()).ok).toBe(true);
    const disabled = parseSeminarInput(validSeminarBody({ enabled: false }));
    expect(disabled.ok && disabled.value.enabled).toBe(false);
  });
});

function seminarFixture(overrides: Partial<StoredSeminar> = {}): StoredSeminar {
  return {
    id: "sem_1",
    ownerId: "owner",
    ownerKeys: ["owner"],
    title: "秋の集客セミナー",
    description: "",
    dates: [{ id: "date_1", startsAt: "2024-10-01T10:00:00.000Z", capacity: 1 }],
    liffId: null,
    thanksMessage: "",
    reminders: [],
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    applications: [],
    ...overrides,
  };
}

describe("parseApplicationInput", () => {
  it("accepts a valid application", () => {
    const seminar = seminarFixture();
    const result = parseApplicationInput({ dateId: "date_1", name: "山田太郎", email: "taro@example.com" }, seminar);
    expect(result).toEqual({ ok: true, value: { dateId: "date_1", name: "山田太郎", email: "taro@example.com", lineUserId: null } });
  });

  it("rejects an unknown date id", () => {
    const seminar = seminarFixture();
    expect(parseApplicationInput({ dateId: "missing", name: "山田太郎" }, seminar).ok).toBe(false);
  });

  it("requires a name", () => {
    const seminar = seminarFixture();
    expect(parseApplicationInput({ dateId: "date_1", name: "" }, seminar).ok).toBe(false);
  });

  it("rejects a malformed email", () => {
    const seminar = seminarFixture();
    expect(parseApplicationInput({ dateId: "date_1", name: "山田太郎", email: "not-an-email" }, seminar).ok).toBe(false);
  });

  it("rejects applications once the date's capacity is full", () => {
    const seminar = seminarFixture({
      applications: [{ id: "app_1", dateId: "date_1", name: "先着さん", email: null, lineUserId: null, createdAt: "2024-01-01T00:00:00.000Z" }],
    });
    const result = parseApplicationInput({ dateId: "date_1", name: "次の人" }, seminar);
    expect(result).toEqual({ ok: false, error: "あいにく、この日程は満席になりました。" });
  });

  it("allows unlimited applications when capacity is null", () => {
    const seminar = seminarFixture({
      dates: [{ id: "date_1", startsAt: "2024-10-01T10:00:00.000Z", capacity: null }],
      applications: [{ id: "app_1", dateId: "date_1", name: "先着さん", email: null, lineUserId: null, createdAt: "2024-01-01T00:00:00.000Z" }],
    });
    expect(parseApplicationInput({ dateId: "date_1", name: "次の人" }, seminar).ok).toBe(true);
  });
});

describe("newApplication", () => {
  it("stamps an id and the creation time", () => {
    const application = newApplication({ dateId: "date_1", name: "山田太郎", email: null, lineUserId: null }, 1_700_000_000_000);
    expect(application.id).toMatch(/^app_/);
    expect(application.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(application.name).toBe("山田太郎");
  });
});
