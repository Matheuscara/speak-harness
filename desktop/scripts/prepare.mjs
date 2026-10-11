#!/usr/bin/env node
// Stages everything electron-builder packs next to app.asar, for the OS/CPU this runs on:
//   stage/runtime/bin/   official Bun and Node 22 binaries (pinned versions, SHA-256 verified)
//   stage/runtime/app/   SpeakHarness package.json, src, assets, notices and production node_modules
//   stage/icons/         icon.png / icon.ico rendered from assets/icon.svg
//   stage/licenses/      SpeakHarness, third-party, Node and Bun notices
// Native modules and runtimes are host-specific, so each installer is built on its own OS/CPU runner.
// Usage: node scripts/prepare.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

const NODE_VERSION = "22.23.3";
const BUN_VERSION = "1.4.2";
// x64 Bun uses the baseline (no AVX2) build so older CPUs and VMs can run the installer's payload.
const RUNTIMES = {
  "linux-x64": {
    node: ["node-v22.23.3-linux-x64.tar.gz", "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af"],
    bun: ["bun-linux-x64-baseline.zip", "c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f"],
  },
  "linux-arm64": {
    node: ["node-v22.23.3-linux-arm64.tar.gz", "5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2"],
    bun: ["bun-linux-aarch64.zip", "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7"],
  },
  "darwin-x64": {
    node: ["node-v22.23.3-darwin-x64.tar.gz", "8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8"],
    bun: ["bun-darwin-x64-baseline.zip", "bad5bbd6cf14d0980d115f5954c9ff904df619d5e994d2da1ffccd3f316300b0"],
  },
  "darwin-arm64": {
    node: ["node-v22.23.3-darwin-arm64.tar.gz", "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53"],
    bun: ["bun-darwin-aarch64.zip", "90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f"],
  },
  "win32-x64": {
    node: ["node-v22.23.3-win-x64.zip", "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71"],
    bun: ["bun-windows-x64-baseline.zip", "78c221c2376f79731ccf4e4af0b3bb46d81fefa3296c5abee09ad8a1b21e68c6"],
  },
};
const APP_FILES = ["package.json", "bun.lock", "tsconfig.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES"];
const APP_DIRS = ["src", "assets"];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
// Visual C++ runtime DLLs onnxruntime-node's Windows binding imports (UCRT itself ships with Windows 10+).
const VC_RUNTIME = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

const desktopDir = join(import.meta.dirname, "..");
const repoRoot = join(desktopDir, "..");
const cacheDir = join(desktopDir, ".cache");
const stageDir = join(desktopDir, "stage");
const runtimeDir = join(stageDir, "runtime");
const binDir = join(runtimeDir, "bin");
const appDir = join(runtimeDir, "app");
const iconsDir = join(stageDir, "icons");
const licensesDir = join(stageDir, "licenses");

const platform = process.platform;
const arch = process.arch;
const target = `${platform}-${arch}`;
const exe = platform === "win32" ? ".exe" : "";
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

function step(message) {
  console.log(`[stage] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error) throw new Error(`${command} ${args.join(" ")}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
  }
  return (result.stdout ?? "").trim();
}

// ---------- downloads ----------

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function download(url, file, expected) {
  const path = join(cacheDir, file);
  if (existsSync(path)) {
    const cached = readFileSync(path);
    if (sha256(cached) === expected) return cached;
    rmSync(path);
  }
  step(`downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = sha256(buffer);
  if (actual !== expected) throw new Error(`${file}: SHA-256 ${actual} does not match the pinned ${expected}`);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path, buffer);
  return buffer;
}

// ---------- archive readers (just enough for the official Node and Bun archives) ----------

function untarGz(buffer, wanted) {
  const tar = gunzipSync(buffer);
  const found = new Map();
  const field = (block, start, length) => block.toString("utf8", start, start + length).replace(/\0[\s\S]*$/, "");
  let longName;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (path) longName = path[1];
      continue;
    }
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0[\s\S]*$/, "");
      continue;
    }
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    if ((type === "0" || type === "\0") && wanted.includes(name)) found.set(name, Buffer.from(body));
  }
  return found;
}

function unzip(buffer, wanted) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error("zip64 archives are not supported");
  const found = new Map();
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted.includes(name)) continue;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressed);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : undefined;
    if (!data || data.length !== size) throw new Error(`${name}: unsupported or corrupt zip entry`);
    found.set(name, data);
  }
  return found;
}

function extract(buffer, file, wanted) {
  const found = file.endsWith(".zip") ? unzip(buffer, wanted) : untarGz(buffer, wanted);
  const missing = wanted.filter((name) => !found.has(name));
  if (missing.length > 0) throw new Error(`${file} does not contain ${missing.join(", ")}`);
  return found;
}

function writeExecutable(path, data) {
  writeFileSync(path, data);
  if (platform !== "win32") chmodSync(path, 0o755);
}

// ---------- runtimes ----------

async function stageNode(runtime) {
  const [file, hash] = runtime.node;
  const archive = await download(`https://nodejs.org/dist/v${NODE_VERSION}/${file}`, file, hash);
  const root = file.replace(/\.(tar\.gz|zip)$/, "");
  const binary = platform === "win32" ? `${root}/node.exe` : `${root}/bin/node`;
  const found = extract(archive, file, [binary, `${root}/LICENSE`]);
  writeExecutable(join(binDir, `node${exe}`), found.get(binary));
  writeFileSync(join(licensesDir, "node-LICENSE.txt"), found.get(`${root}/LICENSE`));
}

async function stageBun(runtime) {
  const [file, hash] = runtime.bun;
  const archive = await download(`https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${file}`, file, hash);
  const binary = `${file.replace(/\.zip$/, "")}/bun${exe}`;
  writeExecutable(join(binDir, `bun${exe}`), extract(archive, file, [binary]).get(binary));
  copyFileSync(join(desktopDir, "licenses", "bun-LICENSE.md"), join(licensesDir, "bun-LICENSE.md"));
}

// ---------- app payload ----------

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    visit(path, entry);
    if (entry.isDirectory()) walk(path, visit);
  }
}

/**
 * onnxruntime.dll and its Node binding link the Visual C++ 2015-2022 runtime dynamically, which a clean Windows
 * may lack. App-local copies next to the binding are found first (the DLL's own directory is searched).
 * Source: the redistributable folder of the newest Visual Studio install, or SPEAKH_VC_REDIST_DIR.
 */
function vcRedistDir() {
  const override = process.env.SPEAKH_VC_REDIST_DIR;
  if (override) return override;
  const programFiles = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const installs = existsSync(vswhere)
    ? run(vswhere, ["-all", "-products", "*", "-sort", "-property", "installationPath"]).split(/\r?\n/).filter(Boolean)
    : [];
  for (const install of installs) {
    const msvc = join(install, "VC", "Redist", "MSVC");
    if (!existsSync(msvc)) continue;
    for (const version of readdirSync(msvc).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort(compareVersions).reverse()) {
      const x64 = join(msvc, version, "x64");
      const crt = existsSync(x64) ? readdirSync(x64).find((name) => /^Microsoft\.VC\d+\.CRT$/.test(name)) : undefined;
      if (crt && VC_RUNTIME.every((dll) => existsSync(join(x64, crt, dll)))) return join(x64, crt);
    }
  }
  throw new Error(
    "Visual C++ x64 runtime DLLs not found: install Visual Studio (Build Tools) with the C++ workload or set SPEAKH_VC_REDIST_DIR",
  );
}

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function stageVcRuntime(bindingDir) {
  const source = vcRedistDir();
  for (const dll of VC_RUNTIME) copyFileSync(join(source, dll), join(bindingDir, dll));
  step(`bundled the Visual C++ runtime from ${source}`);
}

function stageApp() {
  mkdirSync(appDir, { recursive: true });
  for (const file of APP_FILES) copyFileSync(join(repoRoot, file), join(appDir, file));
  for (const dir of APP_DIRS) cpSync(join(repoRoot, dir), join(appDir, dir), { recursive: true });

  step(`installing production dependencies with Bun ${BUN_VERSION}`);
  run(
    join(binDir, `bun${exe}`),
    ["install", "--frozen-lockfile", "--production", "--ignore-scripts", "--no-progress", "--linker", "hoisted"],
    { cwd: appDir, stdio: "inherit" },
  );
  const nodeModules = join(appDir, "node_modules");
  rmSync(join(nodeModules, ".bin"), { recursive: true, force: true });

  // onnxruntime-node ships every platform's binding in one package; keep only this one.
  const napi = join(nodeModules, "onnxruntime-node", "bin", "napi-v3");
  for (const os of readdirSync(napi)) if (os !== platform) rmSync(join(napi, os), { recursive: true, force: true });
  for (const cpu of readdirSync(join(napi, platform))) if (cpu !== arch) rmSync(join(napi, platform, cpu), { recursive: true, force: true });
  if (platform === "win32") stageVcRuntime(join(napi, platform, arch));

  // electron-builder and codesign handle symlinks poorly, and installers must not point outside themselves.
  const links = [];
  let longest = "";
  walk(appDir, (path, entry) => {
    if (entry.isSymbolicLink()) links.push(relative(appDir, path));
    const rel = relative(runtimeDir, path);
    if (rel.length > longest.length) longest = rel;
  });
  if (links.length > 0) throw new Error(`staged app contains symlinks: ${links.slice(0, 5).join(", ")}`);
  step(`longest staged path: ${longest.length} characters (resources/runtime/${longest.replaceAll("\\", "/")})`);
}

// ---------- icons ----------

/** 32-bit BGRA DIB for an ICO entry: bottom-up rows, double height, an all-zero AND mask (alpha decides). */
function icoBitmap(rgba, size) {
  const header = Buffer.alloc(40);
  const maskRow = Math.ceil(size / 32) * 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = ((size - 1 - y) * size + x) * 4;
      const to = (y * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(pixels.length + maskRow * size, 20);
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

function icoFile(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

async function stageIcons() {
  const { default: sharp } = await import("sharp");
  const svg = readFileSync(join(repoRoot, "assets", "icon.svg"));
  const { width } = await sharp(svg).metadata();
  // Rasterize at 4x the target and downscale, so small sizes stay crisp.
  const render = (size) => sharp(svg, { density: Math.min(2400, (72 * size * 4) / (width || 256)) }).resize(size, size);
  await render(1024).png().toFile(join(iconsDir, "icon.png"));
  mkdirSync(join(iconsDir, "linux"));
  for (const size of LINUX_ICON_SIZES) await render(size).png().toFile(join(iconsDir, "linux", `${size}x${size}.png`));
  const images = [];
  for (const size of ICO_SIZES) {
    if (size === 256) {
      images.push({ size, data: await render(size).png().toBuffer() });
    } else {
      const { data, info } = await render(size).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== size || info.height !== size || info.channels !== 4) throw new Error(`icon ${size}px rendered as ${info.width}x${info.height}x${info.channels}`);
      images.push({ size, data: icoBitmap(data, size) });
    }
  }
  writeFileSync(join(iconsDir, "icon.ico"), icoFile(images));
}

// ---------- verification on this host ----------

function verify() {
  const bun = join(binDir, `bun${exe}`);
  const node = join(binDir, `node${exe}`);
  const required = [
    "src/cli/main.ts",
    "src/engine/worker.ts",
    "src/web/public/index.html",
    "src/web/public/app.js",
    "src/web/public/app.css",
    "assets/icon.svg",
    "LICENSE",
    "THIRD_PARTY_NOTICES",
    `node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}`,
    "node_modules/kokoro-js/package.json",
    "node_modules/ephone/package.json",
  ];
  const missing = required.filter((path) => !existsSync(join(appDir, path)));
  if (missing.length > 0) throw new Error(`staged app is missing ${missing.join(", ")}`);

  const nodeVersion = run(node, ["--version"]);
  if (nodeVersion !== `v${NODE_VERSION}`) throw new Error(`bundled Node reports ${nodeVersion}, expected v${NODE_VERSION}`);
  const bunVersion = run(bun, ["--version"]);
  if (bunVersion !== BUN_VERSION) throw new Error(`bundled Bun reports ${bunVersion}, expected ${BUN_VERSION}`);
  const cli = run(bun, ["--no-install", join(appDir, "src", "cli", "main.ts"), "--version"], { cwd: appDir });
  if (cli !== `speakh ${rootPackage.version}`) throw new Error(`staged CLI reports "${cli}", expected "speakh ${rootPackage.version}"`);
  // The TTS worker's native inference binding must load in the bundled Node on this OS/CPU.
  run(node, ["-e", "require('onnxruntime-node')"], { cwd: appDir });
  step(`verified Node ${nodeVersion}, Bun ${bunVersion}, ${cli}, onnxruntime-node binding`);
}

// ---------- main ----------

const runtime = RUNTIMES[target];
if (!runtime) {
  console.error(`[stage] unsupported host ${target}; supported: ${Object.keys(RUNTIMES).join(", ")}`);
  process.exit(1);
}
try {
  step(`preparing SpeakHarness ${rootPackage.version} for ${target}`);
  rmSync(stageDir, { recursive: true, force: true });
  for (const dir of [binDir, iconsDir, licensesDir]) mkdirSync(dir, { recursive: true });
  await stageNode(runtime);
  await stageBun(runtime);
  stageApp();
  copyFileSync(join(repoRoot, "LICENSE"), join(licensesDir, "SpeakHarness-LICENSE.txt"));
  copyFileSync(join(repoRoot, "THIRD_PARTY_NOTICES"), join(licensesDir, "THIRD_PARTY_NOTICES.txt"));
  await stageIcons();
  verify();
  writeFileSync(
    join(stageDir, "manifest.json"),
    `${JSON.stringify({ platform, arch, version: rootPackage.version, node: NODE_VERSION, bun: BUN_VERSION }, null, 2)}\n`,
  );
  step(`staged ${relative(desktopDir, stageDir)} for ${target}`);
} catch (error) {
  console.error(`[stage] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
