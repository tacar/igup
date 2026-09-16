const { contextBridge, ipcRenderer, webUtils } = require("electron");

const CHANNELS = new Set([
  "app:info", "app:openExternal", "app:pickFiles", "app:saveFile", "app:readFile",
  "connection:status", "connection:start", "connection:disconnect", "connection:subscribeWebhooks", "connection:capabilities", "line:save",
  "instagram:account", "instagram:media", "threads:profile",
  "rules:list", "rules:save", "rules:delete", "rules:test", "rules:chainPayload",
  "automation:status", "automation:setEnabled", "automation:runOnce",
  "posts:list", "posts:save", "posts:delete", "posts:cancel", "posts:publishNow", "posts:progress",
  "media:import", "media:saveEdited", "media:preview",
  "memos:list", "memos:save", "memos:delete",
  "insights:summary", "insights:capture",
  "links:list", "links:cached", "links:create", "links:delete",
  "seminars:list", "seminars:save", "seminars:delete", "seminars:sync", "seminars:qr",
  "logs:list", "logs:clear",
  "settings:get", "settings:save", "localApi:token", "data:export", "data:import",
]);

contextBridge.exposeInMainWorld("igup", {
  invoke: (channel, payload) => {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error(`Unknown channel: ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  on: (listener) => {
    const wrapped = (_event, message) => listener(message);
    ipcRenderer.on("igup:event", wrapped);
    return () => ipcRenderer.removeListener("igup:event", wrapped);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
});
