import type { BrokerClient } from "./broker-client.js";
import type { DataStore } from "./data-store.js";
import { newId, nowIso } from "./ids.js";
import { InstagramApiError, type CommentItem, type InstagramClient, type MessageItem } from "./instagram-client.js";
import { cooldownKey, decodeChainPayload, findMatchingRules, findQuickReplyByTitle, isCoolingDown, pickReply, withinMessagingWindow } from "./rules.js";
import type { ConnectionStorage } from "./storage.js";
import { DEFAULT_ACCOUNT_ID, type Account, type BrokerEvent, type Connection, type Contact, type OutgoingMessage, type Rule, type RuleSource, type Settings } from "./types.js";

export type EngineStatus = {
  running: boolean;
  enabled: boolean;
  lastPollAt: string | null;
  lastBrokerPollAt: string | null;
  lastError: string | null;
  webhookMode: boolean;
  pollingActive: boolean;
  backoffUntil: string | null;
  accounts: { accountId: string; lastError: string | null; backoffUntil: string | null }[];
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
 * Instagram's app-scoped user ids can collide between accounts, so stored keys are
 * prefixed with the local account id everywhere (seen ids, contacts, cooldown owners).
 */
export function scopedKey(accountId: string, id: string): string {
  return `${accountId}:${id}`;
}

/**
 * The automation engine watches comments / DMs / story replies (via broker webhooks when
 * available, otherwise by polling the Instagram API) and answers according to the rules.
 * Every connected account is processed independently: one account's rate limit or dead
 * token never stops the others.
 */
export class AutomationEngine {
  private pollTimer: NodeJS.Timeout | null = null;
  private brokerTimer: NodeJS.Timeout | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private draining = false;
  private accountCache = new Map<string, Account>();
  private backoffs = new Map<string, number>();
  private tokenChecks = new Map<string, number>();
  private liveUnsupportedAccounts = new Set<string>();
  private errors = new Map<string, string>();
  private webhookMode = false;
  private lastPollAt: string | null = null;
  private lastBrokerPollAt: string | null = null;

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
    const accountIds = new Set<string>([...this.accountCache.keys(), ...this.errors.keys(), ...this.backoffs.keys()]);
    const accounts = [...accountIds].map((accountId) => {
      const backoffUntil = this.backoffs.get(accountId) ?? 0;
      return {
        accountId,
        lastError: this.errors.get(accountId) ?? null,
        backoffUntil: backoffUntil > Date.now() ? new Date(backoffUntil).toISOString() : null,
      };
    });
    return {
      running: this.pollTimer !== null,
      enabled: settings.automationEnabled,
      lastPollAt: this.lastPollAt,
      lastBrokerPollAt: this.lastBrokerPollAt,
      lastError: this.errors.values().next().value ?? null,
      webhookMode: this.webhookMode,
      pollingActive: this.pollingActive(settings.pollingMode),
      backoffUntil: this.earliestBackoff(),
      accounts,
    };
  }

  private earliestBackoff(): string | null {
    const pending = [...this.backoffs.values()].filter((until) => until > Date.now());
    if (pending.length === 0) return null;
    return new Date(Math.min(...pending)).toISOString();
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

  /** Every local account that currently has an Instagram connection, in stored order. */
  private async connectedAccounts(): Promise<{ accountId: string; connection: Connection }[]> {
    const accounts = this.deps.data.get().accounts;
    const result: { accountId: string; connection: Connection }[] = [];
    for (const account of accounts) {
      const connection = await this.deps.secrets.load("instagram", account.id);
      if (connection) result.push({ accountId: account.id, connection });
    }
    if (accounts.length === 0) {
      // data without account entries (fresh install mid-connect) — fall back to the default slot
      const connection = await this.deps.secrets.load("instagram", DEFAULT_ACCOUNT_ID);
      if (connection) result.push({ accountId: DEFAULT_ACCOUNT_ID, connection });
    }
    return result;
  }

  private async ensureAccount(accountId: string, connection: Connection): Promise<Account> {
    const cached = this.accountCache.get(accountId);
    if (cached) return cached;
    const account = await this.deps.instagram.getAccount(connection);
    this.accountCache.set(accountId, account);
    return account;
  }

  invalidateAccount(accountId?: string): void {
    if (accountId === undefined) this.accountCache.clear();
    else this.accountCache.delete(accountId);
  }

  // ---------------------------------------------------------------- polling

  async pollInstagram(force = false): Promise<void> {
    const data = this.deps.data.get();
    if (!data.settings.automationEnabled || this.polling) return;
    if (!force && !this.pollingActive(data.settings.pollingMode)) return;
    const targets = await this.connectedAccounts();
    if (targets.length === 0) return;
    this.polling = true;
    try {
      for (const target of targets) {
        if (Date.now() < (this.backoffs.get(target.accountId) ?? 0)) continue;
        try {
          await this.pollAccount(target.accountId, target.connection, data.settings);
          this.errors.delete(target.accountId);
        } catch (cause) {
          this.recordError(cause, "Instagramの確認に失敗しました", target.accountId);
        }
      }
      this.lastPollAt = nowIso();
    } finally {
      this.polling = false;
      this.deps.notify?.("automation:status", this.status());
    }
  }

  private async pollAccount(accountId: string, connection: Connection, settings: Settings): Promise<void> {
    const account = await this.ensureAccount(accountId, connection);
    await this.maybeRefreshToken(accountId, connection);
    await this.pollComments(accountId, connection, account, settings);
    await this.pollConversations(accountId, connection, account);
    if (settings.liveCommentsEnabled && !this.liveUnsupportedAccounts.has(accountId)) await this.pollLive(accountId, connection, account);
  }

  private async pollComments(accountId: string, connection: Connection, account: Account, settings: Settings): Promise<void> {
    const media = await this.deps.instagram.listMediaWithComments(connection, settings.recentMediaCount);
    for (const item of media.data) {
      for (const comment of item.comments?.data ?? []) {
        await this.handleComment(accountId, comment, item.id, "comment", account);
      }
    }
  }

  private async pollLive(accountId: string, connection: Connection, account: Account): Promise<void> {
    let lives: { data: { id: string; status?: string }[] };
    try {
      lives = await this.deps.instagram.listLiveMedia(connection);
    } catch (cause) {
      this.liveUnsupportedAccounts.add(accountId);
      this.deps.data.log("warn", "system", "ライブ配信コメントの取得に対応していないアカウントのため、このアカウントのライブ監視を停止しました", messageOf(cause));
      return;
    }
    for (const live of lives.data) {
      const comments = await this.deps.instagram.listComments(connection, live.id);
      for (const comment of comments.data) await this.handleComment(accountId, comment, live.id, "live", account);
    }
  }

  private async pollConversations(accountId: string, connection: Connection, account: Account): Promise<void> {
    const conversations = await this.deps.instagram.listConversations(connection);
    for (const conversation of conversations.data) {
      for (const message of conversation.messages?.data ?? []) {
        const senderId = message.from?.id;
        if (!senderId) continue;
        await this.handleMessage(accountId, {
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
    const targets = await this.connectedAccounts();
    if (targets.length === 0) return;
    this.draining = true;
    try {
      for (const target of targets) {
        try {
          await this.drainAccount(target.accountId, target.connection);
        } catch (cause) {
          // The broker being unreachable is not fatal for polling mode; surface it in the status.
          this.errors.set(target.accountId, messageOf(cause));
        }
      }
      this.lastBrokerPollAt = nowIso();
    } finally {
      this.draining = false;
    }
  }

  private async drainAccount(accountId: string, connection: Connection): Promise<void> {
    const account = await this.ensureAccount(accountId, connection);
    let cursor = this.deps.data.get().cursors[accountId] ?? 0;
    for (let round = 0; round < 10; round += 1) {
      const batch = await this.deps.broker.events(connection, cursor);
      for (const event of batch.events) {
        try {
          if (event.type === "webhook") await this.handleWebhook(event.payload as { entry?: WebhookEntry[] }, account, accountId);
          else await this.deps.onBrokerEvent?.(event);
        } catch (cause) {
          this.deps.data.log("error", "system", "受信イベントの処理に失敗しました", messageOf(cause));
        }
        cursor = Math.max(cursor, event.id);
      }
      this.deps.data.update((data) => {
        data.cursors[accountId] = cursor;
      });
      if (batch.events.length === 0) break;
    }
  }

  async handleWebhook(payload: { entry?: WebhookEntry[] }, account: Account, accountId: string): Promise<void> {
    if (!this.deps.data.get().settings.automationEnabled) return;
    for (const entry of payload.entry ?? []) {
      for (const messaging of entry.messaging ?? []) {
        const senderId = messaging.sender?.id;
        if (!senderId || senderId === account.id || senderId === account.user_id) continue;
        if (messaging.message && !messaging.message.is_echo) {
          await this.handleMessage(accountId, {
            id: messaging.message.mid ?? newId("mid"),
            senderId,
            username: null,
            text: messaging.message.text ?? "",
            createdAt: messaging.timestamp ? new Date(messaging.timestamp).toISOString() : nowIso(),
            isStoryReply: Boolean(messaging.message.reply_to?.story),
            quickReplyPayload: messaging.message.quick_reply?.payload ?? null,
          }, account);
        } else if (messaging.postback) {
          await this.handlePostback(accountId, senderId, messaging.postback.payload ?? "", messaging.postback.title ?? "");
        } else if (messaging.read) {
          this.handleRead(accountId, senderId, messaging.timestamp ? new Date(messaging.timestamp).toISOString() : nowIso());
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
        await this.handleComment(accountId, comment, value.media?.id ?? "", change.field === "live_comments" ? "live" : "comment", account);
      }
    }
  }

  // ---------------------------------------------------------------- handlers

  private async handleComment(accountId: string, comment: CommentItem, mediaId: string, source: "comment" | "live", account: Account): Promise<void> {
    const data = this.deps.data.get();
    if (!comment.id || this.deps.data.hasSeen("comments", scopedKey(accountId, comment.id))) return;
    this.deps.data.markSeen("comments", scopedKey(accountId, comment.id));
    const authorId = comment.from?.id ?? "";
    if (!authorId || authorId === account.id || authorId === account.user_id) return;
    if (comment.parent_id) return; // replies to comments are not entry points
    if (!isAfter(comment.timestamp, data.automationSince)) return;
    const text = comment.text ?? "";
    const rules = findMatchingRules(data.rules.filter((rule) => rule.accountId === accountId), { source, text, mediaId });
    if (rules.length === 0) return;
    this.deps.data.log("info", "inbound", `${source === "live" ? "ライブ" : ""}コメント「${truncate(text)}」`, `@${comment.username ?? comment.from?.username ?? authorId} / 投稿 ${mediaId}`);
    for (const rule of rules) {
      await this.executeRule(rule, { source, userId: authorId, username: comment.username ?? comment.from?.username ?? null, commentId: comment.id, text });
    }
  }

  private async handleMessage(accountId: string, message: { id: string; senderId: string; username: string | null; text: string; createdAt: string; isStoryReply: boolean; quickReplyPayload: string | null }, account: Account): Promise<void> {
    const data = this.deps.data.get();
    if (message.senderId === account.id || message.senderId === account.user_id) return;
    if (this.deps.data.hasSeen("messages", scopedKey(accountId, message.id))) return;
    this.deps.data.markSeen("messages", scopedKey(accountId, message.id));
    this.touchContact(accountId, message.senderId, { username: message.username, lastInboundAt: message.createdAt });
    if (!isAfter(message.createdAt, data.automationSince)) return;

    const chain = decodeChainPayload(message.quickReplyPayload) ?? findQuickReplyByTitle(data.rules.filter((rule) => rule.accountId === accountId), message.text);
    if (chain) {
      await this.followChain(message.senderId, chain, message.text);
      return;
    }
    const source: RuleSource = message.isStoryReply ? "story" : "dm";
    const rules = findMatchingRules(data.rules.filter((rule) => rule.accountId === accountId), { source, text: message.text });
    if (rules.length === 0) return;
    this.deps.data.log("info", "inbound", `${source === "story" ? "ストーリーズ返信" : "DM"}「${truncate(message.text)}」`, `@${message.username ?? message.senderId}`);
    for (const rule of rules) {
      await this.executeRule(rule, { source, userId: message.senderId, username: message.username, commentId: null, text: message.text });
    }
  }

  private async handlePostback(accountId: string, senderId: string, payload: string, title: string): Promise<void> {
    const chain = decodeChainPayload(payload);
    this.touchContact(accountId, senderId, { lastInboundAt: nowIso() });
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

  private handleRead(accountId: string, senderId: string, at: string): void {
    const data = this.deps.data.get();
    const contact = data.contacts[scopedKey(accountId, senderId)];
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
    const connection = await this.deps.secrets.load("instagram", rule.accountId);
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
            accountId: rule.accountId,
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
      const contact = ensureContact(data.contacts, scopedKey(rule.accountId, recipientId));
      if (username) contact.username = username;
      contact.lastOutboundAt = nowIso();
      contact.lastOutboundRuleId = rule.id;
      contact.readCounted = false;
    }, "rules:changed");
  }

  private touchContact(accountId: string, id: string, patch: Partial<Contact>): void {
    this.deps.data.update((data) => {
      const contact = ensureContact(data.contacts, scopedKey(accountId, id));
      if (patch.username) contact.username = patch.username;
      if (patch.lastInboundAt) contact.lastInboundAt = patch.lastInboundAt;
    });
  }

  // ---------------------------------------------------------------- follow-ups (時間差送信)

  async processPending(): Promise<void> {
    const data = this.deps.data.get();
    if (!data.settings.automationEnabled || data.pending.length === 0) return;
    const now = Date.now();
    const due = data.pending.filter((item) => Date.parse(item.dueAt) <= now);
    for (const item of due) {
      const connection = await this.deps.secrets.load("instagram", item.accountId);
      if (!connection) continue;
      const rule = data.rules.find((candidate) => candidate.id === item.ruleId);
      const contact = data.contacts[scopedKey(item.accountId, item.recipientId)];
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

  private async maybeRefreshToken(accountId: string, connection: Connection): Promise<void> {
    if (Date.now() - (this.tokenChecks.get(accountId) ?? 0) < 6 * 3_600_000) return;
    this.tokenChecks.set(accountId, Date.now());
    if (!connection.expiresAt || Date.parse(connection.expiresAt) - Date.now() > TOKEN_REFRESH_WINDOW_MS) return;
    try {
      const refreshed = await this.deps.instagram.refreshToken(connection);
      await this.deps.secrets.save(refreshed, "instagram", accountId);
      this.deps.data.log("info", "system", "Instagramのアクセストークンを更新しました", `新しい期限: ${refreshed.expiresAt ?? "不明"}`);
      this.deps.notify?.("connection:changed");
    } catch (cause) {
      this.deps.data.log("warn", "system", "アクセストークンの更新に失敗しました", messageOf(cause));
    }
  }

  private recordError(cause: unknown, title: string, accountId: string): void {
    const message = messageOf(cause);
    this.errors.set(accountId, message);
    if (cause instanceof InstagramApiError && cause.isRateLimit) {
      this.backoffs.set(accountId, Date.now() + 15 * 60_000);
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
    const rule = this.deps.data.get().rules.find((candidate) => candidate.id === ruleId);
    if (!rule?.message) throw new Error("このルールにはDM本文がありません。");
    const connection = await this.deps.secrets.load("instagram", rule.accountId);
    if (!connection) throw new Error("先にInstagramへ接続してください。");
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
