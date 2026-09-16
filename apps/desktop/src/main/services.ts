import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { BrokerClient } from "./broker-client.js";
import { DataStore } from "./data-store.js";
import { AutomationEngine, messageOf } from "./engine.js";
import { newId, nowIso } from "./ids.js";
import { InsightsCollector } from "./insights.js";
import { InstagramClient } from "./instagram-client.js";
import { LineClient } from "./line-client.js";
import { LocalApi, type ApiRoute } from "./local-api.js";
import { contentTypeFor, isImageFile, isVideoFile, validatePost } from "./posts.js";
import { encodeChainPayload, validateRule } from "./rules.js";
import { Scheduler } from "./scheduler.js";
import { SeminarService } from "./seminars.js";
import type { ConnectionStorage } from "./storage.js";
import { ThreadsClient } from "./threads-client.js";
import {
  emptyMessage,
  emptyStats,
  DEFAULT_SETTINGS,
  type AppData,
  type BrokerCapabilities,
  type CalendarMemo,
  type MediaAsset,
  type Provider,
  type Rule,
  type ScheduledPost,
  type Seminar,
  type Settings,
} from "./types.js";
import { normalize } from "./data-store.js";

export type Notifier = (type: string, payload?: unknown) => void;

export type ServicesOptions = {
  userDataDir: string;
  brokerUrl: string;
  graphVersion: string;
  secrets: ConnectionStorage;
  notify: Notifier;
  appVersion: string;
  /** Called whenever the effective broker URL changes so the desktop auth flow can follow it. */
  onBrokerUrlChanged?: (url: string) => void;
};

/** Everything the UI (IPC) and the local HTTP API can do, in one place. */
export class Services {
  readonly data: DataStore;
  readonly instagram: InstagramClient;
  readonly threads = new ThreadsClient();
  readonly broker: BrokerClient;
  readonly line = new LineClient();
  readonly engine: AutomationEngine;
  readonly scheduler: Scheduler;
  readonly insights: InsightsCollector;
  readonly seminars: SeminarService;
  readonly localApi: LocalApi;
  private capabilitiesCache: { at: number; value: BrokerCapabilities | null } = { at: 0, value: null };

  constructor(private readonly options: ServicesOptions) {
    this.data = DataStore.inDirectory(options.userDataDir);
    this.instagram = new InstagramClient(options.graphVersion);
    this.broker = new BrokerClient(options.brokerUrl);
    const shared = { data: this.data, secrets: options.secrets, instagram: this.instagram, broker: this.broker, notify: options.notify };
    this.seminars = new SeminarService({ ...shared, line: this.line });
    this.engine = new AutomationEngine({ ...shared, onBrokerEvent: (event) => this.seminars.handleEvent(event) });
    this.scheduler = new Scheduler({ ...shared, threads: this.threads });
    this.insights = new InsightsCollector(shared);
    this.localApi = new LocalApi(this.apiRoutes(), () => options.secrets.localApiToken());
  }

  async start(): Promise<void> {
    await this.data.load();
    this.data.subscribe((event) => this.options.notify(`data:${event.type}`, event.payload));
    await this.applyBrokerUrl(this.effectiveBrokerUrl());
    this.engine.start();
    this.scheduler.start();
    this.insights.start();
    this.seminars.start();
    await this.applyLocalApiSetting();
  }

  async stop(): Promise<void> {
    this.engine.stop();
    this.scheduler.stop();
    this.insights.stop();
    this.seminars.stop();
    await this.localApi.stop();
    await this.data.flush();
  }

  // ---------------------------------------------------------------- connection

  /** Settings value wins, then the launch-time env value, then the local dev default. */
  effectiveBrokerUrl(): string {
    const fromSettings = this.data.get().settings.brokerUrl?.trim() ?? "";
    return fromSettings || this.options.brokerUrl || "http://127.0.0.1:8787";
  }

  /** Points every broker consumer (client, engine, auth) at a new URL without a restart. */
  async applyBrokerUrl(url: string): Promise<void> {
    const target = normalizeBrokerUrl(url);
    if (!target || target === this.broker.brokerUrl) return;
    this.broker.setBaseUrl(target);
    this.options.onBrokerUrlChanged?.(target);
    this.capabilitiesCache = { at: 0, value: null };
    try {
      await this.engine.detectWebhookMode();
    } catch (cause) {
      this.data.log("warn", "system", "ブローカーへの接続確認ができませんでした", messageOf(cause));
    }
    this.data.log("info", "system", `ブローカーURLを ${target} に切り替えました`);
    this.options.notify("connection:changed");
  }

  async connectionStatus() {
    const [instagram, threads, lineToken] = await Promise.all([
      this.options.secrets.load("instagram"),
      this.options.secrets.load("threads"),
      this.options.secrets.loadLineChannelToken(),
    ]);
    const capabilities = await this.capabilities();
    return {
      instagram: { connected: Boolean(instagram), expiresAt: instagram?.expiresAt ?? null },
      threads: { connected: Boolean(threads), expiresAt: threads?.expiresAt ?? null },
      line: { configured: Boolean(lineToken) },
      broker: { url: this.broker.brokerUrl, reachable: capabilities !== null, capabilities },
      automation: this.engine.status(),
      localApi: { enabled: this.data.get().settings.localApiEnabled, port: this.localApi.port },
    };
  }

  async capabilities(force = false): Promise<BrokerCapabilities | null> {
    if (!force && Date.now() - this.capabilitiesCache.at < 60_000) return this.capabilitiesCache.value;
    try {
      this.capabilitiesCache = { at: Date.now(), value: await this.broker.capabilities() };
    } catch {
      this.capabilitiesCache = { at: Date.now(), value: null };
    }
    return this.capabilitiesCache.value;
  }

  async disconnect(provider: Provider): Promise<void> {
    await this.options.secrets.remove(provider);
    if (provider === "instagram") this.engine.invalidateAccount();
    this.data.log("info", "system", `${provider === "threads" ? "Threads" : "Instagram"}との接続を解除しました`);
    this.options.notify("connection:changed");
  }

  async account() {
    const connection = await this.requireInstagram();
    return this.instagram.getAccount(connection);
  }

  async threadsProfile() {
    const connection = await this.options.secrets.load("threads");
    if (!connection) throw new Error("Threadsに接続されていません。");
    return this.threads.getProfile(connection);
  }

  async recentMedia(limit = 25) {
    const connection = await this.requireInstagram();
    return (await this.instagram.listMedia(connection, limit)).data;
  }

  async subscribeWebhooks(): Promise<{ success: boolean }> {
    const connection = await this.requireInstagram();
    const result = await this.instagram.subscribeWebhooks(connection, "comments,live_comments,messages,messaging_postbacks,messaging_seen,message_reactions");
    this.data.log("info", "system", "Webhook購読を登録しました");
    await this.engine.detectWebhookMode();
    return { success: result.success !== false };
  }

  async saveLineToken(token: string | null): Promise<{ displayName: string | null }> {
    if (token) {
      const info = await this.line.botInfo(token);
      await this.options.secrets.saveLineChannelToken(token);
      this.data.log("info", "seminar", `LINE公式アカウント「${info.displayName}」を設定しました`);
      this.options.notify("connection:changed");
      return { displayName: info.displayName };
    }
    await this.options.secrets.saveLineChannelToken(null);
    this.options.notify("connection:changed");
    return { displayName: null };
  }

  private async requireInstagram() {
    const connection = await this.options.secrets.load("instagram");
    if (!connection) throw new Error("先にInstagramへ接続してください。");
    return connection;
  }

  // ---------------------------------------------------------------- rules

  listRules(): Rule[] {
    return this.data.get().rules;
  }

  saveRule(input: Partial<Rule> & { id?: string }): Rule {
    const existing = input.id ? this.data.get().rules.find((rule) => rule.id === input.id) : undefined;
    const rule: Rule = {
      id: existing?.id ?? newId("rule"),
      name: String(input.name ?? existing?.name ?? "").trim(),
      enabled: input.enabled ?? existing?.enabled ?? true,
      sources: input.sources ?? existing?.sources ?? ["comment"],
      keywords: (input.keywords ?? existing?.keywords ?? []).map((keyword) => String(keyword).trim()).filter(Boolean),
      matchMode: input.matchMode ?? existing?.matchMode ?? "contains",
      mediaIds: input.mediaIds ?? existing?.mediaIds ?? [],
      publicReplies: (input.publicReplies ?? existing?.publicReplies ?? []).map((reply) => String(reply)).filter((reply) => reply.trim()),
      message: input.message === undefined ? existing?.message ?? emptyMessage() : input.message,
      followUps: input.followUps ?? existing?.followUps ?? [],
      cooldownHours: Number(input.cooldownHours ?? existing?.cooldownHours ?? 24),
      stats: existing?.stats ?? emptyStats(),
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    if (rule.message && !rule.message.text.trim() && rule.message.buttons.length === 0 && rule.message.quickReplies.length === 0) rule.message = null;
    const problems = validateRule(rule);
    if (problems.length > 0) throw new Error(problems.join(" "));
    this.data.update((data) => {
      const index = data.rules.findIndex((item) => item.id === rule.id);
      if (index >= 0) data.rules[index] = rule;
      else data.rules.push(rule);
    }, "rules:changed");
    return rule;
  }

  deleteRule(id: string): void {
    this.data.update((data) => {
      data.rules = data.rules.filter((rule) => rule.id !== id);
      data.pending = data.pending.filter((item) => item.ruleId !== id);
    }, "rules:changed");
  }

  chainPayload(originRuleId: string, targetRuleId: string): string {
    return encodeChainPayload(originRuleId, targetRuleId);
  }

  // ---------------------------------------------------------------- posts

  listPosts(): ScheduledPost[] {
    return this.data.get().posts;
  }

  savePost(input: Partial<ScheduledPost> & { id?: string }): ScheduledPost {
    const existing = input.id ? this.data.get().posts.find((post) => post.id === input.id) : undefined;
    if (existing && (existing.status === "publishing")) throw new Error("投稿中の予約は編集できません。");
    const post: ScheduledPost = {
      id: existing?.id ?? newId("post"),
      kind: input.kind ?? existing?.kind ?? "image",
      scheduledAt: input.scheduledAt ?? existing?.scheduledAt ?? nowIso(),
      status: "scheduled",
      caption: input.caption ?? existing?.caption ?? "",
      media: input.media ?? existing?.media ?? [],
      cover: input.cover === undefined ? existing?.cover ?? null : input.cover,
      shareToFeed: input.shareToFeed ?? existing?.shareToFeed ?? true,
      threads: input.threads ?? existing?.threads ?? [],
      attachRuleId: input.attachRuleId === undefined ? existing?.attachRuleId ?? null : input.attachRuleId,
      publishedId: existing?.publishedId ?? null,
      permalink: existing?.permalink ?? null,
      publishedAt: existing?.publishedAt ?? null,
      error: null,
      attempts: existing?.attempts ?? 0,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    if (existing?.status === "published") {
      post.status = "published";
    }
    const problems = validatePost(post);
    if (problems.length > 0) throw new Error(problems.join(" "));
    this.data.update((data) => {
      const index = data.posts.findIndex((item) => item.id === post.id);
      if (index >= 0) data.posts[index] = post;
      else data.posts.push(post);
      data.posts.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    }, "posts:changed");
    return post;
  }

  deletePost(id: string): void {
    this.data.update((data) => {
      data.posts = data.posts.filter((post) => post.id !== id);
    }, "posts:changed");
  }

  cancelPost(id: string): void {
    this.data.update((data) => {
      const post = data.posts.find((item) => item.id === id);
      if (post && post.status === "scheduled") {
        post.status = "canceled";
        post.updatedAt = nowIso();
      }
    }, "posts:changed");
  }

  async publishNow(id: string): Promise<ScheduledPost> {
    const post = this.data.get().posts.find((item) => item.id === id);
    if (!post) throw new Error("投稿が見つかりません。");
    if (post.status === "published") throw new Error("この投稿はすでに公開されています。");
    this.data.update(() => {
      post.status = "scheduled";
      post.scheduledAt = nowIso();
      post.error = null;
      post.updatedAt = nowIso();
    }, "posts:changed");
    return this.scheduler.publish(id);
  }

  // ---------------------------------------------------------------- media files

  private get mediaDir(): string {
    return join(this.options.userDataDir, "media");
  }

  /** Copies picked files into the app's media folder so edits and moves of the originals do not break schedules. */
  async importMedia(paths: string[]): Promise<MediaAsset[]> {
    await mkdir(this.mediaDir, { recursive: true });
    const assets: MediaAsset[] = [];
    for (const source of paths) {
      const fileName = basename(source);
      if (!isImageFile(fileName) && !isVideoFile(fileName)) throw new Error(`「${fileName}」は対応していない形式です（JPEG / PNG / MP4 / MOV）。`);
      const id = newId("m");
      const target = join(this.mediaDir, `${id}${extname(fileName).toLowerCase()}`);
      await copyFile(source, target);
      const { size } = await stat(target);
      assets.push({ id, kind: isVideoFile(fileName) ? "video" : "image", url: null, localPath: target, brokerId: null, fileName, size });
    }
    return assets;
  }

  /** Stores an edited (cropped / converted) image delivered by the renderer as a data URL. */
  async saveEditedImage(dataUrl: string, fileName: string): Promise<MediaAsset> {
    const match = /^data:(image\/(jpeg|png));base64,(.+)$/s.exec(dataUrl);
    if (!match) throw new Error("画像データを読み取れませんでした。");
    await mkdir(this.mediaDir, { recursive: true });
    const id = newId("m");
    const extension = match[2] === "png" ? ".png" : ".jpg";
    const target = join(this.mediaDir, `${id}${extension}`);
    const bytes = Buffer.from(match[3]!, "base64");
    await writeFile(target, bytes);
    const cleanName = fileName.replace(/\.[^.]+$/, "") + extension;
    return { id, kind: "image", url: null, localPath: target, brokerId: null, fileName: cleanName, size: bytes.length };
  }

  async mediaPreview(asset: MediaAsset): Promise<string | null> {
    if (!asset.localPath || asset.kind !== "image") return asset.url;
    const { size } = await stat(asset.localPath);
    if (size > 25 * 1_048_576) return null;
    const bytes = await readFile(asset.localPath);
    return `data:${contentTypeFor(asset.fileName)};base64,${bytes.toString("base64")}`;
  }

  // ---------------------------------------------------------------- calendar memos

  saveMemo(input: Partial<CalendarMemo> & { id?: string }): CalendarMemo {
    const existing = input.id ? this.data.get().memos.find((memo) => memo.id === input.id) : undefined;
    const memo: CalendarMemo = {
      id: existing?.id ?? newId("memo"),
      date: input.date ?? existing?.date ?? nowIso().slice(0, 10),
      title: String(input.title ?? existing?.title ?? "").trim(),
      note: String(input.note ?? existing?.note ?? ""),
      color: input.color ?? existing?.color ?? "#6b7280",
    };
    if (!memo.title) throw new Error("メモのタイトルを入力してください。");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(memo.date)) throw new Error("日付を確認してください。");
    this.data.update((data) => {
      const index = data.memos.findIndex((item) => item.id === memo.id);
      if (index >= 0) data.memos[index] = memo;
      else data.memos.push(memo);
    }, "memos:changed");
    return memo;
  }

  deleteMemo(id: string): void {
    this.data.update((data) => {
      data.memos = data.memos.filter((memo) => memo.id !== id);
    }, "memos:changed");
  }

  // ---------------------------------------------------------------- links

  async listLinks() {
    const connection = await this.requireInstagram();
    const result = await this.broker.listLinks(connection);
    this.data.update((data) => {
      data.links = result.links;
    }, "links:changed");
    return result.links;
  }

  async createLink(input: { url: string; label: string; source: string; slug?: string }) {
    if (!/^https?:\/\//.test(input.url)) throw new Error("リンク先URLは http(s):// から入力してください。");
    const connection = await this.requireInstagram();
    const result = await this.broker.createLink(connection, input);
    this.data.log("info", "link", `計測リンクを作成しました: ${result.link.trackedUrl}`, input.url);
    await this.listLinks();
    return result.link;
  }

  async deleteLink(slug: string) {
    const connection = await this.requireInstagram();
    await this.broker.deleteLink(connection, slug);
    await this.listLinks();
  }

  // ---------------------------------------------------------------- seminars

  listSeminars(): Seminar[] {
    return this.data.get().seminars;
  }

  // ---------------------------------------------------------------- settings & data

  settings(): Settings {
    return this.data.get().settings;
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const before = { ...this.data.get().settings };
    const next: Settings = { ...before, ...patch };
    if (patch.brokerUrl !== undefined) next.brokerUrl = normalizeBrokerUrl(String(patch.brokerUrl));
    next.pollIntervalSec = clamp(Number(next.pollIntervalSec) || DEFAULT_SETTINGS.pollIntervalSec, 20, 3_600);
    next.brokerEventIntervalSec = clamp(Number(next.brokerEventIntervalSec) || DEFAULT_SETTINGS.brokerEventIntervalSec, 5, 600);
    next.recentMediaCount = clamp(Number(next.recentMediaCount) || DEFAULT_SETTINGS.recentMediaCount, 1, 50);
    next.missedGraceMinutes = clamp(Number(next.missedGraceMinutes) || DEFAULT_SETTINGS.missedGraceMinutes, 1, 24 * 60);
    next.storySnapshotIntervalMin = clamp(Number(next.storySnapshotIntervalMin) || DEFAULT_SETTINGS.storySnapshotIntervalMin, 15, 24 * 60);
    next.localApiPort = clamp(Number(next.localApiPort) || DEFAULT_SETTINGS.localApiPort, 1_024, 65_535);
    if (!/^#[0-9a-f]{6}$/i.test(next.accent)) next.accent = DEFAULT_SETTINGS.accent;
    if (patch.automationEnabled !== undefined && patch.automationEnabled !== before.automationEnabled) {
      const enabled = patch.automationEnabled;
      this.engine.setEnabled(enabled);
      next.automationEnabled = enabled;
    }
    this.data.update((data) => {
      data.settings = next;
    }, "settings:changed");
    if (next.pollIntervalSec !== before.pollIntervalSec || next.brokerEventIntervalSec !== before.brokerEventIntervalSec) this.engine.restart();
    if (next.localApiEnabled !== before.localApiEnabled || next.localApiPort !== before.localApiPort) await this.applyLocalApiSetting();
    if (next.brokerUrl !== before.brokerUrl) await this.applyBrokerUrl(this.effectiveBrokerUrl());
    return next;
  }

  private async applyLocalApiSetting(): Promise<void> {
    const settings = this.data.get().settings;
    try {
      if (settings.localApiEnabled) await this.localApi.start(settings.localApiPort);
      else await this.localApi.stop();
    } catch (cause) {
      this.data.log("error", "system", "ローカルAPIを起動できませんでした", messageOf(cause));
    }
  }

  async localApiToken(regenerate = false): Promise<string> {
    return this.options.secrets.localApiToken(regenerate);
  }

  exportData(): AppData {
    return this.data.get();
  }

  importData(json: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("JSONとして読み込めませんでした。");
    }
    if (!parsed || typeof parsed !== "object" || !("version" in parsed)) throw new Error("IGUPのバックアップファイルではありません。");
    this.data.replace(normalize(parsed as Partial<AppData>));
    this.data.log("info", "system", "バックアップを読み込みました");
  }

  listLogs(limit = 200, category?: string) {
    const logs = this.data.get().logs;
    const filtered = category ? logs.filter((entry) => entry.category === category) : logs;
    return filtered.slice(0, limit);
  }

  clearLogs(): void {
    this.data.update((data) => {
      data.logs = [];
    }, "logs:changed");
  }

  appInfo() {
    return { version: this.options.appVersion, dataPath: this.data.path, brokerUrl: this.broker.brokerUrl, mediaDir: this.mediaDir };
  }

  // ---------------------------------------------------------------- local API routes

  private apiRoutes(): ApiRoute[] {
    const asRecord = (payload: unknown): Record<string, unknown> => (payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {});
    return [
      { method: "GET", path: "/status", handler: () => this.connectionStatus() },
      { method: "GET", path: "/account", handler: () => this.account() },
      { method: "GET", path: "/rules", handler: () => this.listRules() },
      { method: "POST", path: "/rules", handler: (payload) => this.saveRule(asRecord(payload) as Partial<Rule>) },
      { method: "PUT", path: "/rules/:id", handler: (payload) => this.saveRule(asRecord(payload) as Partial<Rule>) },
      { method: "DELETE", path: "/rules/:id", handler: (payload) => { this.deleteRule(String(asRecord(payload).id)); return { ok: true }; } },
      { method: "GET", path: "/posts", handler: () => this.listPosts() },
      { method: "POST", path: "/posts", handler: (payload) => this.savePost(asRecord(payload) as Partial<ScheduledPost>) },
      { method: "PUT", path: "/posts/:id", handler: (payload) => this.savePost(asRecord(payload) as Partial<ScheduledPost>) },
      { method: "DELETE", path: "/posts/:id", handler: (payload) => { this.deletePost(String(asRecord(payload).id)); return { ok: true }; } },
      { method: "POST", path: "/posts/:id/publish", handler: (payload) => this.publishNow(String(asRecord(payload).id)) },
      { method: "POST", path: "/media/import", handler: (payload) => this.importMedia((asRecord(payload).paths as string[]) ?? []) },
      { method: "GET", path: "/media", handler: (_payload, query) => this.recentMedia(Number(query.get("limit") ?? 25)) },
      { method: "GET", path: "/memos", handler: () => this.data.get().memos },
      { method: "POST", path: "/memos", handler: (payload) => this.saveMemo(asRecord(payload) as Partial<CalendarMemo>) },
      { method: "DELETE", path: "/memos/:id", handler: (payload) => { this.deleteMemo(String(asRecord(payload).id)); return { ok: true }; } },
      { method: "GET", path: "/insights", handler: () => this.insights.summary() },
      { method: "POST", path: "/insights/capture", handler: async () => { await this.insights.captureDaily(); await this.insights.captureStories(); return this.insights.summary(); } },
      { method: "GET", path: "/links", handler: () => this.listLinks() },
      { method: "POST", path: "/links", handler: (payload) => this.createLink(asRecord(payload) as { url: string; label: string; source: string; slug?: string }) },
      { method: "DELETE", path: "/links/:slug", handler: (payload) => this.deleteLink(String(asRecord(payload).slug)) },
      { method: "GET", path: "/seminars", handler: () => this.listSeminars() },
      { method: "POST", path: "/seminars", handler: (payload) => this.seminars.save(asRecord(payload) as unknown as Seminar) },
      { method: "GET", path: "/logs", handler: (_payload, query) => this.listLogs(Number(query.get("limit") ?? 200), query.get("category") ?? undefined) },
      { method: "GET", path: "/settings", handler: () => this.settings() },
      { method: "PUT", path: "/settings", handler: (payload) => this.saveSettings(asRecord(payload) as Partial<Settings>) },
      { method: "POST", path: "/automation/run", handler: async () => { await this.engine.runOnce(); return this.engine.status(); } },
      { method: "GET", path: "/export", handler: () => this.exportData() },
    ];
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Normalizes a user supplied broker URL. Empty means "use the fallback". */
function normalizeBrokerUrl(input: string): string {
  const value = input.trim().replace(/\/+$/, "");
  if (!value) return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ブローカーURLの形式を確認してください（例: https://broker.example.com）。");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("ブローカーURLは http(s):// で始まる必要があります。");
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (parsed.protocol === "http:" && !local) throw new Error("公開ホストのブローカーURLは https:// で指定してください（http はローカルテスト用です）。");
  return value;
}
