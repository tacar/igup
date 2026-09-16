import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { AiError, generateIdeas, type AiIdeas } from "./ai-client.js";
import { BrokerClient } from "./broker-client.js";
import { DataStore } from "./data-store.js";
import { decodeCsvBytes, parseImportRows } from "./csv-import.js";
import { AutomationEngine, messageOf } from "./engine.js";
import { newId, nowIso } from "./ids.js";
import { InsightsCollector } from "./insights.js";
import { InstagramClient } from "./instagram-client.js";
import { LineClient } from "./line-client.js";
import { LocalApi, type ApiRoute } from "./local-api.js";
import { contentTypeFor, isImageFile, isVideoFile, recurrenceLabel, validatePost } from "./posts.js";
import { encodeChainPayload, validateRule } from "./rules.js";
import { Scheduler } from "./scheduler.js";
import { SeminarService } from "./seminars.js";
import type { ConnectionStorage } from "./storage.js";
import { ThreadsClient } from "./threads-client.js";
import {
  emptyMessage,
  emptyStats,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_AI_SETTINGS,
  DEFAULT_SETTINGS,
  type Account,
  type AccountInfo,
  type AppData,
  type AiSettings,
  type BrokerCapabilities,
  type CalendarMemo,
  type Connection,
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

export type CsvImportPreview = {
  path: string;
  rows: { line: number; scheduledAt: string; kind: ScheduledPost["kind"]; caption: string; mediaCount: number; recurrence: string | null; account: string | null }[];
  problems: { line: number; message: string }[];
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
    const lineToken = await this.options.secrets.loadLineChannelToken();
    const capabilities = await this.capabilities();
    const accounts: { id: string; username: string; instagram: { connected: boolean; expiresAt: string | null }; threads: { connected: boolean; expiresAt: string | null } }[] = [];
    for (const account of this.data.get().accounts) {
      const [instagram, threads] = await Promise.all([
        this.options.secrets.load("instagram", account.id),
        this.options.secrets.load("threads", account.id),
      ]);
      accounts.push({
        id: account.id,
        username: account.username,
        instagram: { connected: Boolean(instagram), expiresAt: instagram?.expiresAt ?? null },
        threads: { connected: Boolean(threads), expiresAt: threads?.expiresAt ?? null },
      });
    }
    const active = accounts.find((entry) => entry.id === this.activeAccountId()) ?? accounts[0] ?? null;
    return {
      accounts,
      activeAccountId: active?.id ?? null,
      // legacy single-account mirror fields — kept so the renderer and local API stay compatible
      instagram: active?.instagram ?? { connected: false, expiresAt: null },
      threads: active?.threads ?? { connected: false, expiresAt: null },
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

  // ---------------------------------------------------------------- accounts

  listAccounts(): AccountInfo[] {
    return this.data.get().accounts;
  }

  /** The account new data is attributed to when the caller does not name one. */
  activeAccountId(): string {
    const data = this.data.get();
    if (data.activeAccountId && data.accounts.some((account) => account.id === data.activeAccountId)) return data.activeAccountId;
    return data.accounts[0]?.id ?? DEFAULT_ACCOUNT_ID;
  }

  /** Resolves a caller-supplied id to a known account, falling back to the active one. */
  private resolveAccountId(input?: string | null): string {
    if (input && this.data.get().accounts.some((account) => account.id === input)) return input;
    return this.activeAccountId();
  }

  setActiveAccount(accountId: string): void {
    if (!this.data.get().accounts.some((account) => account.id === accountId)) throw new Error("アカウントが見つかりません。");
    this.data.update((data) => {
      data.activeAccountId = accountId;
    }, "accounts:changed");
    this.options.notify("connection:changed");
  }

  /** Removes an account and everything scoped to it. Scheduled posts block removal. */
  removeAccount(accountId: string): void {
    const data = this.data.get();
    if (!data.accounts.some((account) => account.id === accountId)) throw new Error("アカウントが見つかりません。");
    if (data.accounts.length <= 1) throw new Error("最後のアカウントは削除できません。接続を解除してください。");
    const scheduled = data.posts.filter((post) => post.accountId === accountId && (post.status === "scheduled" || post.status === "publishing")).length;
    if (scheduled > 0) throw new Error(`このアカウントには予約中の投稿が${scheduled}件あります。先に予約を取り消してください。`);
    const removedRules = data.rules.filter((rule) => rule.accountId === accountId).map((rule) => rule.id);
    const prefix = `${accountId}:`;
    this.data.update((store) => {
      store.accounts = store.accounts.filter((account) => account.id !== accountId);
      if (store.activeAccountId === accountId) store.activeAccountId = store.accounts[0]?.id ?? null;
      store.rules = store.rules.filter((rule) => rule.accountId !== accountId);
      store.posts = store.posts.filter((post) => post.accountId !== accountId);
      store.seminars = store.seminars.filter((seminar) => seminar.accountId !== accountId);
      store.pending = store.pending.filter((item) => item.accountId === accountId || !removedRules.includes(item.ruleId));
      store.accountSnapshots = store.accountSnapshots.filter((item) => item.accountId !== accountId);
      store.mediaSnapshots = store.mediaSnapshots.filter((item) => item.accountId !== accountId);
      store.storySnapshots = store.storySnapshots.filter((item) => item.accountId !== accountId);
      store.cursors = Object.fromEntries(Object.entries(store.cursors).filter(([key]) => key !== accountId));
      store.lastInsightsDate = Object.fromEntries(Object.entries(store.lastInsightsDate).filter(([key]) => key !== accountId));
      store.lastStorySnapshotAt = Object.fromEntries(Object.entries(store.lastStorySnapshotAt).filter(([key]) => key !== accountId));
      store.cooldowns = Object.fromEntries(Object.entries(store.cooldowns).filter(([key]) => !key.startsWith(prefix)));
      store.contacts = Object.fromEntries(Object.entries(store.contacts).filter(([key]) => !key.startsWith(prefix)));
      store.seen = {
        comments: store.seen.comments.filter((id) => !id.startsWith(prefix)),
        messages: store.seen.messages.filter((id) => !id.startsWith(prefix)),
      };
    }, "accounts:changed");
    for (const provider of ["instagram", "threads"] as const) {
      void this.options.secrets.remove(provider, accountId).catch(() => undefined);
    }
    this.engine.invalidateAccount(accountId);
    this.data.log("info", "system", "アカウントとそのデータ（ルール・投稿・分析）を削除しました");
    this.options.notify("connection:changed");
  }

  /**
   * Stores an OAuth result and decides which local account it belongs to: an explicit
   * accountId (reconnect from that account's card), an existing account already known
   * under the same Graph id, or a brand-new account.
   */
  async completeConnection(connection: Connection, provider: Provider, accountId: string | null): Promise<void> {
    let target: AccountInfo;
    let created = false;
    if (provider === "instagram") {
      let graph: Account | null = null;
      try {
        graph = await this.instagram.getAccount(connection);
      } catch {
        graph = null; // still store the token; identification can catch up on the next reconnect
      }
      const data = this.data.get();
      const graphId = graph?.id ?? null;
      const knownId = accountId ?? (graphId ? data.accounts.find((account) => account.graphId && account.graphId === graphId)?.id ?? null : null);
      const existing = knownId ? data.accounts.find((account) => account.id === knownId) : undefined;
      if (existing) {
        target = existing;
      } else {
        target = { id: newId("acc"), username: graph?.username ?? "", graphId: graph?.id ?? null, threadsUsername: null, addedAt: nowIso() };
        created = true;
      }
      await this.options.secrets.save(connection, "instagram", target.id);
      if (graph) {
        target.username = graph.username ?? target.username;
        target.graphId = graph.id;
      }
      this.data.update((data) => {
        if (!data.accounts.some((account) => account.id === target.id)) data.accounts.push(target);
        data.activeAccountId = target.id;
        data.cursors[target.id] = 0; // a fresh OAuth grant means a fresh broker event queue
      }, "accounts:changed");
      this.engine.invalidateAccount(target.id);
    } else {
      const data = this.data.get();
      const knownId = accountId ?? data.activeAccountId ?? data.accounts[0]?.id ?? null;
      const existing = knownId ? data.accounts.find((account) => account.id === knownId) : undefined;
      if (existing) {
        target = existing;
      } else {
        target = { id: newId("acc"), username: "", graphId: null, threadsUsername: null, addedAt: nowIso() };
        created = true;
      }
      await this.options.secrets.save(connection, "threads", target.id);
      try {
        const profile = await this.threads.getProfile(connection);
        target.threadsUsername = profile.username ?? target.threadsUsername;
      } catch {
        // the username cache is best effort
      }
      this.data.update((data) => {
        if (!data.accounts.some((account) => account.id === target.id)) data.accounts.push(target);
        data.activeAccountId = target.id;
      }, "accounts:changed");
    }
    this.data.log("info", "system", `${provider === "threads" ? "Threads" : "Instagram"}と接続しました${created ? "（アカウントを追加しました）" : ""}`);
    this.options.notify("connection:changed", { provider });
  }

  async disconnect(provider: Provider, accountId?: string): Promise<void> {
    const id = this.resolveAccountId(accountId);
    await this.options.secrets.remove(provider, id);
    if (provider === "instagram") this.engine.invalidateAccount(id);
    this.data.log("info", "system", `${provider === "threads" ? "Threads" : "Instagram"}との接続を解除しました`);
    this.options.notify("connection:changed");
  }

  private async requireConnection(provider: Provider = "instagram", accountId?: string): Promise<{ accountId: string; connection: Connection }> {
    const id = this.resolveAccountId(accountId);
    const connection = await this.options.secrets.load(provider, id);
    if (!connection) throw new Error(provider === "instagram" ? "先にInstagramへ接続してください。" : "先にThreadsへ接続してください。");
    return { accountId: id, connection };
  }

  async account(accountId?: string) {
    const { connection } = await this.requireConnection("instagram", accountId);
    return this.instagram.getAccount(connection);
  }

  async threadsProfile(accountId?: string) {
    const { connection } = await this.requireConnection("threads", accountId);
    return this.threads.getProfile(connection);
  }

  async recentMedia(limit = 25, accountId?: string) {
    const { connection } = await this.requireConnection("instagram", accountId);
    return (await this.instagram.listMedia(connection, limit)).data;
  }

  async subscribeWebhooks(accountId?: string): Promise<{ success: boolean }> {
    const { connection } = await this.requireConnection("instagram", accountId);
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

  // ---------------------------------------------------------------- rules

  listRules(): Rule[] {
    return this.data.get().rules;
  }

  saveRule(input: Partial<Rule> & { id?: string }): Rule {
    const existing = input.id ? this.data.get().rules.find((rule) => rule.id === input.id) : undefined;
    const rule: Rule = {
      id: existing?.id ?? newId("rule"),
      accountId: existing?.accountId ?? this.resolveAccountId(input.accountId),
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
      accountId: existing?.accountId ?? this.resolveAccountId(input.accountId),
      kind: input.kind ?? existing?.kind ?? "image",
      scheduledAt: input.scheduledAt ?? existing?.scheduledAt ?? nowIso(),
      status: "scheduled",
      caption: input.caption ?? existing?.caption ?? "",
      media: input.media ?? existing?.media ?? [],
      cover: input.cover === undefined ? existing?.cover ?? null : input.cover,
      shareToFeed: input.shareToFeed ?? existing?.shareToFeed ?? true,
      threads: input.threads ?? existing?.threads ?? [],
      attachRuleId: input.attachRuleId === undefined ? existing?.attachRuleId ?? null : input.attachRuleId,
      recurrence: input.recurrence === undefined ? existing?.recurrence ?? null : input.recurrence,
      seriesId: existing?.seriesId ?? null,
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

  /** Removes every pending (not yet published) instance of a repeat series; history stays. */
  deleteSeries(seriesId: string): number {
    const target = seriesId.trim();
    if (!target) throw new Error("シリーズIDが不正です。");
    let removed = 0;
    this.data.update((data) => {
      const keep = data.posts.filter((post) => {
        const inSeries = post.id === target || post.seriesId === target;
        if (!inSeries || post.status === "published") return true;
        removed += 1;
        return false;
      });
      data.posts = keep;
    }, "posts:changed");
    return removed;
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

  // ---------------------------------------------------------------- csv import

  private async readImportCsv(path: unknown): Promise<{ text: string; baseDir: string; filePath: string }> {
    const filePath = typeof path === "string" ? path.trim() : "";
    if (!filePath) throw new Error("CSVファイルを選択してください。");
    const bytes = new Uint8Array(await readFile(filePath));
    return { text: decodeCsvBytes(bytes), baseDir: dirname(filePath), filePath };
  }

  /** Parses a CSV file and reports row-level problems without importing anything. */
  async previewCsvImport(payload: { path: string }): Promise<CsvImportPreview> {
    const { text, baseDir, filePath } = await this.readImportCsv(payload);
    const { rows, problems } = parseImportRows(text, baseDir);
    return {
      path: filePath,
      rows: rows.map((row) => ({
        line: row.line,
        scheduledAt: row.scheduledAt,
        kind: row.kind,
        caption: row.caption.length > 60 ? `${row.caption.slice(0, 60)}…` : row.caption,
        mediaCount: row.mediaPaths.length,
        recurrence: row.recurrence ? recurrenceLabel(row.recurrence) : null,
        account: row.accountId,
      })),
      problems,
    };
  }

  /** Re-reads the CSV and creates one scheduled post per row, skipping rows that fail. */
  async commitCsvImport(payload: { path: string }): Promise<{ imported: number; failed: { line: number; error: string }[] }> {
    const { text, baseDir, filePath } = await this.readImportCsv(payload);
    const { rows } = parseImportRows(text, baseDir);
    if (rows.length === 0) throw new Error("読み込める行がありません。プレビューで問題を確認してください。");
    const failed: { line: number; error: string }[] = [];
    let imported = 0;
    for (const row of rows) {
      try {
        const accountId = this.resolveCsvAccountId(row.accountId);
        const media = row.mediaPaths.length > 0 ? await this.importMedia(row.mediaPaths) : [];
        this.savePost({
          accountId,
          kind: row.kind,
          scheduledAt: row.scheduledAt,
          caption: row.kind === "threads" ? "" : row.caption,
          media,
          cover: null,
          shareToFeed: true,
          threads: row.kind === "threads" ? [{ text: row.caption, media: [] }] : [],
          attachRuleId: null,
          recurrence: row.recurrence,
        });
        imported += 1;
      } catch (cause) {
        failed.push({ line: row.line, error: messageOf(cause) });
      }
    }
    if (imported > 0) {
      this.data.log("info", "post", `CSVから予約投稿を${imported}件読み込みました`, `${basename(filePath)}${failed.length > 0 ? `（スキップ${failed.length}件）` : ""}`);
    }
    return { imported, failed };
  }

  /** Matches the CSV account column by id / username / Threads username; empty falls back to the active account. */
  private resolveCsvAccountId(input: string | null): string {
    if (!input) return this.resolveAccountId(undefined);
    const key = input.trim().replace(/^@/, "").toLowerCase();
    const account = this.data.get().accounts.find((item) =>
      item.id.toLowerCase() === key || item.username.toLowerCase() === key || (item.threadsUsername ?? "").toLowerCase() === key);
    if (!account) throw new Error(`アカウント「${input}」が見つかりません。接続画面のユーザー名と一致させてください。`);
    return account.id;
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
    const { connection } = await this.requireConnection("instagram");
    const result = await this.broker.listLinks(connection);
    this.data.update((data) => {
      data.links = result.links;
    }, "links:changed");
    return result.links;
  }

  async createLink(input: { url: string; label: string; source: string; slug?: string }) {
    if (!/^https?:\/\//.test(input.url)) throw new Error("リンク先URLは http(s):// から入力してください。");
    const { connection } = await this.requireConnection("instagram");
    const result = await this.broker.createLink(connection, input);
    this.data.log("info", "link", `計測リンクを作成しました: ${result.link.trackedUrl}`, input.url);
    await this.listLinks();
    return result.link;
  }

  async deleteLink(slug: string) {
    const { connection } = await this.requireConnection("instagram");
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
    // the AI key lives only in encrypted ConnectionStorage — never accept it here (data:export serializes settings)
    const { aiApiKey: _ignored, ...allowed } = patch as Partial<Settings> & { aiApiKey?: unknown };
    void _ignored;
    const next: Settings = { ...before, ...allowed };
    if (patch.brokerUrl !== undefined) next.brokerUrl = normalizeBrokerUrl(String(patch.brokerUrl));
    next.pollIntervalSec = clamp(Number(next.pollIntervalSec) || DEFAULT_SETTINGS.pollIntervalSec, 20, 3_600);
    next.brokerEventIntervalSec = clamp(Number(next.brokerEventIntervalSec) || DEFAULT_SETTINGS.brokerEventIntervalSec, 5, 600);
    next.recentMediaCount = clamp(Number(next.recentMediaCount) || DEFAULT_SETTINGS.recentMediaCount, 1, 50);
    next.missedGraceMinutes = clamp(Number(next.missedGraceMinutes) || DEFAULT_SETTINGS.missedGraceMinutes, 1, 24 * 60);
    next.storySnapshotIntervalMin = clamp(Number(next.storySnapshotIntervalMin) || DEFAULT_SETTINGS.storySnapshotIntervalMin, 15, 24 * 60);
    next.localApiPort = clamp(Number(next.localApiPort) || DEFAULT_SETTINGS.localApiPort, 1_024, 65_535);
    if (!/^#[0-9a-f]{6}$/i.test(next.accent)) next.accent = DEFAULT_SETTINGS.accent;
    if (patch.ai !== undefined) {
      const ai = patch.ai;
      next.ai = {
        provider: ai.provider === "anthropic" ? "anthropic" : "openai",
        baseUrl: String(ai.baseUrl ?? "").trim() || before.ai.baseUrl || DEFAULT_AI_SETTINGS.baseUrl,
        model: String(ai.model ?? "").trim() || before.ai.model || DEFAULT_AI_SETTINGS.model,
      };
    }
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

  // ---------------------------------------------------------------- AI text generation

  /** Stores / clears the AI API key in encrypted ConnectionStorage (never in DataStore or exports). */
  async saveAiKey(key: string | null): Promise<void> {
    const trimmed = key && key.trim() ? key.trim() : null;
    await this.options.secrets.saveAiKey(trimmed);
    this.data.log("info", "system", trimmed ? "AI APIキーを保存しました" : "AI APIキーを削除しました");
  }

  async aiStatus(): Promise<{ configured: boolean; ai: AiSettings }> {
    return { configured: Boolean(await this.options.secrets.loadAiKey()), ai: this.data.get().settings.ai };
  }

  /** Caption drafts plus related hashtags in one call. */
  async generateCaption(payload: { brief: string; tone?: string; audience?: string; postKind?: string; existingCaption?: string }): Promise<AiIdeas> {
    const ideas = await this.aiCall(this.aiPrompt(payload, "caption"));
    this.data.log("info", "post", "AIで投稿文案を生成しました", `モデル: ${this.data.get().settings.ai.model}（キーや応答本文は記録しません）`);
    return ideas;
  }

  async generateHashtags(payload: { brief: string; tone?: string; audience?: string; postKind?: string }): Promise<AiIdeas> {
    const ideas = await this.aiCall(this.aiPrompt(payload, "hashtags"));
    if (ideas.hashtags.length === 0) throw new AiError("AIの応答にハッシュタグが含まれていませんでした。もう一度お試しください。");
    this.data.log("info", "post", "AIでハッシュタグを生成しました", `${ideas.hashtags.length}件`);
    return ideas;
  }

  async aiTest(): Promise<{ provider: string; model: string }> {
    const ai = this.data.get().settings.ai;
    await this.aiCall("接続テストです。captionsには短いご挨拶を1案、hashtagsには2つほどのタグを入れて、JSONのみ返してください。");
    this.data.log("info", "system", "AI APIの接続テストに成功しました", `${ai.provider} / ${ai.model}`);
    return { provider: ai.provider, model: ai.model };
  }

  private async aiCall(prompt: string): Promise<AiIdeas> {
    const ai = this.data.get().settings.ai;
    const apiKey = await this.options.secrets.loadAiKey();
    if (!apiKey) throw new AiError("AI APIキーが未設定です。設定画面でキーを保存してください。");
    return generateIdeas({ ...ai, apiKey, prompt });
  }

  /** Japanese user prompt for the two modes; never includes secrets. */
  private aiPrompt(payload: { brief?: string; tone?: string; audience?: string; postKind?: string; existingCaption?: string }, mode: "caption" | "hashtags"): string {
    const KIND_LABELS: Record<string, string> = { image: "フィード画像", carousel: "カルーセル", reel: "リール（動画）", story: "ストーリーズ", threads: "Threads" };
    const brief = String(payload.brief ?? "").trim();
    if (!brief) throw new AiError("テーマ（何についての投稿か）を入力してください。");
    const lines = [
      `テーマ: ${brief.slice(0, 500)}`,
      `投稿の種類: ${KIND_LABELS[String(payload.postKind ?? "image")] ?? "フィード画像"}`,
      `トーン: ${String(payload.tone ?? "").trim() || "親しみやすい自然な口調"}`,
      `想定読者: ${String(payload.audience ?? "").trim() || "指定なし"}`,
    ];
    if (mode === "caption") {
      lines.push("各案は100〜400文字程度。冒頭に読者の目を引く一文、最後に行動を促す一文を入れてください。");
    } else {
      lines.push("hashtagsは10〜15個。大きな人気タグと、内容に即した具体的なタグを混ぜてください。captionsは空配列にしてください。");
    }
    const existing = String(payload.existingCaption ?? "").trim();
    if (existing) lines.push(`現在の下書き（参考にしてください）:\n${existing.slice(0, 500)}`);
    return lines.join("\n");
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
