import { randomBytes, timingSafeEqual } from "node:crypto";

const ATTEMPT_TTL_MS = 10 * 60 * 1_000;
const RESULT_TTL_MS = 5 * 60 * 1_000;

export type Provider = "instagram" | "threads";

export type TokenResult = {
  accessToken: string;
  expiresAt: string | null;
};

/** @deprecated kept for older imports; identical to TokenResult. */
export type InstagramConnection = TokenResult;

type Attempt = {
  verifier: string;
  provider: Provider;
  createdAt: number;
  result?: TokenResult;
  resultCreatedAt?: number;
};

/**
 * Tracks OAuth attempts in memory. The desktop keeps the verifier; the browser only ever sees the state,
 * so a token can be redeemed exactly once by the process that started the attempt.
 */
export class AttemptStore {
  private readonly attempts = new Map<string, Attempt>();

  create(now = Date.now(), provider: Provider = "instagram"): { state: string; verifier: string } {
    this.purge(now);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    this.attempts.set(state, { verifier, provider, createdAt: now });
    return { state, verifier };
  }

  providerOf(state: string, now = Date.now()): Provider | null {
    this.purge(now);
    return this.attempts.get(state)?.provider ?? null;
  }

  complete(state: string, connection: TokenResult, now = Date.now()): boolean {
    this.purge(now);
    const attempt = this.attempts.get(state);
    if (!attempt || attempt.result) return false;
    attempt.result = connection;
    attempt.resultCreatedAt = now;
    return true;
  }

  redeem(state: string, verifier: string, now = Date.now()): TokenResult | null {
    this.purge(now);
    const attempt = this.attempts.get(state);
    if (!attempt?.result || !safeEqual(attempt.verifier, verifier)) return null;
    this.attempts.delete(state);
    return attempt.result;
  }

  exists(state: string, now = Date.now()): boolean {
    this.purge(now);
    return this.attempts.has(state);
  }

  private purge(now: number): void {
    for (const [state, attempt] of this.attempts) {
      const resultExpired = attempt.resultCreatedAt !== undefined && now - attempt.resultCreatedAt > RESULT_TTL_MS;
      if (now - attempt.createdAt > ATTEMPT_TTL_MS || resultExpired) this.attempts.delete(state);
    }
  }
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
