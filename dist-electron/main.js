import { app as n, BrowserWindow as t } from "electron";
import { createRequire as a } from "node:module";
import { fileURLToPath as c } from "node:url";
import o from "node:path";
a(import.meta.url);
const r = o.dirname(c(import.meta.url));
process.env.APP_ROOT = o.join(r, "..");
const i = process.env.VITE_DEV_SERVER_URL, _ = o.join(process.env.APP_ROOT, "dist-electron"), s = o.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = i ? o.join(process.env.APP_ROOT, "public") : s;
let e;
function l() {
  e = new t({
    icon: o.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: o.join(r, "preload.mjs")
    }
  }), e.webContents.on("did-finish-load", () => {
    e == null || e.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  }), i ? e.loadURL(i) : e.loadFile(o.join(s, "index.html"));
}
n.on("window-all-closed", () => {
  process.platform !== "darwin" && (n.quit(), e = null);
});
n.on("activate", () => {
  t.getAllWindows().length === 0 && l();
});
n.whenReady().then(l);
export {
  _ as MAIN_DIST,
  s as RENDERER_DIST,
  i as VITE_DEV_SERVER_URL
};
