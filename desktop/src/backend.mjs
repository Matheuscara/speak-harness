// Starts and stops the bundled SpeakHarness web backend: the packaged Bun runs `speakh web --no-open`
// from the staged app directory, and the bundled Node 22 serves the TTS worker. No Electron imports, so
// the CI smoke script drives the exact same code against a packaged resources directory.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

const BANNER = /^SpeakHarness dashboard: (http:\/\/127\.0\.0\.1:(\d{1,5})\/)\s*$/;
const TOKEN = /<meta name="speakh-key" content="([0-9a-f]{16,128})"/;
const STDERR_LINES = 40;

/** Paths of the staged runtime: `bin/` holds Bun and Node, `app/` the SpeakHarness package. */
export function runtimeLayout(dir, platform = process.platform) {
  const runtimeDir = resolve(dir);
  const exe = (name) => (platform === "win32" ? `${name}.exe` : name);
  const binDir = join(runtimeDir, "bin");
  const appDir = join(runtimeDir, "app");
  return {
    runtimeDir,
    binDir,
    appDir,
    bun: join(binDir, exe("bun")),
    node: join(binDir, exe("node")),
    entry: join(appDir, "src", "cli", "main.ts"),
  };
}

export function missingRuntimeFiles(layout) {
  return [layout.bun, layout.node, layout.entry, join(layout.appDir, "node_modules")].filter((path) => !existsSync(path));
}

// GUI launches inherit a minimal PATH on macOS (no Homebrew), and desktop sessions may omit /usr/local/bin.
const EXTRA_PATH = {
  darwin: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"],
  linux: ["/usr/local/bin", "/usr/bin", "/bin"],
};

// AppImage's AppRun prepends its mount to these; system audio players must not load the bundled libraries.
const APPIMAGE_LISTS = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"];

function envKey(env, name, platform) {
  if (platform !== "win32") return name;
  return Object.keys(env).find((key) => key.toUpperCase() === name) ?? name;
}

/**
 * Environment for the backend: bundled Node exposed as `SPEAKH_NODE_BINARY` and first on PATH (Bun next),
 * then the inherited PATH plus the usual system directories for audio players.
 */
export function backendEnv(layout, base = process.env, platform = process.platform) {
  const env = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  const appImageDir = platform === "linux" && base.APPIMAGE && base.APPDIR ? base.APPDIR : undefined;
  if (appImageDir) {
    const inside = (entry) => entry === appImageDir || entry.startsWith(appImageDir.endsWith(sep) ? appImageDir : appImageDir + sep);
    for (const name of APPIMAGE_LISTS) {
      if (env[name] === undefined) continue;
      const kept = env[name].split(delimiter).filter((entry) => entry && !inside(entry));
      if (kept.length > 0) env[name] = kept.join(delimiter);
      else delete env[name];
    }
  }
  const pathKey = envKey(env, "PATH", platform);
  const entries = [layout.binDir, ...(env[pathKey] ?? "").split(delimiter).filter(Boolean)];
  for (const dir of EXTRA_PATH[platform] ?? []) if (!entries.includes(dir)) entries.push(dir);
  env[pathKey] = [...new Set(entries)].join(delimiter);
  env.SPEAKH_NODE_BINARY = layout.node;
  return env;
}

/** Last stderr lines fit for display: no terminal escapes, no API-key-shaped strings, bounded width. */
export function sanitizeOutput(lines, limit = 12) {
  return lines
    .slice(-limit)
    .map((line) =>
      line
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
        .replace(/[0-9a-f]{32,}/gi, "[redacted]")
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
        .slice(0, 240),
    )
    .filter((line) => line.trim() !== "");
}

export class BackendError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "BackendError";
    /** Sanitized stderr tail; safe to show and log. */
    this.details = details;
  }
}

/** Minimal loopback HTTP client: sends exactly the headers the backend's Host/Origin checks expect. */
export function loopbackRequest(url, { method = "GET", headers = {}, body, timeoutMs = 5_000 } = {}) {
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") return Promise.reject(new Error("loopback only"));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "Content-Length": Buffer.byteLength(body) }) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`request to ${target.pathname} timed out`)));
    req.on("error", reject);
    req.end(body);
  });
}

function killTree(child, platform) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32") {
    // TerminateProcess on bun.exe alone would orphan the Node TTS worker it started.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

/**
 * Spawns the backend and resolves once it printed its dashboard address (rejects with a BackendError
 * carrying sanitized stderr when it exits, cannot start, or stays silent past `timeoutMs`).
 */
export function startBackend({ layout, cwd = homedir(), env = backendEnv(layout), timeoutMs = 60_000, platform = process.platform }) {
  const missing = missingRuntimeFiles(layout);
  if (missing.length > 0) return Promise.reject(new BackendError(`The bundled runtime is incomplete; missing ${missing.join(", ")}`));

  const stderr = [];
  const child = spawn(layout.bun, ["--no-install", layout.entry, "web", "--no-open"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
    stderr.push(line);
    if (stderr.length > STDERR_LINES) stderr.shift();
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child, platform);
      // Let the last stderr lines arrive before quoting them.
      setTimeout(() => reject(new BackendError(message, sanitizeOutput(stderr))), 150);
    };
    const timer = setTimeout(() => fail(`SpeakHarness did not report its dashboard address within ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    child.once("error", (error) => fail(`Cannot start the bundled Bun runtime: ${error.code ?? error.message}`));
    exited.then(({ code, signal }) => fail(`SpeakHarness stopped while starting (${signal ? `signal ${signal}` : `exit code ${code}`})`));

    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (settled) return;
      const match = BANNER.exec(line);
      if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return;
      settled = true;
      clearTimeout(timer);
      resolve(createHandle(child, exited, match[1], stderr, platform));
    });
  });
}

function createHandle(child, exited, url, stderr, platform) {
  let exit;
  exited.then((result) => {
    exit = result;
  });
  let token;
  const waitExit = (ms) =>
    Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(resolve, ms, false).unref?.())]);

  return {
    url,
    origin: new URL(url).origin,
    pid: child.pid,
    exited,
    get running() {
      return exit === undefined;
    },
    stderrTail: () => sanitizeOutput(stderr),
    /** Reads the per-run API key the dashboard page embeds; kept in memory only, never logged. */
    async authenticate() {
      const response = await loopbackRequest(url);
      const match = response.status === 200 ? TOKEN.exec(response.body.toString("utf8")) : null;
      if (!match) throw new Error(`dashboard page did not provide its key (HTTP ${response.status})`);
      token = match[1];
      return token;
    },
    /** Authenticated GET/POST against the backend API. */
    api(path, { method = "GET", json } = {}) {
      if (!token) return Promise.reject(new Error("backend not authenticated"));
      const headers = { "X-Speakh-Key": token };
      if (json !== undefined) headers["Content-Type"] = "application/json";
      return loopbackRequest(new URL(path, url).href, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        timeoutMs: 120_000,
      });
    },
    /**
     * Graceful first: the authenticated /api/quit lets the CLI dispose the app (and its TTS worker); then
     * SIGTERM (POSIX), then a forced tree kill. Resolves with how it ended.
     */
    async stop({ quitMs = 5_000, termMs = 3_000 } = {}) {
      if (exit) return { ...exit, graceful: true };
      if (token) {
        try {
          await loopbackRequest(new URL("api/quit", url).href, {
            method: "POST",
            headers: { "X-Speakh-Key": token, "Content-Type": "application/json" },
            body: "{}",
            timeoutMs: 2_000,
          });
        } catch {
          /* Falls through to signals. */
        }
        if (await waitExit(quitMs)) return { ...exit, graceful: true };
      }
      if (platform !== "win32") {
        child.kill("SIGTERM");
        if (await waitExit(termMs)) return { ...exit, graceful: false };
      }
      killTree(child, platform);
      await waitExit(2_000);
      return { ...(exit ?? { code: null, signal: null }), graceful: false };
    },
  };
}
