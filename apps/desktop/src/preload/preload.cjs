const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("igup", {
  status: () => ipcRenderer.invoke("connection:status"),
  connect: () => ipcRenderer.invoke("connection:start"),
  account: () => ipcRenderer.invoke("instagram:account"),
  publish: (input) => ipcRenderer.invoke("instagram:publish", input),
  onConnected: (listener) => ipcRenderer.on("connection:changed", listener),
});
