const REQUIRED_KEYS = ["META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI"] as const;

/** Permissions the desktop needs for replies, DMs, publishing and insights. */
export const DEFAULT_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
].join(",");

export const DEFAULT_THREADS_SCOPES = "threads_basic,threads_content_publish";

export type ThreadsConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  scopes: string;
};

export type BrokerConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  scopes: string;
  port: number;
  desktopOrigin: string;
  graphVersion: string;
  /** Threads is optional: only enabled when THREADS_APP_ID and THREADS_APP_SECRET are set. */
  threads: ThreadsConfig | null;
  /** Shared secret Meta echoes back when it verifies the webhook endpoint. */
  webhookVerifyToken: string | null;
  /** Where links, seminar sign-ups, queued events and transient media live. */
  dataDir: string;
  /** Public origin of this broker (https://broker.example.com). Derived from the request when null. */
  publicBaseUrl: string | null;
  mediaMaxBytes: number;
  mediaTtlHours: number;
  eventTtlHours: number;
  timeZone: string;
  trustProxy: number | boolean;
};

export function loadConfig(environment: NodeJS.ProcessEnv): BrokerConfig {
  const missing = REQUIRED_KEYS.filter((key) => !environment[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }

  const redirectUri = environment.META_REDIRECT_URI!.trim();
  const threadsAppId = environment.THREADS_APP_ID?.trim();
  const threadsAppSecret = environment.THREADS_APP_SECRET?.trim();
  const threads: ThreadsConfig | null = threadsAppId && threadsAppSecret
    ? {
        appId: threadsAppId,
        appSecret: threadsAppSecret,
        redirectUri: environment.THREADS_REDIRECT_URI?.trim() || redirectUri,
        scopes: environment.THREADS_SCOPES?.trim() || DEFAULT_THREADS_SCOPES,
      }
    : null;

  const publicBaseUrl = environment.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || null;
  if (publicBaseUrl && !/^https?:\/\/[^/\s]+$/.test(publicBaseUrl)) {
    throw new Error("PUBLIC_BASE_URL must be an origin such as https://broker.example.com (no path)");
  }

  return {
    appId: environment.META_APP_ID!.trim(),
    appSecret: environment.META_APP_SECRET!.trim(),
    redirectUri,
    scopes: environment.META_SCOPES?.trim() || DEFAULT_SCOPES,
    port: integer(environment.PORT, 8787, 1, 65_535, "PORT"),
    desktopOrigin: environment.DESKTOP_ORIGIN?.trim() || "http://127.0.0.1:42813",
    graphVersion: environment.META_GRAPH_VERSION?.trim() || "v23.0",
    threads,
    webhookVerifyToken: environment.META_WEBHOOK_VERIFY_TOKEN?.trim() || null,
    dataDir: environment.BROKER_DATA_DIR?.trim() || "./data",
    publicBaseUrl,
    mediaMaxBytes: integer(environment.MEDIA_MAX_MB, 100, 1, 4_096, "MEDIA_MAX_MB") * 1024 * 1024,
    mediaTtlHours: integer(environment.MEDIA_TTL_HOURS, 24, 1, 24 * 30, "MEDIA_TTL_HOURS"),
    eventTtlHours: integer(environment.EVENT_TTL_HOURS, 24, 1, 24 * 30, "EVENT_TTL_HOURS"),
    timeZone: timeZone(environment.BROKER_TIMEZONE),
    trustProxy: trustProxy(environment.TRUST_PROXY),
  };
}

function integer(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function timeZone(raw: string | undefined): string {
  const zone = raw?.trim() || "Asia/Tokyo";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new Error(`BROKER_TIMEZONE is not a valid IANA time zone: ${zone}`);
  }
  return zone;
}

function trustProxy(raw: string | undefined): number | boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") return 1;
  if (value === "true") return true;
  if (value === "false") return false;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  throw new Error("TRUST_PROXY must be true, false or a number of proxy hops");
}
