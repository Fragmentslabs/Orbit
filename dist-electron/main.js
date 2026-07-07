import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const _require = createRequire(import.meta.url);
const nodePty = _require("node-pty");
const __dirname$1 = path.dirname(fileURLToPath(import.meta.url));
process.env.APP_ROOT = path.join(__dirname$1, "..");
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, "public") : RENDERER_DIST;
let win;
function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: path.join(__dirname$1, "preload.mjs"),
      webviewTag: true
    }
  });
  win.webContents.on("did-finish-load", () => {
    win == null ? void 0 : win.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  });
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
}
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
const terminals = /* @__PURE__ */ new Map();
function createTerminal(id, cols = 80, rows = 24) {
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell.exe" : process.env.SHELL || "/bin/bash";
  const ptyProcess = nodePty.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.env.HOME || process.env.USERPROFILE || "/",
    env: process.env
  });
  ptyProcess.onData((data) => {
    win == null ? void 0 : win.webContents.send("terminal:output", { id, data });
  });
  ptyProcess.onExit(({ exitCode }) => {
    terminals.delete(id);
    win == null ? void 0 : win.webContents.send("terminal:exit", { id, code: exitCode });
  });
  return ptyProcess;
}
app.whenReady().then(() => {
  ipcMain.handle("select-folder", async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  ipcMain.handle("terminal:create", (_event, id, cols, rows) => {
    const proc = createTerminal(id, cols, rows);
    terminals.set(id, proc);
    return { pid: proc.pid };
  });
  ipcMain.handle("terminal:write", (_event, id, data) => {
    var _a;
    (_a = terminals.get(id)) == null ? void 0 : _a.write(data);
  });
  ipcMain.handle("terminal:resize", (_event, id, cols, rows) => {
    var _a;
    (_a = terminals.get(id)) == null ? void 0 : _a.resize(cols, rows);
  });
  ipcMain.handle("terminal:kill", (_event, id) => {
    const proc = terminals.get(id);
    if (proc) {
      proc.kill();
      terminals.delete(id);
    }
  });
  createWindow();
});
export {
  MAIN_DIST,
  RENDERER_DIST,
  VITE_DEV_SERVER_URL
};
