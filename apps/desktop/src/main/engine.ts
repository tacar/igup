import type { BrokerClient } from "./broker-client.js";
import type { DataStore } from "./data-store.js";
import { newId, nowIso } from "./ids.js";
import { InstagramApiError, type CommentItem, type InstagramClient, type MessageItem } from "./instagram-client.js";
import { cooldownKey, decodeChainPayload, findMatchingRules, findQuickReplyByTitle, isCoolingDown, pickReply, withinMessagingWindow } from "./rules.js";
import type { ConnectionStorage } from "./storage.js";
import type { Account, BrokerEvent, Connection, Contact, OutgoingMessage, Rule, RuleSource } from "./types.js";

export type EngineStatus = {
  running: boolean;
  enabled: boolean;
  lastPollAt: string | null;
  lastBrokerPollAt: string | null;
  lastError: string | null;
  webhookMode: boolean;
  pollingActive: boolean;
  backoffUntil: string | null;
};

type EngineDeps = {
  data: DataStore;
  secrets: ConnectionStorage;
  instagram: InstagramClient;
  broker: BrokerClient;
  onBrokerEvent?: (event: BrokerEvent) => Promise<void>;
  notify?: (type: string, payload?: unknown) => void;
};

type WebhookEntry = {
  id?: string;
  time?: number;
  messaging?: WebhookMessaging[];
  changes?: { field?: string; value?: WebhookCommentValue }[];
};

type WebhookMessaging = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean; quick_reply?: { payload?: string }; reply_to?: { story?: { id?: string; url?: string } }; attachments?: unknown[] };
  postback?: { mid?: string; title?: string; payload?: string };
  read?: { mid?: string };
};

type WebhookCommentValue = {
  id?: string;
  text?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string; media_product_type?: string };
  parent_id?: string;
};

const PENDING_INTERVAL_MS = 15_000;
const TOKEN_REFRESH_WINDOW_MS = 10 * 24 * 3_600_000;

/**
 * The automation engine watches comments / DMs / story replies (via broker webhooks when
 * available, otherwise by polling the Instagram API) and answers according to the rules.
 */
export class AutomationEngine {
  private pollTimer: NodeJS.Timeout | null = null;
  private brokerTimer: NodeJS.Timeout | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private draining = false;
  private account: Account | null = null;
  private webhookMode = false;
  private liveUnsupported = false;
  private backoffUntil = 0;
  private lastPollAt: string | null = null;
  private lastBrokerPollAt: string | null = null;
  private lastError: string | null = null;
  private lastTokenCheck = 0;

  constructor(private readonly deps: EngineDeps) {}

  start(): void {
    this.stop();
    const settings = this.deps.data.get().settings;
    this.pollTimer = setInterval(() => void this.pollInstagram(), Math.max(20, settings.pollIntervalSec) * 1_000);
    this.brokerTimer = setInterval(() => void this.drainBroker(), Math.max(5, settings.brokerEventIntervalSec) * 1_000);
    this.pendingTimer = setInterval(() => void this.processPending(), PENDING_INTERVAL_MS);
    void this.detectWebhookMode().then(() => {
      void this.drainBroker();
      void this.pollInstagram();
    });
  }

  stop(): void {
    for (const timer of [this.pollTimer, this.brokerTimer, this.pendingTimer]) if (timer) clearInterval(timer);
    this.pollTimer = this.brokerTimer = this.pendingTimer = null;
  }

  restart(): void {
    this.start();
  }

  status(): EngineStatus {
    const settings = this.deps.data.get().settings;
    return {
      running: this.pollTimer !== null,
      enabled: settings.automationEnabled,
      lastPollAt: this.lastPollAt,
      lastBrokerPollAt: this.lastBrokerPollAt,
      lastError: this.lastError,
      webhookMode: this.webhookMode,
      pollingActive: this.pollingActive(settings.pollingMode),
      backoffUntil: this.backoffUntil > Date.now() ? new Date(this.backoffUntil).toISOString() : null,
    };
  }

  setEnabled(enabled: boolean): void {
    this.deps.data.update((data) => {
      data.settings.automationEnabled = enabled;
      if (enabled) data.automationSince = nowIso();
    }, "settings:changed");
    this.deps.data.log("info", "system", enabled ? "自動返信を開始しました" : "自動返信を停止しました");
    if (enabled) void this.pollInstagram();
  }

  async runOnce(): Promise<void> {
    await this.detectWebhookMode();
    await this.drainBroker();
    await this.pollInstagram(true);
    await this.processPending();
  }

  async detectWebhookMode(): Promise<boolean> {
    try {
      const capabilities = await this.deps.broker.capabilities();
      this.webhookMode = capabilities.webhooks;
    } catch {
      this.webhookMode = false;
    }
    return this.webhookMode;
  }

  private pollingActive(mode: "auto" | "always" | "never"): boolean {
    if (mode === "never") return false;
    if (mode === "always") return true;
    return !this.webhookMode;
  }

  private async connection(): Promise<Connection | null> {
    return this.deps.secrets.load("instagram");
  }

  private async ensureAccount(connection: Connection): Promise<Account> {
    if (!this.account) this.account = await this.deps.instagram.getAccount(connection);
    return this.account;
  }

  invalidateAccount(): void {
    this.account = null;
  }

  // ---------------------------------------------------------------- polling

  async pollInstagram(force = false): Promise<void> {
    const data = this.deps.data.get();
    if (!data.settings.automationEnabled || this.polling) return;
    if (!force && !this.pollingActive(data.settings.pollingMode)) return;
    if (Date.now() < this.backoffUntil) return;
    const connection = await this.connection();
    if (!connection) return;
    this.polling = true;
    try {
      const account = await this.ensureAccount(connection);
      await this.maybeRefreshToken(connection);
      await this.pollComments(connection, account);
      await this.pollConversations(connection, account);
      if (data.settings.liveCommentsEnabled && !this.liveUnsupported) await this.pollLive(connection, account);
      this.lastPollAt = nowIso();
      this.lastError = null;
    } catch (cause) {
      this.recordError(cause, "Instagramの確認に失敗しました");
    } finally {
      this.polling = false;
      this.deps.notify?.("automation:status", this.status());
    }
  }

  private async pollComments(connection: Connection, account: Account): Promise<void> {
    const settings = this.deps.data.get().settings;
    const media = await this.deps.instagram.listMediaWithComments(connection, settings.recentMediaCount);
    for (const item of media.data) {
      for (const comment of item.comments?.data ?? []) {
        await this.handleComment(comment, item.id, "comment", account);
      }
    }
  }

  private async pollLive(connection: Connection, account: Account): Promise<void> {
    let lives: { data: { id: string; status?: string }[] };
    try {
      lives = await this.deps.instagram.listLiveMedia(connection);
    } catch (cause) {
      this.liveUnsupported = true;
      this.deps.data.log("warn", "system", "ライブ配信コメントの取得に対応していないアカウントのため、ライブ監視を停止しました", messageOf(cause));
      return;
    }
    for (const live of lives.data) {
      const comments = await this.deps.instagram.listComments(connection, live.id);
      for (const comment of comments.data) await this.handleComment(comment, live.id, "live", account);
    }
  }

  private async pollConversations(connection: Connection, account: Account): Promise<void> {
    const conversations = await this.deps.instagram.listConversations(connection);
    for (const conversation of conversations.data) {
      for (const message of conversation.messages?.data ?? []) {
        const senderId = message.from?.id;
        if (!senderId) continue;
        await this.handleMessage({
          id: message.id,
          senderId,
          username: message.from?.username ?? null,
          text: message.message ?? "",
          createdAt: message.created_time ?? nowIso(),
          isStoryReply: Boolean(message.story?.reply_to),
          quickReplyPayload: null,
        }, account);
      }
    }
  }

  // ---------------------------------------------------------------- broker events (webhooks)

  async drainBroker(): Promise<void> {
    if (this.draining) return;
    const connection = await this.connection();
    if (!connection) return;
    this.draining = true;
    try {
      const account = await this.ensureAccount(connection);
      let cursor = this.deps.data.get().seen.brokerCursor;
      for (let round = 0; round < 10; round += 1) {
        const batch = await this.deps.broker.events(connection, cursor);
        for (const event of batch.events) {
          try {
            if (event.type === "webhook") await this.handleWebhook(event.payload as { entry?: WebhookEntry[] }, account);
            else await this.deps.onBrokerEvent?.(event);
          } catch (cause) {
            this.deps.data.log("error", "system", "受信イベントの処理に失敗しました", messageOf(cause));
          }
          cursor = Math.max(cursor, event.id);
        }
        this.deps.data.update((data) => {
          data.seen.brokerCursor = cursor;
        });
        if (batch.events.length === 0) break;
      }
      this.lastBrokerPollAt = nowIso();
    } catch (cause) {
      // The broker being unreachable is not fatal for polling mode; surface it once per minute.
      this.lastError = messageOf(cause);
    } finally {
      this.draining = false;
    }
  }

  async handleWebhook(payload: { entry?: WebhookEntry[] }, account: Account): Promise<void> {
    if (!this.deps.data.get().settings.automationEnabled) return;
    for (const entry of payload.entry ?? []) {
      for (const messaging of entry.messaging ?? []) {
        const senderId = messaging.sender?.id;
        if (!senderId || senderId === account.id || senderId === account.user_id) continue;
        if (messaging.message && !messaging.message.is_echo) {
          await this.handleMessage({
            id: messaging.message.mid ?? newId("mid"),
            senderId,
            username: null,
            text: messaging.message.text ?? "",
            createdAt: messaging.timestamp ? new Date(messaging.timestamp).toISOString() : nowIso(),
            isStoryReply: Boolean(messaging.message.reply_to?.story),
            quickReplyPayload: messaging.message.quick_reply?.payload ?? null,
          }, account);
        } else if (messaging.postback) {
          await this.handlePostback(senderId, messaging.postback.payload ?? "", messaging.postback.title ?? "");
        } else if (messaging.read) {
          this.handleRead(senderId, messaging.timestamp ? new Date(messaging.timestamp).toISOString() : nowIso());
        }
      }
      for (const change of entry.changes ?? []) {
        if (change.field !== "comments" && change.field !== "live_comments") continue;
        const value = change.value;
        if (!value?.id) continue;
        const comment: CommentItem = {
          id: value.id,
          text: value.text ?? "",
          parent_id: value.parent_id ?? "",
          timestamp: nowIso(),
          ...(value.from?.id ? { from: { id: value.from.id, ...(value.from.username ? { username: value.from.username } : {}) } } : {}),
          ...(value.from?.username ? { username: value.from.username } : {}),
        };
        await this.handleComment(comment, value.media?.id ?? "", change.field === "live_comments" ? "live" : "comment", account);
      }
    }
  }

  // ---------------------------------------------------------------- handlers

  private async handleComment(comment: CommentItem, mediaId: string, source: "comment" | "live", account: Account): Promise<void> {
    const data = this.deps.data.get();
    if (!comment.id || this.deps.data.hasSeen("comments", comment.id)) return;
    this.deps.data.markSeen("comments", comment.id);
    const authorId = comment.from?.id ?? "";
    if (!authorId || authorId === account.id || authorId === account.user_id) return;
    if (comment.parent_id) return; // replies to comments are not entry points
    if (!isAfter(comment.timestamp, data.automationSince)) return;
    const text = comment.text ?? "";
    const rules = findMatchingRules(data.rules, { source, text, mediaId });
    if (rules.length === 0) return;
    this.deps.data.log("info", "inbound", `${source === "live" ? "ライブ" : ""}コメント「${truncate(text)}」`, `@${comment.username ?? comment.from?.username ?? authorId} / 投稿 ${mediaId}`);
    for (const rule of rules) {
      await this.executeRule(rule, { source, userId: authorId, username: comment.username ?? comment.from?.username ?? null, commentId: comment.id, text });
    }
  }

  private async handleMessage(message: { id: string; senderId: string; username: string | null; text: string; createdAt: string; isStoryReply: boolean; quickReplyPayload: string | null }, account: Account): Promise<void> {
    const data = this.deps.data.get();
    if (message.senderId === account.id || message.senderId === account.user_id) return;
    if (this.deps.data.hasSeen("messages", message.id)) return;
    this.deps.data.markSeen("messages", message.id);
    this.touchContact(message.senderId, { username: message.username, lastInboundAt: message.createdAt });
    if (!isAfter(message.createdAt, data.automationSince)) return;

    const chain = decodeChainPayload(message.quickReplyPayload) ?? findQuickReplyByTitle(data.rules, message.text);
    if (chain) {
      await this.followChain(message.senderId, chain, message.text);
      return;
    }
    const source: RuleSource = message.isStoryReply ? "story" : "dm";
    const rules = findMatchingRules(data.rules, { source, text: message.text });
    if (rules.length === 0) return;
    this.deps.data.log("info", "inbound", `${source === "story" ? "ストーリーズ返信" : "DM"}「${truncate(message.text)}」`, `@${message.username ?? message.senderId}`);
    for (const rule of rules) {
      await this.executeRule(rule, { source, userId: message.senderId, username: message.username, commentId: null, text: message.text });
    }
  }

  private async handlePostback(senderId: string, payload: string, title: string): Promise<void> {
    const chain = decodeChainPayload(payload);
    this.touchContact(senderId, { lastInboundAt: nowIso() });
    if (!chain) return;
    await this.followChain(senderId, chain, title);
  }

  private async followChain(senderId: string, chain: { originRuleId: string; targetRuleId: string }, label: string): Promise<void> {
    const data = this.deps.data.get();
    const origin = data.rules.find((rule) => rule.id === chain.originRuleId);
    const target = data.rules.find((rule) => rule.id === chain.targetRuleId);
    if (origin) this.deps.data.update(() => { origin.stats.buttonTapped += 1; }, "rules:changed");
    this.deps.data.log("info", "inbound", `ボタン「${truncate(label)}」がタップされました`, `${senderId} / ${origin?.name ?? chain.originRuleId} → ${target?.name ?? chain.targetRuleId}`);
    if (!target) return;
    await this.executeRule(target, { source: "dm", userId: senderId, username: null, commentId: null, text: label, chain: true });
  }

  private handleRead(senderId: string, at: string): void {
    const data = this.deps.data.get();
    const contact = data.contacts[senderId];
    if (!contact) return;
    this.deps.data.update(() => {
      contact.lastReadAt = at;
      if (contact.lastOutboundRuleId && !contact.readCounted && contact.lastOutboundAt && Date.parse(at) >= Date.parse(contact.lastOutboundAt)) {
        const rule = data.rules.find((candidate) => candidate.id === contact.lastOutboundRuleId);
        if (rule) rule.stats.read += 1;
        contact.readCounted = true;
      }
    }, "rules:changed");
  }

  // ---------------------------------------------------------------- rule execution

  private async executeRule(rule: Rule, context: { source: RuleSource; userId: string; username: string | null; commentId: string | null; text: string; chain?: boolean }): Promise<void> {
    const connection = await this.connection();
    if (!connection) return;
    const data = this.deps.data.get();
    const key = cooldownKey(rule.id, context.userId);
    if (!context.chain && isCoolingDown(data.cooldowns, key, rule.cooldownHours)) {
      this.deps.data.log("info", "outbound", `クールダウン中のため送信をスキップ（${rule.name}）`, `${context.username ?? context.userId}`);
      return;
    }
    this.deps.data.update(() => {
      rule.stats.matched += 1;
      data.cooldowns[key] = nowIso();
    }, "rules:changed");

    let recipientId: string | null = context.commentId ? null : context.userId;

    if (context.commentId) {
      const publicReply = pickReply(rule.publicReplies);
      if (publicReply) {
        try {
          await this.deps.instagram.replyToComment(connection, context.commentId, publicReply);
          this.deps.data.update(() => { rule.stats.publicReplied += 1; }, "rules:changed");
          this.deps.data.log("info", "outbound", `公開返信「${truncate(publicReply)}」`, `${rule.name} / @${context.username ?? context.userId}`);
        } catch (cause) {
          this.deps.data.log("error", "outbound", `公開返信に失敗（${rule.name}）`, messageOf(cause));
        }
      }
      if (rule.message) {
        try {
          const reply = await this.deps.instagram.sendPrivateReply(connection, context.commentId, rule.message.text || rule.message.buttonPrompt);
          recipientId = reply.recipient_id;
          if (rule.message.buttons.length > 0 || rule.message.quickReplies.length > 0) {
            await this.deps.instagram.sendMessage(connection, recipientId, { ...rule.message, text: "" });
          }
          this.recordSent(rule, recipientId, context.username);
          this.deps.data.log("info", "outbound", `DM「${truncate(rule.message.text)}」を送信`, `${rule.name} / @${context.username ?? context.userId}`);
        } catch (cause) {
          this.deps.data.update(() => { rule.stats.dmFailed += 1; }, "rules:changed");
          this.deps.data.log("error", "outbound", `DM送信に失敗（${rule.name}）`, messageOf(cause));
          return;
        }
      }
    } else if (rule.message && recipientId) {
      try {
        await this.deps.instagram.sendMessage(connection, recipientId, rule.message);
        this.recordSent(rule, recipientId, context.username);
        this.deps.data.log("info", "outbound", `DM「${truncate(rule.message.text || rule.message.buttonPrompt)}」を送信`, `${rule.name} / ${context.username ?? recipientId}`);
      } catch (cause) {
        this.deps.data.update(() => { rule.stats.dmFailed += 1; }, "rules:changed");
        this.deps.data.log("error", "outbound", `DM送信に失敗（${rule.name}）`, messageOf(cause));
        return;
      }
    }

    if (recipientId && rule.followUps.length > 0) {
      const now = Date.now();
      this.deps.data.update((store) => {
        for (const followUp of rule.followUps) {
          store.pending.push({
            id: newId("pend"),
            ruleId: rule.id,
            recipientId: recipientId!,
            dueAt: new Date(now + followUp.delayMinutes * 60_000).toISOString(),
            message: followUp.message,
            attempts: 0,
            createdAt: nowIso(),
          });
        }
      }, "pending:changed");
    }
  }

  private recordSent(rule: Rule, recipientId: string, username: string | null): void {
    this.deps.data.update((data) => {
      rule.stats.dmSent += 1;
      const contact = ensureContact(data.contacts, recipientId);
      if (username) contact.username = username;
      contact.lastOutboundAt = nowIso();
      contact.lastOutboundRuleId = rule.id;
      contact.readCounted = false;
    }, "rules:changed");
  }

  private touchContact(id: string, patch: Partial<Contact>): void {
    this.deps.data.update((data) => {
      const contact = ensureContact(data.contacts, id);
      if (patch.username) contact.username = patch.username;
      if (patch.lastInboundAt) contact.lastInboundAt = patch.lastInboundAt;
    });
  }

  // ---------------------------------------------------------------- follow-ups (時間差送信)

  async processPending(): Promise<void> {
    const data = this.deps.data.get();
    if (!data.settings.automationEnabled || data.pending.length === 0) return;
    const connection = await this.connection();
    if (!connection) return;
    const now = Date.now();
    const due = data.pending.filter((item) => Date.parse(item.dueAt) <= now);
    for (const item of due) {
      const rule = data.rules.find((candidate) => candidate.id === item.ruleId);
      const contact = data.contacts[item.recipientId];
      if (!withinMessagingWindow(contact?.lastInboundAt, now)) {
        this.removePending(item.id);
        this.deps.data.log("warn", "outbound", `時間差送信をスキップ（24時間ルール）`, `${rule?.name ?? item.ruleId} / ${contact?.username ?? item.recipientId}`);
        continue;
      }
      try {
        await this.deps.instagram.sendMessage(connection, item.recipientId, item.message);
        this.removePending(item.id);
        if (rule) this.deps.data.update(() => { rule.stats.followUpSent += 1; }, "rules:changed");
        this.deps.data.log("info", "outbound", `時間差送信「${truncate(item.message.text || item.message.buttonPrompt)}」`, `${rule?.name ?? item.ruleId} / ${contact?.username ?? item.recipientId}`);
      } catch (cause) {
        const failed = item.attempts + 1;
        if (failed >= 3) {
          this.removePending(item.id);
          this.deps.data.log("error", "outbound", "時間差送信に失敗（3回試行）", messageOf(cause));
        } else {
          this.deps.data.update(() => {
            item.attempts = failed;
            item.dueAt = new Date(now + 5 * 60_000).toISOString();
          }, "pending:changed");
        }
      }
    }
  }

  private removePending(id: string): void {
    this.deps.data.update((data) => {
      data.pending = data.pending.filter((item) => item.id !== id);
    }, "pending:changed");
  }

  // ---------------------------------------------------------------- misc

  private async maybeRefreshToken(connection: Connection): Promise<void> {
    if (Date.now() - this.lastTokenCheck < 6 * 3_600_000) return;
    this.lastTokenCheck = Date.now();
    if (!connection.expiresAt || Date.parse(connection.expiresAt) - Date.now() > TOKEN_REFRESH_WINDOW_MS) return;
    try {
      const refreshed = await this.deps.instagram.refreshToken(connection);
      await this.deps.secrets.save(refreshed, "instagram");
      this.deps.data.log("info", "system", "Instagramのアクセストークンを更新しました", `新しい期限: ${refreshed.expiresAt ?? "不明"}`);
      this.deps.notify?.("connection:changed");
    } catch (cause) {
      this.deps.data.log("warn", "system", "アクセストークンの更新に失敗しました", messageOf(cause));
    }
  }

  private recordError(cause: unknown, title: string): void {
    const message = messageOf(cause);
    this.lastError = message;
    if (cause instanceof InstagramApiError && cause.isRateLimit) {
      this.backoffUntil = Date.now() + 15 * 60_000;
      this.deps.data.log("warn", "system", "Instagram APIの呼び出し上限に達したため15分待機します", message);
      return;
    }
    if (cause instanceof InstagramApiError && cause.isAuth) {
      this.deps.data.log("error", "system", "Instagramの接続が無効になりました。再接続してください", message);
      return;
    }
    this.deps.data.log("error", "system", title, message);
  }

  /** Sends one rule's DM to a specific user manually (used for tests from the UI). */
  async sendTest(ruleId: string, recipientId: string): Promise<void> {
    const connection = await this.connection();
    if (!connection) throw new Error("先にInstagramへ接続してください。");
    const rule = this.deps.data.get().rules.find((candidate) => candidate.id === ruleId);
    if (!rule?.message) throw new Error("このルールにはDM本文がありません。");
    await this.deps.instagram.sendMessage(connection, recipientId, rule.message);
    this.deps.data.log("info", "outbound", `テスト送信（${rule.name}）`, recipientId);
  }
}

function ensureContact(contacts: Record<string, Contact>, id: string): Contact {
  const existing = contacts[id];
  if (existing) return existing;
  const created: Contact = { username: null, lastInboundAt: null, lastOutboundAt: null, lastOutboundRuleId: null, lastReadAt: null, readCounted: false };
  contacts[id] = created;
  return created;
}

function isAfter(timestamp: string | undefined, since: string | null): boolean {
  if (!since) return true;
  if (!timestamp) return true;
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? true : value >= Date.parse(since) - 60_000;
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function truncate(value: string, length = 40): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export type { OutgoingMessage, MessageItem };
