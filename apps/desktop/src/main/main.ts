import { app, BrowserWindow, nativeTheme } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopAuth } from "./auth.js";
import { ipcHandlers, registerIpc } from "./ipc.js";
import { Services } from "./services.js";
import { ConnectionStorage } from "./storage.js";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const brokerUrl = process.env.IGUP_BROKER_URL ?? "http://127.0.0.1:8787";
let mainWindow: BrowserWindow | null = null;

function notify(type: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("igup:event", { type, payload });
}

const storage = new ConnectionStorage();
const services = new Services({
  userDataDir: app.getPath("userData"),
  brokerUrl,
  graphVersion: process.env.META_GRAPH_VERSION ?? "v23.0",
  secrets: storage,
  notify,
  appVersion: app.getVersion(),
  onBrokerUrlChanged: (url) => auth.setUrl(url),
});

const auth = new DesktopAuth(brokerUrl, async (connection, provider) => {
  await storage.save(connection, provider);
  if (provider === "instagram") services.engine.invalidateAccount();
  services.data.log("info", "system", `${provider === "threads" ? "Threads" : "Instagram"}と接続しました`);
  notify("connection:changed", { provider });
  mainWindow?.focus();
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 620,
    title: "IGUP",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#17181c" : "#f5f4f1",
    webPreferences: {
      preload: join(currentDirectory, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadFile(join(currentDirectory, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  registerIpc(ipcHandlers(services, auth, () => mainWindow));
  try {
    await services.start();
  } catch (cause) {
    console.error(cause);
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Keep running on macOS so scheduled posts and auto replies continue while the window is closed.
  if (process.platform !== "darwin") app.quit();
});

let stopping = false;
app.on("before-quit", (event) => {
  if (stopping) return;
  stopping = true;
  event.preventDefault();
  auth.close();
  void services.stop().finally(() => app.quit());
});
