import { randomBytes } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { AttemptStore, type Provider } from "./attempt-store.js";
import type { BrokerConfig } from "./config.js";
import { EventQueue, type PublicEvent } from "./events.js";
import { classifySource, dateKey, generateSlug, isPreviewBot, parseLinkInput, publicLink, recordClick, type PublicLink } from "./links.js";
import { MetaClient } from "./meta-client.js";
import { OwnerAuthError, OwnerResolver, ownerKeys, ownerOf, requireOwner } from "./owner-auth.js";
import { RateLimiter } from "./rate-limit.js";
import { newApplication, parseApplicationInput, parseSeminarInput, toPublicSeminar } from "./seminars.js";
import { escapeHtml, renderNotFoundPage, renderSeminarPage } from "./seminar-page.js";
import { BrokerStore, type StoredLink, type StoredSeminar } from "./store.js";
import { newId } from "./ids.js";
import { verifySignature, webhookTargets, type WebhookPayload } from "./webhook.js";

/** Mirrors the desktop's BrokerCapabilities type (apps/desktop/src/main/types.ts); kept in sync by hand since the two apps don't share a package. */
export type BrokerCapabilities = {
  webhooks: boolean;
  threads: boolean;
  media: boolean;
  links: boolean;
  seminars: boolean;
  publicBaseUrl: string;
};

export type AppDeps = {
  brokerStore?: BrokerStore;
  events?: EventQueue;
  resolver?: OwnerResolver;
  now?: () => number;
};

/** Body captured by express.json()'s verify hook, kept around only long enough to check the webhook signature. */
type WithRawBody = Request & { rawBody?: Buffer };

/** Helmet types CSP directive functions against the raw Node request/response, not Express's; `locals` is an Express addition. */
type ResponseWithLocals = ServerResponse & { locals: { cspNonce: string } };
const cspNonceSource = (_request: IncomingMessage, response: ServerResponse): string => `'nonce-${(response as ResponseWithLocals).locals.cspNonce}'`;

export function createApp(config: BrokerConfig, store = new AttemptStore(), meta = new MetaClient(config), deps: AppDeps = {}) {
  const brokerStore = deps.brokerStore ?? new BrokerStore(config.dataDir);
  const events = deps.events ?? new EventQueue(brokerStore.events, config.eventTtlHours * 3_600_000);
  const resolver = deps.resolver ?? new OwnerResolver((token) => meta.resolveOwner(token));
  const now = deps.now ?? (() => Date.now());
  const applyLimiter = new RateLimiter(5, 10 * 60_000);
  const requireOwnerAuth = requireOwner(resolver, now);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  app.use((_request, response, next) => {
    response.locals.cspNonce = randomBytes(16).toString("base64");
    next();
  });
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "script-src": ["'self'", "https://static.line-scdn.net", cspNonceSource],
          "connect-src": ["'self'", "https://api.line.me"],
          "frame-src": ["https://liff.line.me", "https://access.line.me"],
          "img-src": ["'self'", "data:", "https:"],
        },
      },
    }),
  );
  app.use(cors({ origin: config.desktopOrigin, methods: ["GET", "POST", "PUT", "DELETE"], allowedHeaders: ["Content-Type", "Authorization", "X-File-Name"] }));
  app.use(
    express.json({
      limit: "256kb",
      verify: (request, _response, buffer) => {
        (request as WithRawBody).rawBody = Buffer.from(buffer);
      },
    }),
  );

  const baseUrlFor = (request: Request): string => config.publicBaseUrl ?? `${request.protocol}://${request.get("host")}`;
  const capabilitiesOf = (): BrokerCapabilities => ({
    webhooks: Boolean(config.webhookVerifyToken && config.publicBaseUrl),
    threads: Boolean(config.threads),
    media: Boolean(config.publicBaseUrl),
    links: Boolean(config.publicBaseUrl),
    seminars: Boolean(config.publicBaseUrl),
    publicBaseUrl: config.publicBaseUrl ?? "",
  });

  async function sweepMedia(): Promise<void> {
    const media = brokerStore.state.value.media;
    const cutoff = now();
    const expired = Object.values(media).filter((item) => Date.parse(item.expiresAt) <= cutoff);
    if (expired.length === 0) return;
    for (const item of expired) {
      delete media[item.id];
      await unlink(join(brokerStore.mediaDir, item.id)).catch(() => undefined);
    }
    brokerStore.state.save();
  }
  const sweepTimer = setInterval(() => void sweepMedia(), 15 * 60_000);
  sweepTimer.unref();

  // ---- health & capabilities -------------------------------------------------
  app.get("/health", (_request, response) => response.json({ ok: true }));
  app.get("/capabilities", (_request, response) => response.json(capabilitiesOf()));

  // ---- OAuth (Instagram + optional Threads) ----------------------------------
  app.post("/oauth/start", (request, response) => {
    const provider: Provider = stringParam(request.query.provider) === "threads" ? "threads" : "instagram";
    if (provider === "threads" && !config.threads) {
      response.status(400).json({ error: "Threadsは設定されていません（THREADS_APP_ID / THREADS_APP_SECRET を設定してください）。" });
      return;
    }
    const attempt = store.create(now(), provider);
    response.json({ ...attempt, authorizationUrl: meta.authorizationUrl(attempt.state, provider) });
  });

  app.get("/oauth/callback", async (request, response) => {
    const state = stringParam(request.query.state);
    const code = stringParam(request.query.code);
    const error = stringParam(request.query.error_description) ?? stringParam(request.query.error);
    if (!state || !store.exists(state, now())) {
      response.status(400).send(resultPage("認証情報が無効か期限切れです。", false));
      return;
    }
    const provider = store.providerOf(state, now()) ?? "instagram";
    const label = provider === "threads" ? "Threads" : "Instagram";
    if (error) {
      response.status(400).send(resultPage(`${label}認証を完了できませんでした: ${escapeHtml(error)}`, false));
      return;
    }
    if (!code) {
      response.status(400).send(resultPage("認証コードがありません。", false));
      return;
    }
    try {
      const connection = await meta.exchangeCode(code, provider);
      if (!store.complete(state, connection, now())) throw new Error("Authentication attempt has expired");
      const callback = new URL(config.desktopOrigin + "/oauth/callback");
      callback.searchParams.set("state", state);
      response.redirect(callback.toString());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unknown error";
      response.status(502).send(resultPage(`Meta APIとの通信に失敗しました: ${escapeHtml(message)}`, false));
    }
  });

  app.post("/oauth/redeem", (request, response) => {
    const state = typeof request.body?.state === "string" ? request.body.state : "";
    const verifier = typeof request.body?.verifier === "string" ? request.body.verifier : "";
    const connection = store.redeem(state, verifier, now());
    if (!connection) {
      response.status(400).json({ error: "認証結果が無効か、すでに使用されています。" });
      return;
    }
    response.json(connection);
  });

  // ---- webhooks ---------------------------------------------------------------
  app.get("/webhooks/instagram", (request, response) => {
    const mode = stringParam(request.query["hub.mode"]);
    const token = stringParam(request.query["hub.verify_token"]);
    const challenge = stringParam(request.query["hub.challenge"]);
    if (mode === "subscribe" && challenge && config.webhookVerifyToken && token && safeEqualStrings(token, config.webhookVerifyToken)) {
      response.status(200).type("text/plain").send(challenge);
      return;
    }
    response.sendStatus(403);
  });

  app.post("/webhooks/instagram", (request, response) => {
    const raw = (request as WithRawBody).rawBody ?? Buffer.alloc(0);
    if (!verifySignature(raw, request.header("x-hub-signature-256"), config.appSecret)) {
      response.sendStatus(401);
      return;
    }
    const payload = (request.body ?? {}) as WebhookPayload;
    for (const entry of payload.entry ?? []) {
      const targets = webhookTargets(entry);
      if (targets.length > 0) events.push(targets, "webhook", { entry: [entry] }, now());
    }
    // Meta only cares that we acknowledged receipt; slow/failed downstream processing must never surface here.
    response.sendStatus(200);
  });

  // ---- events (desktop polling) -----------------------------------------------
  app.get("/events", requireOwnerAuth, (request, response) => {
    const owner = ownerOf(response);
    const after = Math.max(0, Math.trunc(Number(stringParam(request.query.after) ?? "0")) || 0);
    const limit = Math.min(Math.max(Math.trunc(Number(stringParam(request.query.limit) ?? "100")) || 100, 1), 500);
    const result = events.list(ownerKeys(owner), after, limit, now());
    response.json(result satisfies { events: PublicEvent[]; cursor: number });
  });

  // ---- transient media hosting --------------------------------------------------
  app.post("/media", requireOwnerAuth, express.raw({ type: () => true, limit: config.mediaMaxBytes }), async (request, response) => {
    const owner = ownerOf(response);
    const contentType = request.header("content-type") ?? "";
    if (!/^(image|video)\//i.test(contentType)) {
      response.status(400).json({ error: "画像または動画のみアップロードできます。" });
      return;
    }
    const body = request.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      response.status(400).json({ error: "ファイルが空です。" });
      return;
    }
    const fileName = decodeFileName(request.header("x-file-name"));
    await sweepMedia();
    const id = newId("media");
    const createdAt = new Date(now()).toISOString();
    const expiresAt = new Date(now() + config.mediaTtlHours * 3_600_000).toISOString();
    try {
      await writeFile(join(brokerStore.mediaDir, id), body);
    } catch (cause) {
      response.status(500).json({ error: "ファイルの保存に失敗しました。" });
      return;
    }
    brokerStore.state.value.media[id] = { id, ownerId: owner.id, fileName, contentType, size: body.length, createdAt, expiresAt };
    brokerStore.state.save();
    response.json({ id, url: `${baseUrlFor(request)}/m/${id}`, expiresAt });
  });

  app.get("/m/:id", async (request, response) => {
    const meta_ = brokerStore.state.value.media[request.params.id];
    if (!meta_ || Date.parse(meta_.expiresAt) <= now()) {
      response.status(404).send("Not found");
      return;
    }
    try {
      const bytes = await readFile(join(brokerStore.mediaDir, meta_.id));
      response.setHeader("Cache-Control", "private, max-age=3600");
      response.type(meta_.contentType).send(bytes);
    } catch {
      response.status(404).send("Not found");
    }
  });

  app.delete("/media/:id", requireOwnerAuth, async (request, response) => {
    const owner = ownerOf(response);
    const id = paramString(request.params.id);
    const meta_ = brokerStore.state.value.media[id];
    if (!meta_ || meta_.ownerId !== owner.id) {
      response.json({ ok: false });
      return;
    }
    delete brokerStore.state.value.media[id];
    brokerStore.state.save();
    await unlink(join(brokerStore.mediaDir, meta_.id)).catch(() => undefined);
    response.json({ ok: true });
  });

  // ---- tracked links ------------------------------------------------------------
  app.get("/links", requireOwnerAuth, (request, response) => {
    const owner = ownerOf(response);
    const base = baseUrlFor(request);
    const links: PublicLink[] = Object.values(brokerStore.state.value.links)
      .filter((link) => link.ownerId === owner.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((link) => publicLink(link, base));
    response.json({ links });
  });

  app.post("/links", requireOwnerAuth, (request, response) => {
    const owner = ownerOf(response);
    const parsed = parseLinkInput(request.body);
    if (!parsed.ok) {
      response.status(400).json({ error: parsed.error });
      return;
    }
    const links = brokerStore.state.value.links;
    let slug = parsed.value.slug;
    if (slug) {
      if (links[slug]) {
        response.status(400).json({ error: "その短縮名はすでに使われています。" });
        return;
      }
    } else {
      do {
        slug = generateSlug();
      } while (links[slug]);
    }
    const link: StoredLink = {
      slug,
      ownerId: owner.id,
      url: parsed.value.url,
      label: parsed.value.label,
      source: parsed.value.source,
      createdAt: new Date(now()).toISOString(),
      total: 0,
      daily: {},
      sources: {},
    };
    links[slug] = link;
    brokerStore.state.save();
    response.json({ link: publicLink(link, baseUrlFor(request)) });
  });

  app.delete("/links/:slug", requireOwnerAuth, (request, response) => {
    const owner = ownerOf(response);
    const slug = paramString(request.params.slug);
    const link = brokerStore.state.value.links[slug];
    if (!link || link.ownerId !== owner.id) {
      response.json({ ok: false });
      return;
    }
    delete brokerStore.state.value.links[slug];
    brokerStore.state.save();
    response.json({ ok: true });
  });

  app.get("/l/:slug", (request, response) => {
    const link = brokerStore.state.value.links[request.params.slug];
    if (!link) {
      response.status(404).send("Not found");
      return;
    }
    if (!isPreviewBot(request.header("user-agent"))) {
      const source = classifySource(request.query.s, request.header("referer"));
      recordClick(link, source, dateKey(now(), config.timeZone));
      brokerStore.state.save();
    }
    response.redirect(302, link.url);
  });

  // ---- seminars + LINE sign-up pages ---------------------------------------------
  app.put("/seminars/:id", requireOwnerAuth, (request, response) => {
    const owner = ownerOf(response);
    const parsed = parseSeminarInput(request.body);
    if (!parsed.ok) {
      response.status(400).json({ error: parsed.error });
      return;
    }
    const id = paramString(request.params.id);
    const seminars = brokerStore.state.value.seminars;
    const existing = seminars[id];
    if (existing && existing.ownerId !== owner.id) {
      response.status(403).json({ error: "この操作は許可されていません。" });
      return;
    }
    const createdAt = existing?.createdAt ?? new Date(now()).toISOString();
    const stored: StoredSeminar = {
      ...parsed.value,
      id,
      ownerId: owner.id,
      ownerKeys: ownerKeys(owner),
      createdAt,
      updatedAt: new Date(now()).toISOString(),
      applications: existing?.applications ?? [],
    };
    seminars[id] = stored;
    brokerStore.state.save();
    response.json({ publicUrl: `${baseUrlFor(request)}/s/${id}` });
  });

  app.delete("/seminars/:id", requireOwnerAuth, (request, response) => {
    const owner = ownerOf(response);
    const id = paramString(request.params.id);
    const seminar = brokerStore.state.value.seminars[id];
    if (!seminar || seminar.ownerId !== owner.id) {
      response.json({ ok: false });
      return;
    }
    delete brokerStore.state.value.seminars[id];
    brokerStore.state.save();
    response.json({ ok: true });
  });

  app.get("/seminars/:id/applications", requireOwnerAuth, (request, response) => {
    const owner = ownerOf(response);
    const id = paramString(request.params.id);
    const seminar = brokerStore.state.value.seminars[id];
    if (!seminar || seminar.ownerId !== owner.id) {
      response.json({ applications: [] });
      return;
    }
    response.json({ applications: seminar.applications });
  });

  app.get("/s/:id", (request, response) => {
    const seminar = brokerStore.state.value.seminars[request.params.id];
    if (!seminar) {
      response.status(404).type("html").send(renderNotFoundPage("ページが見つかりません。"));
      return;
    }
    if (!seminar.enabled) {
      response.status(410).type("html").send(renderNotFoundPage("現在このセミナーの受付は停止しています。"));
      return;
    }
    const nonce = (response.locals as { cspNonce: string }).cspNonce;
    response.type("html").send(renderSeminarPage(toPublicSeminar(seminar, baseUrlFor(request)), nonce, config.timeZone));
  });

  app.post("/s/:id/apply", (request, response) => {
    const seminar = brokerStore.state.value.seminars[request.params.id];
    if (!seminar || !seminar.enabled) {
      response.status(404).json({ error: "受付を終了しています。" });
      return;
    }
    if (!applyLimiter.allow(`${seminar.id}:${request.ip ?? "unknown"}`, now())) {
      response.status(429).json({ error: "しばらく時間をおいてから、もう一度お試しください。" });
      return;
    }
    const parsed = parseApplicationInput(request.body, seminar);
    if (!parsed.ok) {
      response.status(400).json({ error: parsed.error });
      return;
    }
    const application = newApplication(parsed.value, now());
    seminar.applications.push(application);
    brokerStore.state.save();
    events.push(seminar.ownerKeys, "seminar.application", { seminarId: seminar.id, application }, now());
    response.json({ ok: true });
  });

  // ---- fallthrough --------------------------------------------------------------
  app.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });
  // Express only treats a 4-arg function as error middleware; keep the unused params.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof OwnerAuthError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
    response.status(status).json({ error: error instanceof Error ? error.message : "予期しないエラーが発生しました。" });
  });

  return app;
}

function stringParam(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Express widens `req.params` to `string | string[]` wherever a generically-typed middleware shares a parameterized route with another handler. */
function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function decodeFileName(header: string | undefined): string {
  let name = "file";
  if (header) {
    try {
      name = decodeURIComponent(header) || "file";
    } catch {
      name = header;
    }
  }
  return name.replace(/[/\\]/g, "_").slice(0, 200);
}

function safeEqualStrings(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

function resultPage(message: string, success: boolean): string {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>IGUP</title><body><h1>${success ? "完了" : "エラー"}</h1><p>${message}</p></body></html>`;
}
