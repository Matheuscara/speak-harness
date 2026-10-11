#!/usr/bin/env node
// Checks a packaged or installed desktop build on the runner that produced it.
//   node scripts/smoke.mjs runtime [--resources <dir>] [--voice <id>]...
//     Starts the bundled backend exactly like the app does, loads the dashboard and its assets, calls the
//     authenticated API, optionally synthesizes a preview WAV per installed voice through the bundled Node
//     worker, and requires a clean /api/quit shutdown. No speaker is involved: audio is checked as bytes.
//   node scripts/smoke.mjs window [--executable <app>] [-- <extra app args>]
//     Launches the app with --smoke-test: the window must render the live dashboard and exit 0.
// Without --resources/--executable the packaged app is located in dist/ (*-unpacked or the .app bundle).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopbackRequest, runtimeLayout, startBackend } from "../src/backend.mjs";

const desktopDir = join(import.meta.dirname, "..");
const PRODUCT = "SpeakHarness";

function packagedApp() {
  const dist = join(desktopDir, "dist");
  const found = [];
  for (const entry of existsSync(dist) ? readdirSync(dist) : []) {
    if (/^(linux|win)(-[a-z0-9]+)?-unpacked$/.test(entry)) {
      const dir = join(dist, entry);
      const executable = entry.startsWith("win") ? join(dir, `${PRODUCT}.exe`) : join(dir, "speak-harness-desktop");
      found.push({ resources: join(dir, "resources"), executable });
    } else if (/^mac(-[a-z0-9]+)?$/.test(entry) && existsSync(join(dist, entry, `${PRODUCT}.app`))) {
      const contents = join(dist, entry, `${PRODUCT}.app`, "Contents");
      found.push({ resources: join(contents, "Resources"), executable: join(contents, "MacOS", PRODUCT) });
    }
  }
  if (found.length !== 1) throw new Error(`expected one packaged app in ${dist}, found ${found.length}`);
  return found[0];
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function runtimeSmoke(resources, voices) {
  const layout = runtimeLayout(join(resources, "runtime"));
  const cwd = mkdtempSync(join(tmpdir(), "speakh-desktop-smoke-"));
  console.log(`runtime: ${layout.runtimeDir}`);
  const backend = await startBackend({ layout, cwd, timeoutMs: 120_000 });
  try {
    const page = await loopbackRequest(backend.url);
    expect(page.status === 200 && page.body.toString("utf8").includes("READ WITH"), `dashboard page: HTTP ${page.status}`);
    for (const [path, type] of [
      ["app.js", "text/javascript"],
      ["app.css", "text/css"],
      ["favicon.svg", "image/svg+xml"],
    ]) {
      const response = await loopbackRequest(new URL(path, backend.url).href);
      expect(response.status === 200 && String(response.headers["content-type"]).startsWith(type), `${path}: HTTP ${response.status}`);
    }
    await backend.authenticate();
    const ping = await backend.api("api/ping");
    expect(ping.status === 200, `api/ping: HTTP ${ping.status}`);
    const state = await backend.api("api/state");
    expect(state.status === 200, `api/state: HTTP ${state.status}`);
    console.log(`dashboard ${backend.origin}: page, assets and authenticated API answer`);
    for (const voice of voices) {
      const response = await backend.api("api/voice-preview", { method: "POST", json: { voice } });
      const body = response.body;
      expect(
        response.status === 200 && body.subarray(0, 4).toString("latin1") === "RIFF" && body.length > 1_000,
        `${voice} preview: HTTP ${response.status} ${response.status === 200 ? `${body.length} bytes` : body.toString("utf8").slice(0, 300)}`,
      );
      console.log(`${voice}: bundled Node worker synthesized a ${body.length}-byte WAV`);
    }
  } finally {
    const result = await backend.stop();
    rmSync(cwd, { recursive: true, force: true });
    expect(result.graceful && result.code === 0, `backend shutdown: ${JSON.stringify(result)} (expected a clean /api/quit exit)`);
    console.log("backend stopped through /api/quit");
  }
}

function windowSmoke(executable, extra) {
  expect(existsSync(executable), `missing ${executable}`);
  console.log(`window: ${executable} --smoke-test ${extra.join(" ")}`.trim());
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--smoke-test", ...extra], { stdio: "inherit" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the packaged app did not finish its smoke test within 300 s"));
    }, 300_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`the packaged app exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

const [mode, ...args] = process.argv.slice(2);
try {
  if (mode === "runtime") {
    let resources;
    const voices = [];
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--resources") resources = args[++index];
      else if (args[index] === "--voice") voices.push(args[++index]);
      else throw new Error(`unknown argument ${args[index]}`);
    }
    await runtimeSmoke(resources ?? packagedApp().resources, voices);
  } else if (mode === "window") {
    const separator = args.indexOf("--");
    const own = separator >= 0 ? args.slice(0, separator) : args;
    let executable;
    for (let index = 0; index < own.length; index++) {
      if (own[index] === "--executable") executable = own[++index];
      else throw new Error(`unknown argument ${own[index]}`);
    }
    await windowSmoke(executable ?? packagedApp().executable, separator >= 0 ? args.slice(separator + 1) : []);
  } else {
    throw new Error("usage: smoke.mjs runtime [--resources <dir>] [--voice <id>]... | smoke.mjs window [--executable <app>] [-- <args>]");
  }
  console.log(`PASS: desktop ${mode} smoke on ${process.platform}/${process.arch}`);
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
