import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopAuth } from "./auth.js";
import { InstagramClient } from "./instagram-client.js";
import { ConnectionStorage } from "./storage.js";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const brokerUrl = process.env.IGUP_BROKER_URL ?? "http://127.0.0.1:8787";
const storage = new ConnectionStorage();
const instagram = new InstagramClient(process.env.META_GRAPH_VERSION ?? "v23.0");
let mainWindow: BrowserWindow | null = null;

const auth = new DesktopAuth(brokerUrl, async (connection) => {
  await storage.save(connection);
  mainWindow?.webContents.send("connection:changed");
});

function registerHandlers(): void {
  ipcMain.handle("connection:status", async () => {
    const connection = await storage.load();
    return { connected: Boolean(connection), expiresAt: connection?.expiresAt ?? null };
  });
  ipcMain.handle("connection:start", () => auth.start());
  ipcMain.handle("instagram:account", async () => {
    const connection = await requireConnection();
    return instagram.getAccount(connection);
  });
  ipcMain.handle("instagram:publish", async (_event, input: unknown) => {
    if (!isPublishInput(input)) throw new Error("投稿内容が不正です。");
    const connection = await requireConnection();
    const account = await instagram.getAccount(connection);
    return instagram.publishImage(connection, account.id, input.imageUrl, input.caption);
  });
}

async function requireConnection() {
  const connection = await storage.load();
  if (!connection) throw new Error("先にInstagramへ接続してください。");
  return connection;
}

function isPublishInput(value: unknown): value is { imageUrl: string; caption: string } {
  return Boolean(value && typeof value === "object" && "imageUrl" in value && typeof value.imageUrl === "string" && "caption" in value && typeof value.caption === "string");
}

app.whenReady().then(() => {
  registerHandlers();
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 720,
    minHeight: 600,
    title: "IGUP",
    webPreferences: {
      preload: join(currentDirectory, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void mainWindow.loadFile(join(currentDirectory, "../renderer/index.html"));
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => auth.close());
