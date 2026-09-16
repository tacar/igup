import type { BrokerClient } from "./broker-client.js";
import type { DataStore } from "./data-store.js";
import { messageOf } from "./engine.js";
import { nowIso } from "./ids.js";
import type { InstagramClient } from "./instagram-client.js";
import { contentTypeFor, isMissed, isDue, validatePost } from "./posts.js";
import type { ConnectionStorage } from "./storage.js";
import type { ThreadsClient } from "./threads-client.js";
import type { Connection, MediaAsset, ScheduledPost, ThreadsItem } from "./types.js";

type SchedulerDeps = {
  data: DataStore;
  secrets: ConnectionStorage;
  instagram: InstagramClient;
  threads: ThreadsClient;
  broker: BrokerClient;
  notify?: (type: string, payload?: unknown) => void;
};

const TICK_MS = 30_000;
const STATUS_POLL_MS = 5_000;
const STATUS_TIMEOUT_MS = 15 * 60_000;
const STALE_PUBLISHING_MS = 30 * 60_000;

/** Publishes scheduled posts (Instagram feed / carousel / reel / story and Threads) when they become due. */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();
  private progress = new Map<string, string>();

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    this.stop();
    this.recoverStale();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  progressOf(postId: string): string | null {
    return this.progress.get(postId) ?? null;
  }

  private recoverStale(): void {
    const now = Date.now();
    this.deps.data.update((data) => {
      for (const post of data.posts) {
        if (post.status === "publishing" && now - Date.parse(post.updatedAt) > STALE_PUBLISHING_MS) {
          post.status = "failed";
          post.error = "投稿処理の途中でアプリが終了しました。もう一度お試しください。";
          post.updatedAt = nowIso();
        }
      }
    }, "posts:changed");
  }

  async tick(): Promise<void> {
    const data = this.deps.data.get();
    const now = Date.now();
    for (const post of data.posts) {
      if (!isDue(post, now) || this.inFlight.has(post.id)) continue;
      if (isMissed(post, data.settings.missedGraceMinutes, now)) {
        this.deps.data.update(() => {
          post.status = "missed";
          post.error = "予定時刻にアプリが起動していなかったため投稿できませんでした。";
          post.updatedAt = nowIso();
        }, "posts:changed");
        this.deps.data.log("warn", "post", `予約投稿を見送りました（${post.caption.slice(0, 20) || post.kind}）`, "予定時刻からの猶予時間を超えていました。「今すぐ投稿」で手動投稿できます。");
        continue;
      }
      await this.publish(post.id);
    }
  }

  /** Publishes one post immediately regardless of its scheduled time. */
  async publish(postId: string): Promise<ScheduledPost> {
    const post = this.deps.data.get().posts.find((candidate) => candidate.id === postId);
    if (!post) throw new Error("投稿が見つかりません。");
    if (this.inFlight.has(postId)) throw new Error("この投稿はすでに処理中です。");
    const problems = validatePost(post);
    if (problems.length > 0) {
      this.fail(post, problems.join(" "));
      return post;
    }
    this.inFlight.add(postId);
    this.deps.data.update(() => {
      post.status = "publishing";
      post.error = null;
      post.attempts += 1;
      post.updatedAt = nowIso();
    }, "posts:changed");
    this.setProgress(post.id, "準備中…");
    try {
      const result = post.kind === "threads" ? await this.publishThreads(post) : await this.publishInstagram(post);
      this.deps.data.update((data) => {
        post.status = "published";
        post.publishedId = result.id;
        post.permalink = result.permalink;
        post.publishedAt = nowIso();
        post.error = null;
        post.updatedAt = nowIso();
        if (post.attachRuleId && post.kind !== "threads" && post.kind !== "story") {
          const rule = data.rules.find((candidate) => candidate.id === post.attachRuleId);
          if (rule && !rule.mediaIds.includes(result.id)) rule.mediaIds.push(result.id);
        }
      }, "posts:changed");
      this.deps.data.log("info", "post", `投稿しました（${labelOf(post)}）`, result.permalink ?? result.id);
    } catch (cause) {
      this.fail(post, messageOf(cause));
    } finally {
      this.inFlight.delete(postId);
      this.progress.delete(postId);
      await this.cleanupBrokerMedia(post);
      this.deps.notify?.("posts:changed");
    }
    return post;
  }

  private fail(post: ScheduledPost, error: string): void {
    this.deps.data.update(() => {
      post.status = "failed";
      post.error = error;
      post.updatedAt = nowIso();
    }, "posts:changed");
    this.deps.data.log("error", "post", `投稿に失敗しました（${labelOf(post)}）`, error);
  }

  private setProgress(postId: string, text: string): void {
    this.progress.set(postId, text);
    this.deps.notify?.("posts:progress", { postId, text });
  }

  // ---------------------------------------------------------------- Instagram

  private async publishInstagram(post: ScheduledPost): Promise<{ id: string; permalink: string | null }> {
    const connection = await this.deps.secrets.load("instagram", post.accountId);
    if (!connection) throw new Error("Instagramに接続されていません。");
    let containerId: string;
    switch (post.kind) {
      case "image": {
        const url = await this.publicUrl(connection, post.media[0]!);
        this.setProgress(post.id, "コンテナを作成中…");
        containerId = (await this.deps.instagram.createContainer(connection, { image_url: url, caption: post.caption })).id;
        break;
      }
      case "carousel": {
        const children: string[] = [];
        for (const [index, asset] of post.media.entries()) {
          this.setProgress(post.id, `${index + 1}/${post.media.length}枚目を準備中…`);
          children.push(await this.createChild(connection, post, asset));
        }
        for (const child of children) await this.waitForContainer(connection, child, post.id);
        this.setProgress(post.id, "カルーセルを作成中…");
        containerId = (await this.deps.instagram.createContainer(connection, { media_type: "CAROUSEL", children: children.join(","), caption: post.caption })).id;
        break;
      }
      case "reel": {
        const video = post.media[0]!;
        const parameters: Record<string, string> = { media_type: "REELS", caption: post.caption, share_to_feed: post.shareToFeed ? "true" : "false" };
        if (post.cover) parameters.cover_url = await this.publicUrl(connection, post.cover);
        containerId = await this.createVideoContainer(connection, post, video, parameters);
        break;
      }
      case "story": {
        const asset = post.media[0]!;
        if (asset.kind === "video") {
          containerId = await this.createVideoContainer(connection, post, asset, { media_type: "STORIES" });
        } else {
          const url = await this.publicUrl(connection, asset);
          containerId = (await this.deps.instagram.createContainer(connection, { media_type: "STORIES", image_url: url })).id;
        }
        break;
      }
      default:
        throw new Error("未対応の投稿種別です。");
    }
    await this.waitForContainer(connection, containerId, post.id);
    this.setProgress(post.id, "公開中…");
    const published = await this.deps.instagram.publishContainer(connection, containerId);
    let permalink: string | null = null;
    try {
      permalink = (await this.deps.instagram.getMedia(connection, published.id)).permalink ?? null;
    } catch {
      permalink = null;
    }
    return { id: published.id, permalink };
  }

  private async createChild(connection: Connection, post: ScheduledPost, asset: MediaAsset): Promise<string> {
    if (asset.kind === "video") {
      return this.createVideoContainer(connection, post, asset, { media_type: "VIDEO", is_carousel_item: "true" });
    }
    const url = await this.publicUrl(connection, asset);
    return (await this.deps.instagram.createContainer(connection, { image_url: url, is_carousel_item: "true" })).id;
  }

  /** Videos go through Meta's resumable upload from the PC; a remote HTTPS URL is used as-is. */
  private async createVideoContainer(connection: Connection, post: ScheduledPost, asset: MediaAsset, parameters: Record<string, string>): Promise<string> {
    if (asset.url && !asset.localPath) {
      return (await this.deps.instagram.createContainer(connection, { ...parameters, video_url: asset.url })).id;
    }
    this.setProgress(post.id, "動画アップロードを開始…");
    const container = await this.deps.instagram.createContainer(connection, { ...parameters, upload_type: "resumable" });
    if (!container.uri) throw new Error("Instagramが動画アップロード先を返しませんでした。");
    await this.deps.instagram.uploadVideo(connection, container.uri, asset.localPath!, (sent, total) => {
      this.setProgress(post.id, `動画をアップロード中… ${Math.round((sent / total) * 100)}%`);
    });
    return container.id;
  }

  private async waitForContainer(connection: Connection, containerId: string, postId: string): Promise<void> {
    const started = Date.now();
    for (;;) {
      const status = await this.deps.instagram.containerStatus(connection, containerId);
      const code = status.status_code ?? "";
      if (code === "FINISHED") return;
      if (code === "ERROR" || code === "EXPIRED") throw new Error(`Instagram側の処理に失敗しました（${status.status ?? code}）。`);
      if (Date.now() - started > STATUS_TIMEOUT_MS) throw new Error("Instagram側の処理が完了しませんでした（15分）。");
      this.setProgress(postId, "Instagramが処理中…");
      await sleep(STATUS_POLL_MS);
    }
  }

  // ---------------------------------------------------------------- Threads

  private async publishThreads(post: ScheduledPost): Promise<{ id: string; permalink: string | null }> {
    const connection = await this.deps.secrets.load("threads", post.accountId);
    if (!connection) throw new Error("Threadsに接続されていません。設定画面から接続してください。");
    const instagramConnection = await this.deps.secrets.load("instagram", post.accountId);
    let previousId: string | null = null;
    let rootId: string | null = null;
    for (const [index, item] of post.threads.entries()) {
      this.setProgress(post.id, post.threads.length > 1 ? `${index + 1}/${post.threads.length}件目を投稿中…` : "投稿中…");
      const containerId = await this.createThreadsContainer(connection, instagramConnection, post, item, previousId);
      await this.waitForThreadsContainer(connection, containerId);
      const published = await this.deps.threads.publish(connection, containerId);
      previousId = published.id;
      rootId ??= published.id;
    }
    let permalink: string | null = null;
    try {
      permalink = (await this.deps.threads.getPost(connection, rootId!)).permalink ?? null;
    } catch {
      permalink = null;
    }
    return { id: rootId!, permalink };
  }

  private async createThreadsContainer(connection: Connection, uploadConnection: Connection | null, post: ScheduledPost, item: ThreadsItem, replyTo: string | null): Promise<string> {
    const base: Record<string, string> = {};
    if (item.text.trim()) base.text = item.text;
    if (replyTo) base.reply_to_id = replyTo;
    if (item.media.length === 0) {
      return (await this.deps.threads.createContainer(connection, { ...base, media_type: "TEXT" })).id;
    }
    if (item.media.length === 1) {
      const asset = item.media[0]!;
      const url = await this.publicUrl(uploadConnection, asset, post);
      return (await this.deps.threads.createContainer(connection, {
        ...base,
        media_type: asset.kind === "video" ? "VIDEO" : "IMAGE",
        ...(asset.kind === "video" ? { video_url: url } : { image_url: url }),
      })).id;
    }
    const children: string[] = [];
    for (const asset of item.media) {
      const url = await this.publicUrl(uploadConnection, asset, post);
      const child = await this.deps.threads.createContainer(connection, {
        media_type: asset.kind === "video" ? "VIDEO" : "IMAGE",
        ...(asset.kind === "video" ? { video_url: url } : { image_url: url }),
        is_carousel_item: "true",
      });
      await this.waitForThreadsContainer(connection, child.id);
      children.push(child.id);
    }
    return (await this.deps.threads.createContainer(connection, { ...base, media_type: "CAROUSEL", children: children.join(",") })).id;
  }

  private async waitForThreadsContainer(connection: Connection, containerId: string): Promise<void> {
    const started = Date.now();
    for (;;) {
      const status = await this.deps.threads.status(connection, containerId);
      if (status.status === "FINISHED" || status.status === "PUBLISHED") return;
      if (status.status === "ERROR" || status.status === "EXPIRED") throw new Error(`Threads側の処理に失敗しました（${status.error_message ?? status.status}）。`);
      if (Date.now() - started > STATUS_TIMEOUT_MS) throw new Error("Threads側の処理が完了しませんでした（15分）。");
      await sleep(STATUS_POLL_MS);
    }
  }

  // ---------------------------------------------------------------- media hosting

  /** Instagram and Threads fetch images from a public HTTPS URL; local files are hosted temporarily by the broker. */
  private async publicUrl(connection: Connection | null, asset: MediaAsset, post?: ScheduledPost): Promise<string> {
    if (asset.url && /^https:\/\//.test(asset.url)) return asset.url;
    if (!asset.localPath) throw new Error(`「${asset.fileName}」のファイルが見つかりません。`);
    if (!connection) throw new Error("画像を一時公開するにはInstagramへの接続が必要です。");
    if (post) this.setProgress(post.id, `「${asset.fileName}」を一時アップロード中…`);
    const uploaded = await this.deps.broker.uploadFile(connection, asset.localPath, contentTypeFor(asset.fileName), asset.fileName);
    this.deps.data.update(() => {
      asset.brokerId = uploaded.id;
      asset.url = uploaded.url;
    });
    return uploaded.url;
  }

  private async cleanupBrokerMedia(post: ScheduledPost): Promise<void> {
    const connection = await this.deps.secrets.load("instagram", post.accountId).catch(() => null);
    if (!connection) return;
    const assets = [...post.media, ...(post.cover ? [post.cover] : []), ...post.threads.flatMap((item) => item.media)];
    for (const asset of assets) {
      if (!asset.brokerId) continue;
      try {
        await this.deps.broker.deleteMedia(connection, asset.brokerId);
      } catch {
        // the broker sweeps leftovers after 24 hours anyway
      }
      this.deps.data.update(() => {
        asset.brokerId = null;
        if (asset.localPath) asset.url = null;
      });
    }
  }
}

function labelOf(post: ScheduledPost): string {
  const text = post.kind === "threads" ? post.threads[0]?.text ?? "" : post.caption;
  const snippet = text.replace(/\s+/g, " ").trim().slice(0, 24);
  return snippet ? `${snippet}…` : post.kind;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
