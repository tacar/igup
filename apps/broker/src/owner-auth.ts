import { createHash } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { MetaApiError, type Owner } from "./meta-client.js";

export class OwnerAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "OwnerAuthError";
  }
}

/**
 * Resolves the Instagram access token the desktop sends as a bearer token into the account that owns it.
 * Tokens are never stored: the cache key is a hash and the value is only the account ids.
 */
export class OwnerResolver {
  private readonly cache = new Map<string, { owner: Owner; expiresAt: number }>();
  private readonly failures = new Map<string, { error: OwnerAuthError; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<Owner>>();

  constructor(
    private readonly resolve: (token: string) => Promise<Owner>,
    private readonly ttlMs = 3_600_000,
    private readonly failureTtlMs = 60_000,
  ) {}

  async lookup(token: string, now = Date.now()): Promise<Owner> {
    const key = createHash("sha256").update(token).digest("hex");
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.owner;
    const failed = this.failures.get(key);
    if (failed && failed.expiresAt > now) throw failed.error;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.resolve(token)
        .then((owner) => {
          this.cache.set(key, { owner, expiresAt: now + this.ttlMs });
          this.failures.delete(key);
          this.trim(now);
          return owner;
        })
        .catch((cause: unknown) => {
          const error = toAuthError(cause);
          if (error.status === 401) this.failures.set(key, { error, expiresAt: now + this.failureTtlMs });
          throw error;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private trim(now: number): void {
    if (this.cache.size <= 1_000) return;
    for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key);
    while (this.cache.size > 1_000) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

function toAuthError(cause: unknown): OwnerAuthError {
  if (cause instanceof OwnerAuthError) return cause;
  if (cause instanceof MetaApiError) {
    if (cause.isAuth) return new OwnerAuthError("Instagramのアクセストークンが無効です。IGUPでInstagramに接続し直してください。", 401);
    return new OwnerAuthError(`Instagram APIがエラーを返しました: ${cause.message}`, 502);
  }
  return new OwnerAuthError("Instagram APIに接続できませんでした。しばらくしてからもう一度お試しください。", 502);
}

/** All ids an owner may appear under in webhook payloads. */
export function ownerKeys(owner: Owner): string[] {
  return [owner.id, owner.userId].filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function requireOwner(resolver: OwnerResolver, now: () => number = Date.now): RequestHandler {
  return (request, response, next) => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      response.status(401).json({ error: "Instagramに接続してから操作してください。" });
      return;
    }
    resolver.lookup(token, now()).then(
      (owner) => {
        response.locals.owner = owner;
        next();
      },
      (error: unknown) => {
        const status = error instanceof OwnerAuthError ? error.status : 502;
        response.status(status).json({ error: error instanceof Error ? error.message : "認証に失敗しました。" });
      },
    );
  };
}

export function ownerOf(response: Response): Owner {
  return response.locals.owner as Owner;
}
