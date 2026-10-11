// SpeakHarness desktop shell: runs the bundled `speakh web --no-open` backend and shows its loopback
// dashboard in a sandboxed window. The window only ever renders the backend origin or the static status
// page generated below; everything else is refused or handed to the system browser.
import { app, BrowserWindow, Menu, session, shell } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BackendError, runtimeLayout, startBackend } from "./backend.mjs";

const APP_ID = "io.github.matheuscara.speakharness";
const SMOKE = process.argv.includes("--smoke-test");
const SMOKE_TIMEOUT_MS = 180_000;
const START_TIMEOUT_MS = 90_000;
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 3;
const LOG_LIMIT_BYTES = 1_000_000;

const resourceRoot = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "stage");
const layout = runtimeLayout(join(resourceRoot, "runtime"));
const iconPath = join(resourceRoot, "icons", "icon.png");

let win;
let backend;
let starting;
let quitting = false;
let stopped = false;
let restarts = [];
let smokeResult;
let logFile;

// ---------- log (lifecycle only: no API key, no dashboard content) ----------

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  if (SMOKE || !app.isPackaged) process.stderr.write(line);
  try {
    if (!logFile) {
      const dir = app.getPath("logs");
      mkdirSync(dir, { recursive: true });
      logFile = join(dir, "desktop.log");
      if (existsSync(logFile) && statSync(logFile).size > LOG_LIMIT_BYTES) renameSync(logFile, join(dir, "desktop.old.log"));
    }
    appendFileSync(logFile, line);
  } catch {
    /* Logging must never take the window down. */
  }
}

// ---------- status page ----------

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

let logo = "";
function logoMarkup() {
  if (!logo) {
    try {
      const svg = readFileSync(join(layout.appDir, "assets", "icon.svg"));
      logo = `<img class="logo" alt="" src="data:image/svg+xml;base64,${svg.toString("base64")}">`;
    } catch {
      logo = " ";
    }
  }
  return logo;
}

// Status-page buttons link here; `.invalid` never resolves, and the navigation is intercepted and cancelled.
const STATUS_ACTION = "http://speakharness.invalid/";

/**
 * A script-free page shown while the backend starts or after it failed. Its buttons are links to
 * STATUS_ACTION that the main process intercepts in `will-navigate` (top-level data: URLs cannot even
 * navigate to their own fragments, so in-page links would do nothing).
 */
function statusUrl({ heading, text, details = [], busy = false }) {
  const actions = busy
    ? ""
    : `<nav><a class="primary" href="${STATUS_ACTION}retry">Try again</a><a href="${STATUS_ACTION}logs">Open log folder</a><a href="${STATUS_ACTION}quit">Quit</a></nav>`;
  const pre = details.length > 0 ? `<pre>${escapeHtml(details.join("\n"))}</pre>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>SpeakHarness</title><style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0b0b;color:#f3f0eb;font:15px/1.5 Inter,"Segoe UI",Arial,sans-serif}
main{max-width:640px;padding:32px;text-align:center}
.logo{width:88px;height:88px}
h1{font:900 26px/1.2 "Arial Black",Impact,"DejaVu Sans",sans-serif;letter-spacing:.02em;margin:20px 0 8px}
p{color:#ac9d97;margin:0 0 18px}
pre{text-align:left;white-space:pre-wrap;word-break:break-word;background:#141211;border:1px solid #39302d;border-radius:8px;padding:12px;color:#f3f0eb;font:12px/1.45 "SFMono-Regular",Consolas,"Liberation Mono",monospace;max-height:40vh;overflow:auto}
nav{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:18px}
a{color:#f3f0eb;text-decoration:none;border:1px solid #39302d;border-radius:999px;padding:8px 16px}
a.primary{background:#e86b5c;border-color:#e86b5c;color:#100e0d;font-weight:700}
a:focus-visible{outline:2px solid #ff8471;outline-offset:2px}
.pulse{width:48px;height:4px;margin:6px auto 0;border-radius:2px;background:#e86b5c;animation:pulse 1.1s ease-in-out infinite alternate}
@keyframes pulse{from{opacity:.25;transform:scaleX(.4)}to{opacity:1;transform:scaleX(1)}}
</style></head><body><main>${logoMarkup()}<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(text)}</p>${busy ? `<div class="pulse"></div>` : ""}${pre}${actions}</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showStatus(page) {
  if (!win || win.isDestroyed()) return;
  win.loadURL(statusUrl(page)).catch(() => {
    /* Superseded by a newer page. */
  });
}

function showFailure(heading, error) {
  const details = error instanceof BackendError ? error.details : [];
  log(`${heading}: ${error.message}${details.length > 0 ? `\n    ${details.join("\n    ")}` : ""}`);
  if (SMOKE) return finishSmoke(false, `${heading}: ${error.message}`);
  showStatus({
    heading,
    text: `${error.message}. Details are in ${logFile ?? "the desktop log"}.`,
    details,
  });
}

// ---------- backend ----------

const isDashboard = (url) => {
  try {
    return backend !== undefined && new URL(url).origin === backend.origin;
  } catch {
    return false;
  }
};

async function launch() {
  if (starting || quitting) return;
  showStatus({ heading: "Starting SpeakHarness", text: "Launching the local voice service on this computer…", busy: true });
  log(`starting backend from ${layout.runtimeDir}`);
  let failure;
  starting = startBackend({ layout, cwd: homedir(), timeoutMs: START_TIMEOUT_MS }).then(
    (handle) => {
      backend = handle;
      handle.exited.then((result) => onBackendExit(handle, result));
      return handle;
    },
    (error) => {
      failure = error;
      return undefined;
    },
  );
  const handle = await starting;
  starting = undefined;
  if (quitting) return;
  if (!handle) return showFailure("SpeakHarness could not start", failure);
  log(`backend ready on port ${new URL(handle.url).port} (pid ${handle.pid})`);
  try {
    await handle.authenticate();
  } catch (error) {
    log(`backend key unavailable (${error.message}); shutdown will use signals`);
  }
  if (handle !== backend || quitting) return;
  try {
    await win.loadURL(handle.url);
  } catch (error) {
    if (handle === backend && !quitting) showFailure("The dashboard did not load", error);
  }
}

function onBackendExit(handle, { code, signal }) {
  if (handle !== backend) return;
  backend = undefined;
  if (quitting) return;
  const status = signal ? `signal ${signal}` : `exit code ${code}`;
  log(`backend exited (${status})`);
  // The dashboard server also ends itself after missing heartbeats (e.g. across system sleep): relaunch.
  const now = Date.now();
  restarts = restarts.filter((time) => now - time < RESTART_WINDOW_MS);
  if (!SMOKE && restarts.length < MAX_RESTARTS) {
    restarts.push(now);
    void launch();
    return;
  }
  showFailure("SpeakHarness stopped", new BackendError(`The local service ended (${status})`, handle.stderrTail()));
}

// ---------- smoke test (CI): the packaged window must render the live dashboard ----------

function finishSmoke(ok, reason) {
  if (smokeResult !== undefined) return;
  smokeResult = ok;
  log(ok ? "smoke test: dashboard rendered" : `smoke test failed: ${reason}`);
  app.quit();
}

async function checkDashboardRendered() {
  // Only booleans leave the page: the key and session titles stay in the renderer.
  const probe = `(() => {
    const key = document.querySelector('meta[name="speakh-key"]')?.content ?? "";
    const title = document.getElementById("hero-session-title")?.textContent ?? "";
    return { key: /^[0-9a-f]{48}$/.test(key), hero: document.body.textContent.includes("READ WITH"), state: title !== "" && !title.startsWith("Finding your sessions") };
  })()`;
  for (let attempt = 0; attempt < 60 && smokeResult === undefined; attempt++) {
    const result = await win.webContents.executeJavaScript(probe).catch(() => undefined);
    if (result?.key && result.hero && result.state) return finishSmoke(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  finishSmoke(false, "the dashboard page loaded but never rendered its state");
}

// ---------- window and security ----------

function openExternal(url) {
  try {
    if (new URL(url).protocol === "https:") void shell.openExternal(url);
  } catch {
    /* Not a URL. */
  }
}

function hardenSession(ses) {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const { url } = details;
    if (/^(data|blob|devtools):/.test(url)) return callback({});
    callback({ cancel: !isDashboard(url) });
  });
}

function statusAction(action) {
  if (action === "retry") {
    if (backend?.running) win?.loadURL(backend.url).catch((error) => showFailure("The dashboard did not load", error));
    else void launch();
  } else if (action === "logs") {
    void shell.openPath(app.getPath("logs"));
  } else if (action === "quit") {
    app.quit();
  }
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isDashboard(url)) return;
    event.preventDefault();
    if (url.startsWith(STATUS_ACTION) && contents.getURL().startsWith("data:")) statusAction(url.slice(STATUS_ACTION.length));
    else openExternal(url);
  });
  contents.on("will-redirect", (event, url) => {
    if (!isDashboard(url)) event.preventDefault();
  });
});

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: "SpeakHarness",
    backgroundColor: "#0c0b0b",
    show: false,
    autoHideMenuBar: true,
    ...(process.platform !== "darwin" && existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      safeDialogs: true,
      // Reading continues while the window is in the background; keep its heartbeat timers on schedule.
      backgroundThrottling: false,
    },
  });
  if (!SMOKE) win.once("ready-to-show", () => win.show());
  const contents = win.webContents;
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !isDashboard(url) || quitting) return;
    showFailure("The dashboard did not load", new Error(`${description} (${code})`));
  });
  contents.on("did-finish-load", () => {
    if (SMOKE && isDashboard(contents.getURL())) void checkDashboardRendered();
  });
  contents.on("render-process-gone", (_event, details) => {
    if (quitting) return;
    showFailure("The window stopped", new Error(`renderer ${details.reason} (exit code ${details.exitCode})`));
  });
  win.on("closed", () => {
    win = undefined;
  });
}

function setMenu() {
  if (process.platform !== "darwin") return Menu.setApplicationMenu(null);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]),
  );
}

// ---------- lifecycle ----------

app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  // The dashboard server stops without a viewer, so closing the last window ends the app on every OS.
  app.on("window-all-closed", () => app.quit());

  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    Promise.resolve(starting)
      .then(() => backend?.stop())
      .then(
        (result) => {
          if (result) log(`backend stopped (${result.signal ? `signal ${result.signal}` : `exit code ${result.code}`}${result.graceful ? "" : ", forced"})`);
          if (SMOKE && !(result?.graceful && result.code === 0)) smokeResult = false;
        },
        (error) => {
          log(`backend stop failed: ${error.message}`);
          if (SMOKE) smokeResult = false;
        },
      )
      .finally(() => {
        stopped = true;
        if (SMOKE) app.exit(smokeResult ? 0 : 1);
        else app.quit();
      });
  });

  if (process.platform === "win32") app.setAppUserModelId(APP_ID);

  app.whenReady().then(() => {
    hardenSession(session.defaultSession);
    setMenu();
    createWindow();
    if (SMOKE) setTimeout(() => finishSmoke(false, `no rendered dashboard after ${SMOKE_TIMEOUT_MS / 1000} s`), SMOKE_TIMEOUT_MS).unref();
    void launch();
  });
}
