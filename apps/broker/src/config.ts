const REQUIRED_KEYS = [
  "META_APP_ID",
  "META_APP_SECRET",
  "META_REDIRECT_URI",
] as const;

export type BrokerConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  port: number;
  desktopOrigin: string;
  graphVersion: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv): BrokerConfig {
  const missing = REQUIRED_KEYS.filter((key) => !environment[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }

  const port = Number(environment.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return {
    appId: environment.META_APP_ID!,
    appSecret: environment.META_APP_SECRET!,
    redirectUri: environment.META_REDIRECT_URI!,
    port,
    desktopOrigin: environment.DESKTOP_ORIGIN ?? "http://127.0.0.1:42813",
    graphVersion: environment.META_GRAPH_VERSION ?? "v23.0",
  };
}
