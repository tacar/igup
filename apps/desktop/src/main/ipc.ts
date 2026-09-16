import { dialog, ipcMain, shell, type BrowserWindow } from "electron";
import type { DesktopAuth } from "./auth.js";
import type { Services } from "./services.js";
import type { CalendarMemo, MediaAsset, Provider, Rule, ScheduledPost, Seminar, Settings } from "./types.js";

type Handler = (payload: unknown) => Promise<unknown> | unknown;

const record = (payload: unknown): Record<string, unknown> => (payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {});
const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

/** All renderer-facing channels. The preload allowlist must contain the same names. */
export function ipcHandlers(services: Services, auth: DesktopAuth, window: () => BrowserWindow | null): Record<string, Handler> {
  return {
    "app:info": () => services.appInfo(),
    "app:openExternal": (payload) => {
      const url = text(record(payload).url);
      if (!/^https?:\/\//.test(url)) throw new Error("開けないURLです。");
      return shell.openExternal(url);
    },
    "app:pickFiles": async (payload) => {
      const kind = text(record(payload).kind, "media");
      const filters = kind === "image"
        ? [{ name: "画像", extensions: ["jpg", "jpeg", "png"] }]
        : kind === "video"
          ? [{ name: "動画", extensions: ["mp4", "mov", "m4v"] }]
          : kind === "json"
            ? [{ name: "JSON", extensions: ["json"] }]
            : [{ name: "画像・動画", extensions: ["jpg", "jpeg", "png", "mp4", "mov", "m4v"] }];
      const owner = window();
      const options = { properties: ["openFile", ...(kind === "json" ? [] : ["multiSelections"])] as ("openFile" | "multiSelections")[], filters };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return result.canceled ? [] : result.filePaths;
    },
    "app:saveFile": async (payload) => {
      const { defaultName, content } = record(payload);
      const owner = window();
      const options = { defaultPath: text(defaultName, "igup-backup.json") };
      const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { saved: false };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(result.filePath, text(content), "utf8");
      return { saved: true, path: result.filePath };
    },
    "app:readFile": async (payload) => {
      const path = text(record(payload).path);
      const { readFile } = await import("node:fs/promises");
      return readFile(path, "utf8");
    },

    "connection:status": () => services.connectionStatus(),
    "connection:start": (payload) => auth.start((text(record(payload).provider, "instagram") as Provider), text(record(payload).accountId) || null),
    "connection:disconnect": (payload) => services.disconnect(text(record(payload).provider, "instagram") as Provider, text(record(payload).accountId) || undefined),
    "connection:subscribeWebhooks": (payload) => services.subscribeWebhooks(text(record(payload).accountId) || undefined),
    "connection:capabilities": () => services.capabilities(true),
    "line:save": (payload) => services.saveLineToken(text(record(payload).token) || null),

    "accounts:setActive": (payload) => services.setActiveAccount(text(record(payload).accountId)),
    "accounts:remove": (payload) => services.removeAccount(text(record(payload).accountId)),

    "instagram:account": (payload) => services.account(text(record(payload).accountId) || undefined),
    "instagram:media": (payload) => services.recentMedia(Number(record(payload).limit ?? 25), text(record(payload).accountId) || undefined),
    "threads:profile": (payload) => services.threadsProfile(text(record(payload).accountId) || undefined),

    "rules:list": () => services.listRules(),
    "rules:save": (payload) => services.saveRule(record(payload) as Partial<Rule>),
    "rules:delete": (payload) => services.deleteRule(text(record(payload).id)),
    "rules:test": (payload) => services.engine.sendTest(text(record(payload).ruleId), text(record(payload).recipientId)),
    "rules:chainPayload": (payload) => services.chainPayload(text(record(payload).originRuleId), text(record(payload).targetRuleId)),

    "automation:status": () => services.engine.status(),
    "automation:setEnabled": (payload) => services.saveSettings({ automationEnabled: Boolean(record(payload).enabled) }),
    "automation:runOnce": async () => {
      await services.engine.runOnce();
      return services.engine.status();
    },

    "posts:list": () => services.listPosts(),
    "posts:save": (payload) => services.savePost(record(payload) as Partial<ScheduledPost>),
    "posts:delete": (payload) => services.deletePost(text(record(payload).id)),
    "posts:deleteSeries": (payload) => services.deleteSeries(text(record(payload).seriesId)),
    "posts:cancel": (payload) => services.cancelPost(text(record(payload).id)),
    "posts:publishNow": (payload) => services.publishNow(text(record(payload).id)),
    "posts:progress": (payload) => services.scheduler.progressOf(text(record(payload).id)),

    "media:import": (payload) => services.importMedia(((record(payload).paths as unknown[]) ?? []).map((path) => String(path))),
    "media:saveEdited": (payload) => services.saveEditedImage(text(record(payload).dataUrl), text(record(payload).fileName, "image.jpg")),
    "media:preview": (payload) => services.mediaPreview(record(payload).asset as MediaAsset),

    "memos:list": () => services.data.get().memos,
    "memos:save": (payload) => services.saveMemo(record(payload) as Partial<CalendarMemo>),
    "memos:delete": (payload) => services.deleteMemo(text(record(payload).id)),

    "insights:summary": (payload) => services.insights.summary(text(record(payload).accountId) || undefined),
    "insights:capture": async () => {
      await services.insights.captureDaily();
      await services.insights.captureStories();
      return services.insights.summary();
    },

    "links:list": () => services.listLinks(),
    "links:cached": () => services.data.get().links,
    "links:create": (payload) => services.createLink(record(payload) as { url: string; label: string; source: string; slug?: string }),
    "links:delete": (payload) => services.deleteLink(text(record(payload).slug)),

    "seminars:list": () => services.listSeminars(),
    "seminars:save": (payload) => services.seminars.save(record(payload) as unknown as Seminar),
    "seminars:delete": (payload) => services.seminars.remove(text(record(payload).id)),
    "seminars:sync": async () => {
      await services.seminars.sync();
      return services.listSeminars();
    },
    "seminars:qr": (payload) => services.seminars.qrCode(text(record(payload).text)),

    "logs:list": (payload) => services.listLogs(Number(record(payload).limit ?? 200), text(record(payload).category) || undefined),
    "logs:clear": () => services.clearLogs(),

    "settings:get": () => services.settings(),
    "settings:save": (payload) => services.saveSettings(record(payload) as Partial<Settings>),
    "localApi:token": (payload) => services.localApiToken(Boolean(record(payload).regenerate)),
    "data:export": () => JSON.stringify(services.exportData(), null, 2),
    "data:import": (payload) => services.importData(text(record(payload).json)),
  };
}

export function registerIpc(handlers: Record<string, Handler>): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_event, payload: unknown) => {
      try {
        return await handler(payload);
      } catch (cause) {
        // Electron serializes thrown errors as "Error invoking remote method ..."; keep only our message.
        throw new Error(cause instanceof Error ? cause.message : String(cause));
      }
    });
  }
}

export const IPC_CHANNELS = [
  "app:info", "app:openExternal", "app:pickFiles", "app:saveFile", "app:readFile",
  "connection:status", "connection:start", "connection:disconnect", "connection:subscribeWebhooks", "connection:capabilities", "line:save",
  "accounts:setActive", "accounts:remove",
  "instagram:account", "instagram:media", "threads:profile",
  "rules:list", "rules:save", "rules:delete", "rules:test", "rules:chainPayload",
  "automation:status", "automation:setEnabled", "automation:runOnce",
  "posts:list", "posts:save", "posts:delete", "posts:deleteSeries", "posts:cancel", "posts:publishNow", "posts:progress",
  "media:import", "media:saveEdited", "media:preview",
  "memos:list", "memos:save", "memos:delete",
  "insights:summary", "insights:capture",
  "links:list", "links:cached", "links:create", "links:delete",
  "seminars:list", "seminars:save", "seminars:delete", "seminars:sync", "seminars:qr",
  "logs:list", "logs:clear",
  "settings:get", "settings:save", "localApi:token", "data:export", "data:import",
] as const;
