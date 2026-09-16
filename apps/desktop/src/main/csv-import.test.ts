import { describe, expect, it } from "vitest";
import { decodeCsvBytes, parseCsv, parseDateTimeCell, parseImportRows, parseRecurrenceSpec } from "./csv-import.js";
import type { Recurrence } from "./types.js";

const HEADER = "投稿日時,種別,キャプション,メディアパス,繰り返し,アカウント";

/** Local-time ISO string so expectations do not depend on the machine's timezone. */
const local = (year: number, month: number, day: number, time = "00:00") => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString();
};

describe("decodeCsvBytes", () => {
  it("strips a UTF-8 BOM", () => {
    const bytes = new TextEncoder().encode("﻿投稿日時,種別");
    expect(decodeCsvBytes(bytes)).toBe("投稿日時,種別");
  });

  it("decodes plain UTF-8 without a BOM", () => {
    expect(decodeCsvBytes(new TextEncoder().encode("キャプション"))).toBe("キャプション");
  });

  it("falls back to Shift_JIS when the bytes are not valid UTF-8", () => {
    // 「テスト」in Shift_JIS
    expect(decodeCsvBytes(new Uint8Array([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]))).toBe("テスト");
  });
});

describe("parseCsv", () => {
  it("handles quotes, embedded commas and newlines, escaped quotes, LF and CRLF", () => {
    const rows = parseCsv('a,"b,c","1行目\n2行目","say ""hi"""\r\nnext,"x,\ty"',);
    expect(rows).toEqual([
      ["a", "b,c", "1行目\n2行目", 'say "hi"'],
      ["next", "x,\ty"],
    ]);
  });

  it("drops empty rows from a trailing CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\n\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("parseDateTimeCell", () => {
  it("reads local wall-clock datetimes in common notations", () => {
    expect(parseDateTimeCell("2026-04-01 10:30")).toBe(local(2026, 4, 1, "10:30"));
    expect(parseDateTimeCell("2026/04/01 9:05")).toBe(local(2026, 4, 1, "09:05"));
    expect(parseDateTimeCell("2026-04-01 10:30:00")).toBe(local(2026, 4, 1, "10:30"));
    expect(parseDateTimeCell("2026-04-01")).toBe(local(2026, 4, 1));
    expect(parseDateTimeCell("2026-04-01T01:00:00.000Z")).toBe("2026-04-01T01:00:00.000Z");
  });

  it("rejects impossible or empty values instead of rolling them over", () => {
    expect(parseDateTimeCell("2026-13-01 10:00")).toBeNull();
    expect(parseDateTimeCell("2026-02-30 10:00")).toBeNull();
    expect(parseDateTimeCell("2026-04-01 25:00")).toBeNull();
    expect(parseDateTimeCell("")).toBeNull();
    expect(parseDateTimeCell("できない")).toBeNull();
  });
});

describe("parseRecurrenceSpec", () => {
  const spec = (input: string) => parseRecurrenceSpec(input).recurrence as Recurrence | null;

  it("treats an empty cell as no repetition", () => {
    expect(parseRecurrenceSpec("")).toEqual({ recurrence: null, error: null });
    expect(parseRecurrenceSpec("  ")).toEqual({ recurrence: null, error: null });
  });

  it("reads daily notation", () => {
    expect(spec("毎日 09:30")).toEqual({ freq: "daily", interval: 1, time: "09:30", endAt: null });
    expect(spec("3日ごと 08:00")).toEqual({ freq: "daily", interval: 3, time: "08:00", endAt: null });
  });

  it("reads weekly notation with separators", () => {
    expect(spec("毎週(月,木) 20:00")).toEqual({ freq: "weekly", interval: 1, weekdays: [1, 4], time: "20:00", endAt: null });
    expect(spec("毎週(月・金) 07:00")).toEqual({ freq: "weekly", interval: 1, weekdays: [1, 5], time: "07:00", endAt: null });
    expect(spec("2週ごと(月) 10:00")).toEqual({ freq: "weekly", interval: 2, weekdays: [1], time: "10:00", endAt: null });
    const plain = spec("毎週 20:00");
    expect(plain).toMatchObject({ freq: "weekly", interval: 1 });
    expect(plain && "weekdays" in plain && plain.weekdays).toBeUndefined();
  });

  it("reads monthly notation", () => {
    expect(spec("毎月15 10:00")).toEqual({ freq: "monthly", interval: 1, monthDay: 15, time: "10:00", endAt: null });
    expect(spec("毎月15日 23:59")).toEqual({ freq: "monthly", interval: 1, monthDay: 15, time: "23:59", endAt: null });
    expect(spec("2ヶ月ごと(15日) 10:00")).toEqual({ freq: "monthly", interval: 2, monthDay: 15, time: "10:00", endAt: null });
  });

  it("reads an inclusive end date in both notations", () => {
    expect(spec("毎日 09:00 まで 2026-12-31")!.endAt).toBe("2026-12-31");
    expect(spec("毎日 09:00 〜2026/12/31")!.endAt).toBe("2026-12-31");
    expect(spec("毎日 09:00 まで2026-12-31")).toEqual({ freq: "daily", interval: 1, time: "09:00", endAt: "2026-12-31" });
  });

  it("reports problems for broken notation", () => {
    expect(parseRecurrenceSpec("毎日").error).toBeTruthy();
    expect(parseRecurrenceSpec("たまに 10:00").error).toBeTruthy();
    expect(parseRecurrenceSpec("毎月40日 10:00").error).toBeTruthy();
    expect(parseRecurrenceSpec("毎週(無) 10:00").error).toBeTruthy();
  });
});

describe("parseImportRows", () => {
  it("parses a full Japanese file with relative media paths resolved against baseDir", () => {
    const text = [
      HEADER,
      "2026-04-01 10:00,フィード画像,新商品のご案内,photos/item1.jpg,毎日 09:30,myshop",
      "2026-04-03 20:00,カルーセル,\"使い方を2枚でご紹介。\",/tmp/a.jpg;/tmp/b.jpg,\"毎週(火,金) 20:00\",",
      "2026-04-05 21:00,ストーリーズ,本日のおすすめ,/tmp/story.jpg,,",
      "2026-04-06 12:00,Threads,今日のひとこと。,,,",
    ].join("\n");
    const { rows, problems } = parseImportRows(text, "/csv/dir");
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(4);
    expect(rows[0]!).toMatchObject({ line: 2, kind: "image", scheduledAt: local(2026, 4, 1, "10:00"), caption: "新商品のご案内", mediaPaths: ["/csv/dir/photos/item1.jpg"], accountId: "myshop" });
    expect(rows[0]!.recurrence).toMatchObject({ freq: "daily", time: "09:30" });
    expect(rows[1]!).toMatchObject({ kind: "carousel", mediaPaths: ["/tmp/a.jpg", "/tmp/b.jpg"], accountId: null });
    expect(rows[1]!.recurrence).toMatchObject({ freq: "weekly", weekdays: [2, 5] });
    expect(rows[2]!.kind).toBe("story");
    expect(rows[3]!).toMatchObject({ kind: "threads", mediaPaths: [], caption: "今日のひとこと。" });
  });

  it("accepts English header aliases and keeps 種別 empty as feed image", () => {
    const text = "scheduledAt,kind,caption,mediaPath,recurrence,accountId\n2026-04-01 10:00,,hello,/tmp/a.jpg,,";
    const { rows, problems } = parseImportRows(text);
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({ kind: "image", caption: "hello", mediaPaths: ["/tmp/a.jpg"] });
  });

  it("collects row problems with the right line numbers even across quoted newlines", () => {
    const text = [
      HEADER,
      '2026-04-01 10:00,画像,"キャプション\n2行目もあり",/tmp/a.jpg,,',
      "2026-13-01 10:00,画像,日時が不正,/tmp/a.jpg,,",
      "2026-04-02 11:00,Live配信,種別が不正,/tmp/a.jpg,,",
      "2026-04-03 11:00,画像,繰り返しが不正,/tmp/a.jpg,毎週(無) 10:00,",
      "2026-04-04 11:00,画像,メディアが空,,",
    ].join("\n");
    const { rows, problems } = parseImportRows(text);
    expect(rows).toHaveLength(1);
    expect(problems.map((problem) => problem.line)).toEqual([4, 5, 6, 7]);
    expect(problems[0]!.message).toContain("投稿日時");
    expect(problems[1]!.message).toContain("種別");
    expect(problems[2]!.message).toContain("繰り返し");
    expect(problems[3]!.message).toContain("メディア");
  });

  it("reports a missing or wrong header", () => {
    expect(parseImportRows("").problems[0]!.message).toContain("データがありません");
    const noHeader = parseImportRows("2026-04-01 10:00,画像,x,/tmp/a.jpg,,");
    expect(noHeader.rows).toHaveLength(0);
    expect(noHeader.problems[0]!.message).toContain("投稿日時");
  });
});
