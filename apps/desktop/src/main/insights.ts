import type { DataStore } from "./data-store.js";
import { messageOf } from "./engine.js";
import { localDateKey, nowIso } from "./ids.js";
import type { InsightValue, InstagramClient } from "./instagram-client.js";
import type { ConnectionStorage } from "./storage.js";
import { DEFAULT_ACCOUNT_ID, type AccountSnapshot, type Connection, type MediaSnapshot, type StorySnapshot } from "./types.js";

type InsightsDeps = {
  data: DataStore;
  secrets: ConnectionStorage;
  instagram: InstagramClient;
  notify?: (type: string, payload?: unknown) => void;
};

const TICK_MS = 5 * 60_000;
const DAILY_HOUR = 3;
const MEDIA_SNAPSHOT_DAYS = 120;
const MEDIA_METRICS = "views,reach,likes,comments,saved,shares,total_interactions";
const STORY_METRICS = "views,reach,replies,shares,navigation,total_interactions,follows";
const STORY_METRICS_FALLBACK = "reach,replies,shares";

export type InsightsSummary = {
  latest: AccountSnapshot | null;
  followerSeries: { date: string; followers: number | null; reach: number | null }[];
  topMedia: MediaSnapshot[];
  stories: StorySnapshot[];
  lastInsightsDate: string | null;
  lastStorySnapshotAt: string | null;
};

/** Collects account, media and story insights so they survive after stories disappear. */
export class InsightsCollector {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly deps: InsightsDeps) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const data = this.deps.data.get();
    if (!data.settings.insightsEnabled || this.busy) return;
    const now = new Date();
    const today = localDateKey(now);
    const owners = data.accounts.length > 0 ? data.accounts.map((account) => account.id) : [DEFAULT_ACCOUNT_ID];
    const dailyDue = owners.some((id) => {
      const last = data.lastInsightsDate[id];
      return (!last || last !== today) && now.getHours() >= DAILY_HOUR;
    });
    if (dailyDue) await this.captureDaily();
    const storyDue = owners.some((id) => {
      const last = data.lastStorySnapshotAt[id];
      return !last || now.getTime() - Date.parse(last) >= data.settings.storySnapshotIntervalMin * 60_000;
    });
    if (storyDue) await this.captureStories();
  }

  /** Accounts with an Instagram connection, in stored order. */
  private async connectedAccounts(): Promise<{ accountId: string; connection: Connection }[]> {
    const data = this.deps.data.get();
    const result: { accountId: string; connection: Connection }[] = [];
    for (const account of data.accounts) {
      const connection = await this.deps.secrets.load("instagram", account.id);
      if (connection) result.push({ accountId: account.id, connection });
    }
    if (data.accounts.length === 0) {
      const connection = await this.deps.secrets.load("instagram", DEFAULT_ACCOUNT_ID);
      if (connection) result.push({ accountId: DEFAULT_ACCOUNT_ID, connection });
    }
    return result;
  }

  async captureDaily(): Promise<void> {
    const targets = await this.connectedAccounts();
    if (targets.length === 0) return;
    this.busy = true;
    try {
      for (const target of targets) {
        try {
          await this.captureAccount(target.accountId, target.connection);
          await this.captureMedia(target.accountId, target.connection);
          this.deps.data.update((data) => {
            data.lastInsightsDate[target.accountId] = localDateKey();
          }, "insights:changed");
          this.deps.data.log("info", "insights", "インサイトを取得しました", localDateKey());
        } catch (cause) {
          this.deps.data.log("warn", "insights", "インサイトの取得に失敗しました", messageOf(cause));
        }
      }
    } finally {
      this.busy = false;
      this.deps.notify?.("insights:changed");
    }
  }

  private async captureAccount(accountId: string, connection: Connection): Promise<void> {
    const account = await this.deps.instagram.getAccount(connection);
    const snapshot: AccountSnapshot = {
      accountId,
      date: localDateKey(),
      capturedAt: nowIso(),
      followers: account.followers_count ?? null,
      following: account.follows_count ?? null,
      mediaCount: account.media_count ?? null,
      reach: null,
      profileViews: null,
      accountsEngaged: null,
      websiteClicks: null,
    };
    try {
      const reach = await this.deps.instagram.accountInsights(connection, { metric: "reach", period: "day" });
      snapshot.reach = latestValue(reach.data.find((item) => item.name === "reach"));
    } catch {
      snapshot.reach = null;
    }
    try {
      const totals = await this.deps.instagram.accountInsights(connection, { metric: "profile_views,accounts_engaged,website_clicks", period: "day", metric_type: "total_value" });
      snapshot.profileViews = totalValue(totals.data.find((item) => item.name === "profile_views"));
      snapshot.accountsEngaged = totalValue(totals.data.find((item) => item.name === "accounts_engaged"));
      snapshot.websiteClicks = totalValue(totals.data.find((item) => item.name === "website_clicks"));
    } catch {
      // these metrics need the insights permission; keep the follower count anyway
    }
    this.deps.data.update((data) => {
      data.accountSnapshots = data.accountSnapshots.filter((item) => !(item.accountId === snapshot.accountId && item.date === snapshot.date));
      data.accountSnapshots.push(snapshot);
      data.accountSnapshots.sort((a, b) => a.date.localeCompare(b.date));
      if (data.accountSnapshots.length > 400) data.accountSnapshots.splice(0, data.accountSnapshots.length - 400);
    });
  }

  private async captureMedia(accountId: string, connection: Connection): Promise<void> {
    const media = await this.deps.instagram.listMedia(connection, 50);
    const date = localDateKey();
    const snapshots: MediaSnapshot[] = [];
    for (const item of media.data) {
      let metrics: Record<string, number> = {};
      try {
        const result = await this.deps.instagram.mediaInsights(connection, item.id, MEDIA_METRICS);
        metrics = collectMetrics(result.data);
      } catch (cause) {
        metrics = { likes: item.like_count ?? 0, comments: item.comments_count ?? 0 };
        if (snapshots.length === 0) this.deps.data.log("warn", "insights", "投稿インサイトを取得できませんでした（いいね数・コメント数のみ記録）", messageOf(cause));
      }
      snapshots.push({
        accountId,
        mediaId: item.id,
        date,
        capturedAt: nowIso(),
        mediaType: item.media_type ?? "",
        productType: item.media_product_type ?? "",
        caption: (item.caption ?? "").slice(0, 200),
        permalink: item.permalink ?? null,
        thumbnailUrl: item.thumbnail_url ?? item.media_url ?? null,
        timestamp: item.timestamp ?? null,
        metrics,
      });
    }
    const cutoff = Date.now() - MEDIA_SNAPSHOT_DAYS * 86_400_000;
    this.deps.data.update((data) => {
      data.mediaSnapshots = data.mediaSnapshots.filter((item) => !(item.date === date && snapshots.some((s) => s.mediaId === item.mediaId)) && Date.parse(item.capturedAt) > cutoff);
      data.mediaSnapshots.push(...snapshots);
    });
  }

  async captureStories(): Promise<void> {
    const targets = await this.connectedAccounts();
    if (targets.length === 0) return;
    this.busy = true;
    try {
      let saved = 0;
      for (const target of targets) {
        try {
          saved += await this.captureAccountStories(target.accountId, target.connection);
        } catch (cause) {
          this.deps.data.log("warn", "insights", "ストーリーズのスナップショットに失敗しました", messageOf(cause));
          this.deps.data.update((data) => {
            data.lastStorySnapshotAt[target.accountId] = nowIso();
          });
        }
      }
      if (saved > 0) this.deps.data.log("info", "insights", `ストーリーズ${saved}件のスナップショットを保存しました`);
    } finally {
      this.busy = false;
      this.deps.notify?.("insights:changed");
    }
  }

  private async captureAccountStories(accountId: string, connection: Connection): Promise<number> {
    const stories = await this.deps.instagram.listStories(connection);
    const snapshots: StorySnapshot[] = [];
    for (const story of stories.data) {
      let metrics: Record<string, number> = {};
      try {
        metrics = collectMetrics((await this.deps.instagram.mediaInsights(connection, story.id, STORY_METRICS)).data);
      } catch {
        try {
          metrics = collectMetrics((await this.deps.instagram.mediaInsights(connection, story.id, STORY_METRICS_FALLBACK)).data);
        } catch {
          metrics = {};
        }
      }
      snapshots.push({
        accountId,
        storyId: story.id,
        capturedAt: nowIso(),
        timestamp: story.timestamp ?? null,
        mediaType: story.media_type ?? "",
        mediaUrl: story.media_url ?? null,
        metrics,
      });
    }
    this.deps.data.update((data) => {
      for (const snapshot of snapshots) {
        const index = data.storySnapshots.findIndex((item) => item.accountId === accountId && item.storyId === snapshot.storyId);
        if (index >= 0) data.storySnapshots[index] = snapshot;
        else data.storySnapshots.unshift(snapshot);
      }
      if (data.storySnapshots.length > 500) data.storySnapshots.length = 500;
      data.lastStorySnapshotAt[accountId] = nowIso();
    }, "insights:changed");
    return snapshots.length;
  }

  summary(accountId?: string): InsightsSummary {
    const data = this.deps.data.get();
    const owner = accountId ?? data.activeAccountId ?? DEFAULT_ACCOUNT_ID;
    const latestByMedia = new Map<string, MediaSnapshot>();
    for (const snapshot of data.mediaSnapshots) {
      if (snapshot.accountId !== owner) continue;
      const current = latestByMedia.get(snapshot.mediaId);
      if (!current || current.date < snapshot.date) latestByMedia.set(snapshot.mediaId, snapshot);
    }
    const topMedia = [...latestByMedia.values()]
      .sort((a, b) => score(b) - score(a))
      .slice(0, 10);
    const followerSeries = data.accountSnapshots.filter((item) => item.accountId === owner).slice(-60).map((item) => ({ date: item.date, followers: item.followers, reach: item.reach }));
    return {
      latest: data.accountSnapshots.filter((item) => item.accountId === owner).at(-1) ?? null,
      followerSeries,
      topMedia,
      stories: data.storySnapshots.filter((item) => item.accountId === owner).slice(0, 50),
      lastInsightsDate: data.lastInsightsDate[owner] ?? null,
      lastStorySnapshotAt: data.lastStorySnapshotAt[owner] ?? null,
    };
  }
}

function score(snapshot: MediaSnapshot): number {
  return snapshot.metrics.views ?? snapshot.metrics.reach ?? snapshot.metrics.total_interactions ?? snapshot.metrics.likes ?? 0;
}

function collectMetrics(values: InsightValue[]): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const item of values) {
    const value = totalValue(item) ?? latestValue(item);
    if (value !== null) metrics[item.name] = value;
  }
  return metrics;
}

function totalValue(item: InsightValue | undefined): number | null {
  const value = item?.total_value?.value;
  return typeof value === "number" ? value : null;
}

function latestValue(item: InsightValue | undefined): number | null {
  const value = item?.values?.at(-1)?.value;
  if (typeof value === "number") return value;
  if (value && typeof value === "object") return Object.values(value).reduce((sum, part) => sum + part, 0);
  return null;
}
