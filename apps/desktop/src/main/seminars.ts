import QRCode from "qrcode";
import type { BrokerClient } from "./broker-client.js";
import type { DataStore } from "./data-store.js";
import { messageOf } from "./engine.js";
import { newId, nowIso } from "./ids.js";
import type { LineClient } from "./line-client.js";
import type { ConnectionStorage } from "./storage.js";
import { DEFAULT_ACCOUNT_ID, type BrokerEvent, type Seminar, type SeminarApplication } from "./types.js";

type SeminarDeps = {
  data: DataStore;
  secrets: ConnectionStorage;
  broker: BrokerClient;
  line: LineClient;
  notify?: (type: string, payload?: unknown) => void;
};

const REMINDER_TICK_MS = 60_000;

export function validateSeminar(seminar: Seminar): string[] {
  const problems: string[] = [];
  if (!seminar.title.trim()) problems.push("セミナー名を入力してください。");
  if (seminar.dates.length === 0) problems.push("日程を1つ以上追加してください。");
  for (const date of seminar.dates) {
    if (Number.isNaN(Date.parse(date.startsAt))) problems.push("日程の日時を確認してください。");
    if (date.capacity !== null && (!Number.isInteger(date.capacity) || date.capacity < 1)) problems.push("定員は1以上の整数にしてください。");
  }
  for (const reminder of seminar.reminders) {
    if (!(reminder.hoursBefore > 0)) problems.push("リマインドは開始の何時間前かを1以上で指定してください。");
    if (!reminder.text.trim()) problems.push("リマインド本文を入力してください。");
  }
  return problems;
}

/** Seminar sign-up pages live on the broker; thanks and reminder messages go out over LINE from this PC. */
export class SeminarService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SeminarDeps) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.processReminders(), REMINDER_TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async save(input: Seminar): Promise<Seminar> {
    const problems = validateSeminar(input);
    if (problems.length > 0) throw new Error(problems.join(" "));
    const data = this.deps.data.get();
    const existing = data.seminars.find((seminar) => seminar.id === input.id);
    const seminar: Seminar = {
      ...input,
      id: input.id || newId("sem"),
      accountId: existing?.accountId ?? input.accountId ?? data.accounts[0]?.id ?? DEFAULT_ACCOUNT_ID,
      applications: existing?.applications ?? [],
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    const connection = await this.deps.secrets.load("instagram", seminar.accountId);
    if (connection) {
      try {
        const capabilities = await this.deps.broker.capabilities();
        if (capabilities.seminars) {
          const result = await this.deps.broker.saveSeminar(connection, seminar);
          seminar.publicUrl = result.publicUrl;
        }
      } catch (cause) {
        this.deps.data.log("warn", "seminar", "申込ページの公開に失敗しました（ローカルには保存しました）", messageOf(cause));
      }
    }
    this.deps.data.update((store) => {
      const index = store.seminars.findIndex((item) => item.id === seminar.id);
      if (index >= 0) store.seminars[index] = seminar;
      else store.seminars.push(seminar);
    }, "seminars:changed");
    return seminar;
  }

  async remove(id: string): Promise<void> {
    const seminar = this.deps.data.get().seminars.find((item) => item.id === id);
    const connection = seminar ? await this.deps.secrets.load("instagram", seminar.accountId).catch(() => null) : null;
    if (connection) {
      try {
        await this.deps.broker.deleteSeminar(connection, id);
      } catch {
        // page may already be gone
      }
    }
    this.deps.data.update((data) => {
      data.seminars = data.seminars.filter((seminar) => seminar.id !== id);
    }, "seminars:changed");
  }

  async handleEvent(event: BrokerEvent): Promise<void> {
    if (event.type !== "seminar.application") return;
    const payload = event.payload as { seminarId?: string; application?: SeminarApplication } | null;
    if (!payload?.seminarId || !payload.application) return;
    await this.addApplication(payload.seminarId, payload.application);
  }

  async sync(): Promise<void> {
    for (const seminar of this.deps.data.get().seminars) {
      if (!seminar.publicUrl) continue;
      const connection = await this.deps.secrets.load("instagram", seminar.accountId).catch(() => null);
      if (!connection) continue;
      try {
        const result = await this.deps.broker.seminarApplications(connection, seminar.id);
        for (const application of result.applications) await this.addApplication(seminar.id, application);
      } catch (cause) {
        this.deps.data.log("warn", "seminar", `申込一覧の取得に失敗しました（${seminar.title}）`, messageOf(cause));
      }
    }
  }

  private async addApplication(seminarId: string, application: SeminarApplication): Promise<void> {
    const seminar = this.deps.data.get().seminars.find((item) => item.id === seminarId);
    if (!seminar || seminar.applications.some((item) => item.id === application.id)) return;
    const stored: SeminarApplication = { ...application, thanksSentAt: null, remindersSent: [] };
    this.deps.data.update(() => {
      seminar.applications.push(stored);
    }, "seminars:changed");
    const date = seminar.dates.find((item) => item.id === application.dateId);
    this.deps.data.log("info", "seminar", `セミナー申込: ${application.name}`, `${seminar.title} / ${date ? formatDate(date.startsAt) : "日程不明"}`);
    if (stored.lineUserId && seminar.thanksMessage.trim()) {
      await this.pushLine(stored.lineUserId, fill(seminar.thanksMessage, seminar, date?.startsAt ?? null, application.name), `お礼メッセージ（${application.name}）`);
      this.deps.data.update(() => {
        stored.thanksSentAt = nowIso();
      }, "seminars:changed");
    }
    this.deps.notify?.("seminars:changed");
  }

  async processReminders(): Promise<void> {
    const now = Date.now();
    for (const seminar of this.deps.data.get().seminars) {
      if (!seminar.enabled) continue;
      for (const reminder of seminar.reminders) {
        for (const application of seminar.applications) {
          if (!application.lineUserId || application.remindersSent.includes(reminder.id)) continue;
          const date = seminar.dates.find((item) => item.id === application.dateId);
          if (!date) continue;
          const startsAt = Date.parse(date.startsAt);
          if (now < startsAt - reminder.hoursBefore * 3_600_000 || now >= startsAt) continue;
          const sent = await this.pushLine(application.lineUserId, fill(reminder.text, seminar, date.startsAt, application.name), `リマインド（${application.name}）`);
          if (sent) {
            this.deps.data.update(() => {
              application.remindersSent.push(reminder.id);
            }, "seminars:changed");
          }
        }
      }
    }
  }

  private async pushLine(to: string, text: string, label: string): Promise<boolean> {
    const token = await this.deps.secrets.loadLineChannelToken();
    if (!token) {
      this.deps.data.log("warn", "seminar", `LINE未設定のため送信できません: ${label}`);
      return false;
    }
    try {
      await this.deps.line.push(token, to, text);
      this.deps.data.log("info", "seminar", `LINEを送信しました: ${label}`);
      return true;
    } catch (cause) {
      this.deps.data.log("error", "seminar", `LINEの送信に失敗しました: ${label}`, messageOf(cause));
      return false;
    }
  }

  async qrCode(text: string): Promise<string> {
    return QRCode.toDataURL(text, { margin: 1, width: 320 });
  }
}

function fill(template: string, seminar: Seminar, startsAt: string | null, name: string): string {
  return template
    .replaceAll("{name}", name)
    .replaceAll("{title}", seminar.title)
    .replaceAll("{date}", startsAt ? formatDate(startsAt) : "");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
}
