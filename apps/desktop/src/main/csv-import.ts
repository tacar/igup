import { isAbsolute, resolve } from "node:path";
import type { PostKind, Recurrence } from "./types.js";

/**
 * Bulk import of scheduled posts from a CSV file.
 * Everything here is pure so it can be tested without Electron; services.ts wraps
 * it with file reading, media import and post saving.
 *
 * Header row (Japanese with English aliases):
 *   投稿日時, 種別, キャプション, メディアパス, 繰り返し, アカウント
 * Encoding: UTF-8 (BOM recommended for Excel), Shift_JIS as fallback.
 */

export type CsvProblem = { line: number; message: string };

export type CsvImportRow = {
  line: number;
  kind: PostKind;
  scheduledAt: string;
  caption: string;
  mediaPaths: string[];
  recurrence: Recurrence | null;
  accountId: string | null;
};

// ---------------------------------------------------------------- decoding

/** Decodes CSV bytes: UTF-8 BOM → UTF-8 → Shift_JIS. Throws a Japanese error when hopeless. */
export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && (bytes[0] ?? 0) === 0xef && (bytes[1] ?? 0) === 0xbb && (bytes[2] ?? 0) === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("shift_jis").decode(bytes);
    } catch {
      throw new Error("CSVの文字コードを読み取れませんでした。UTF-8（BOM付き推奨）で保存してください。");
    }
  }
}

// ---------------------------------------------------------------- RFC 4180 CSV

/** Hand-rolled CSV parser: quoted fields, embedded commas / newlines, "" escapes, LF and CRLF. */
export function parseCsv(text: string): string[][] {
  return parseCsvWithLines(text).cells;
}

function parseCsvWithLines(text: string): { cells: string[][]; lines: number[] } {
  const cells: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let lineNumber = 1;
  let rowStart = 1;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => {
    endField();
    // skip rows that are completely empty (e.g. trailing CRLF)
    if (!(row.length === 1 && row[0] === "")) {
      cells.push(row);
      lines.push(rowStart);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "\n") lineNumber += 1;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"' && field.length === 0) { inQuotes = true; rowStart ||= lineNumber; continue; }
    if (ch === ",") { endField(); rowStart ||= lineNumber; continue; }
    if (ch === "\r") {
      // CRLF counts as a single line break; the \n is consumed above so bump the counter here
      if (text[i + 1] === "\n") i += 1;
      endRow();
      lineNumber += 1;
      rowStart = lineNumber;
      continue;
    }
    if (ch === "\n") { endRow(); rowStart = lineNumber; continue; }
    if (field.length === 0 && row.length === 0) rowStart ||= lineNumber;
    field += ch;
  }
  if (field.length > 0 || row.length > 0) endRow();
  return { cells, lines };
}

// ---------------------------------------------------------------- cell parsers

const HEADER_ALIASES: Record<string, string> = {
  "投稿日時": "scheduledAt", "日時": "scheduledAt", "予約日時": "scheduledAt", scheduledat: "scheduledAt",
  "種別": "kind", "種類": "kind", kind: "kind",
  "キャプション": "caption", "本文": "caption", caption: "caption",
  "メディアパス": "mediaPaths", "メディア": "mediaPaths", "画像パス": "mediaPaths", mediapath: "mediaPaths", mediapaths: "mediaPaths", media: "mediaPaths",
  "繰り返し": "recurrence", "繰り返し投稿": "recurrence", recurrence: "recurrence",
  "アカウント": "account", account: "account", accountid: "account",
};

const KIND_ALIASES: Record<string, PostKind> = {
  "フィード画像": "image", "画像": "image", "フィード": "image", image: "image",
  "カルーセル": "carousel", carousel: "carousel",
  "リール": "reel", "動画": "reel", reel: "reel", video: "reel",
  "ストーリーズ": "story", "ストーリー": "story", story: "story", stories: "story",
  "スレッズ": "threads", "スレッド": "threads", threads: "threads", thread: "threads",
};

const DATETIME_PATTERN = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/** "YYYY-MM-DD HH:mm" / "YYYY/MM/DD HH:mm" / ISO → ISO string (local wall clock), else null. */
export function parseDateTimeCell(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const match = DATETIME_PATTERN.exec(value);
  if (match) {
    const [, year, month, day, hours, minutes, seconds] = match;
    const y = Number(year), mo = Number(month), d = Number(day);
    const hr = Number(hours ?? 0), min = Number(minutes ?? 0), sec = Number(seconds ?? 0);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || hr > 23 || min > 59 || sec > 59) return null;
    const date = new Date(y, mo - 1, d, hr, min, sec);
    // reject rollovers (e.g. 2月30日 → 3月2日)
    if (Number.isNaN(date.getTime()) || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return date.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const WEEKDAY_CHARS: Record<string, number> = { "日": 0, "月": 1, "火": 2, "水": 3, "木": 4, "金": 5, "土": 6 };

/**
 * Repeat notation: 「毎日 09:30」/「2日ごと 08:00」/「毎週(月,木) 20:00」/「2週ごと(月) 10:00」/
 * 「毎月15 10:00」/「毎月15日 10:00」/「2ヶ月ごと(15日) 10:00」, each optionally followed by
 * 「〜YYYY-MM-DD」「まで YYYY/MM/DD」. Empty input means "no repetition".
 */
export function parseRecurrenceSpec(input: string): { recurrence: Recurrence | null; error: string | null } {
  let text = input.trim();
  if (!text) return { recurrence: null, error: null };

  let endAt: string | null = null;
  const endMatch = /(?:まで|〜|~)\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*$/.exec(text);
  if (endMatch) {
    endAt = endMatch[1]!.replace(/\//g, "-");
    text = text.slice(0, endMatch.index).trim();
  }
  const timeMatch = /(\d{1,2}:\d{2})\s*$/.exec(text);
  if (!timeMatch) return { recurrence: null, error: "繰り返しの時刻（HH:MM）が読み取れません。" };
  const time = timeMatch[1]!;
  const head = text.slice(0, timeMatch.index).trim();

  let match = /^(毎日|(\d+)日ごと)$/.exec(head);
  if (match) {
    return { recurrence: { freq: "daily", interval: match[2] ? Number(match[2]) : 1, time, endAt }, error: null };
  }
  match = /^(毎週|(\d+)週ごと)(?:[（(]([^)）]+)[)）])?$/.exec(head);
  if (match) {
    if (match[3] && parseWeekdays(match[3]).length === 0) return { recurrence: null, error: `繰り返しの曜日が読み取れません: ${match[3]}` };
    const weekdays = match[3] ? parseWeekdays(match[3]) : [];
    return { recurrence: { freq: "weekly", interval: match[2] ? Number(match[2]) : 1, weekdays: weekdays.length ? weekdays : undefined, time, endAt }, error: null };
  }
  match = /^(毎月(\d{1,2})日?|(\d+)ヶ月ごと(?:[（(](\d{1,2})日?[)）])?)$/.exec(head);
  if (match) {
    const monthDayText = match[2] ?? match[4];
    if (monthDayText !== undefined && (Number(monthDayText) < 1 || Number(monthDayText) > 31)) return { recurrence: null, error: "每月の日付は1〜31で指定してください。" };
    return {
      recurrence: { freq: "monthly", interval: match[3] ? Number(match[3]) : 1, monthDay: monthDayText === undefined ? undefined : Number(monthDayText), time, endAt },
      error: null,
    };
  }
  return { recurrence: null, error: "繰り返しの書き方を確認してください（例: 毎日 09:30 / 毎週(月,木) 20:00 / 毎月15 10:00）。" };
}

function parseWeekdays(text: string): number[] {
  const found = new Set<number>();
  for (const part of text.split(/[,、・]/)) {
    const day = WEEKDAY_CHARS[part.trim().replace("曜", "").slice(0, 1)];
    if (day !== undefined) found.add(day);
  }
  return [...found].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- row assembly

function mapHeaders(cells: string[]): Map<string, number> {
  const map = new Map<string, number>();
  cells.forEach((cell, index) => {
    const key = HEADER_ALIASES[cell.trim().toLowerCase()];
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

/**
 * Turns CSV text into importable rows plus per-line problems.
 * Relative media paths are resolved against `baseDir` (the CSV's folder).
 */
export function parseImportRows(text: string, baseDir?: string): { rows: CsvImportRow[]; problems: CsvProblem[] } {
  const { cells, lines } = parseCsvWithLines(text);
  if (cells.length === 0) return { rows: [], problems: [{ line: 1, message: "CSVにデータがありません。" }] };
  const header = mapHeaders(cells[0]!);
  if (!header.has("scheduledAt")) return { rows: [], problems: [{ line: lines[0]!, message: "1行目のヘッダーに「投稿日時」が見つかりません。サンプルCSVの見出しをそのままお使いください。" }] };

  const rows: CsvImportRow[] = [];
  const problems: CsvProblem[] = [];
  for (let index = 1; index < cells.length; index += 1) {
    const values = cells[index]!;
    const line = lines[index] ?? index + 1;
    const cell = (key: string) => {
      const position = header.get(key);
      return position === undefined ? "" : (values[position] ?? "").trim();
    };

    const scheduledAt = parseDateTimeCell(cell("scheduledAt"));
    if (!scheduledAt) {
      problems.push({ line, message: "投稿日時を読み取れません（例: 2026-04-01 10:00）。" });
      continue;
    }
    const kindText = cell("kind");
    const kind = kindText ? parseKindCell(kindText) : "image";
    if (!kind) {
      problems.push({ line, message: `種別「${kindText}」は フィード画像/カルーセル/リール/ストーリーズ/Threads のいずれかで指定してください。` });
      continue;
    }
    const recurrenceSpec = parseRecurrenceSpec(cell("recurrence"));
    if (recurrenceSpec.error) {
      problems.push({ line, message: recurrenceSpec.error });
      continue;
    }
    const mediaPaths = cell("mediaPaths")
      .split(";")
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => (baseDir && !isAbsolute(path) ? resolve(baseDir, path) : path));
    if (kind !== "threads" && mediaPaths.length === 0) {
      problems.push({ line, message: "メディアパスが空です（Threads投稿のみ本文だけで投稿できます）。" });
      continue;
    }
    rows.push({ line, kind, scheduledAt, caption: cell("caption"), mediaPaths, recurrence: recurrenceSpec.recurrence, accountId: cell("account") || null });
  }
  return { rows, problems };
}

function parseKindCell(input: string): PostKind | null {
  return KIND_ALIASES[input.trim().toLowerCase()] ?? null;
}
