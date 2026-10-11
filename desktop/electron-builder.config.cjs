// electron-builder configuration for the SpeakHarness desktop installers. Run `node scripts/prepare.mjs`
// first: it stages the Bun/Node runtimes, the production app payload, icons and notices under `stage/`.
// The runtime ships as extraResources (outside app.asar) because Bun and Node read it as plain files.
const { existsSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const root = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
const stage = join(__dirname, "stage");
const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

function stagedManifest() {
  const file = join(stage, "manifest.json");
  if (!existsSync(file)) throw new Error("desktop/stage is missing: run `node scripts/prepare.mjs` before electron-builder");
  return JSON.parse(readFileSync(file, "utf8"));
}

/** The staged runtime carries native binaries for one OS/CPU; packaging it for another would ship a dead app. */
function beforePack({ electronPlatformName, arch }) {
  const manifest = stagedManifest();
  const target = `${electronPlatformName}-${ARCH_NAMES[arch]}`;
  if (`${manifest.platform}-${manifest.arch}` !== target)
    throw new Error(`stage/ holds a ${manifest.platform}-${manifest.arch} runtime but electron-builder is packaging ${target}`);
  if (manifest.version !== root.version) throw new Error(`stage/ was prepared for ${manifest.version}, package.json is ${root.version}`);
}

/** electron-builder only warns when an extraResources source is missing; an incomplete package must fail. */
function afterPack({ appOutDir, electronPlatformName, arch, packager }) {
  const resources =
    electronPlatformName === "darwin"
      ? join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : join(appOutDir, "resources");
  const exe = electronPlatformName === "win32" ? ".exe" : "";
  const binding = `runtime/app/node_modules/onnxruntime-node/bin/napi-v3/${electronPlatformName}/${ARCH_NAMES[arch]}`;
  const required = [
    `runtime/bin/bun${exe}`,
    `runtime/bin/node${exe}`,
    "runtime/app/package.json",
    "runtime/app/src/cli/main.ts",
    "runtime/app/src/engine/worker.ts",
    "runtime/app/src/web/public/index.html",
    "runtime/app/assets/icon.svg",
    `${binding}/onnxruntime_binding.node`,
    ...(exe ? ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"].map((dll) => `${binding}/${dll}`) : []),
    "runtime/app/node_modules/kokoro-js/package.json",
    "runtime/app/node_modules/ephone/package.json",
    "runtime/app/LICENSE",
    "runtime/app/THIRD_PARTY_NOTICES",
    "licenses/node-LICENSE.txt",
    "licenses/bun-LICENSE.md",
    "icons/icon.png",
  ];
  const missing = required.filter((path) => !existsSync(join(resources, path)));
  if (missing.length > 0) throw new Error(`packaged app is missing ${missing.join(", ")} under ${resources}`);
  if (exe === "") {
    for (const binary of ["runtime/bin/bun", "runtime/bin/node"]) {
      if ((statSync(join(resources, binary)).mode & 0o111) === 0) throw new Error(`${binary} lost its executable bit`);
    }
  }
}

const signingConfigured = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

module.exports = {
  appId: "io.github.matheuscara.speakharness",
  productName: "SpeakHarness",
  copyright: "Copyright © 2026 Matheuscara",
  // desktopName is Electron's Wayland app_id / X11 WM_CLASS; distinct from the Nix CLI's speak-harness.desktop.
  extraMetadata: { version: root.version, desktopName: "speak-harness-desktop.desktop" },
  directories: { output: "dist", buildResources: "build-resources" },
  files: ["package.json", "src/**/*"],
  asar: true,
  // The Electron app has no dependencies; the runtime's native modules are staged for Bun/Node, not Electron.
  npmRebuild: false,
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
    resetAdHocDarwinSignature: true,
  },
  extraResources: [
    { from: "stage/runtime", to: "runtime" },
    { from: "stage/icons/icon.png", to: "icons/icon.png" },
    { from: "stage/licenses", to: "licenses" },
  ],
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  publish: null,
  beforePack,
  afterPack,
  // Static AppImage runtime: no libfuse2 requirement on current distributions; native arm64 tools.
  toolsets: { appimage: "1.0.3" },
  linux: {
    target: ["AppImage", "deb"],
    // Directory of <size>x<size>.png files, installed into the hicolor theme at each size.
    icon: "stage/icons/linux",
    category: "Utility",
    executableName: "speak-harness-desktop",
    syncDesktopName: true,
    synopsis: "Read AI coding-harness answers aloud, locally",
    description: "Local voice companion for OMP, Pi, Codex and Claude Code: the SpeakHarness listening dashboard in its own window.",
    maintainer: "Matheuscara <61706310+Matheuscara@users.noreply.github.com>",
  },
  deb: {
    // electron-builder's defaults plus the libraries Chromium links that minimal systems may lack.
    depends: [
      "libgtk-3-0",
      "libnotify4",
      "libnss3",
      "libxss1",
      "libxtst6",
      "xdg-utils",
      "libatspi2.0-0",
      "libuuid1",
      "libsecret-1-0",
      "libasound2t64 | libasound2",
      "libgbm1",
      "libdrm2",
      "libxkbcommon0",
      "libxrandr2",
      "libxcomposite1",
      "libxdamage1",
    ],
    // The dashboard plays speech through the first system player it finds.
    recommends: ["pipewire-bin | pulseaudio-utils | alsa-utils"],
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "stage/icons/icon.ico",
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: "stage/icons/icon.ico",
    uninstallerIcon: "stage/icons/icon.ico",
    shortcutName: "SpeakHarness",
    artifactName: "${productName}-Setup-${version}-${arch}.${ext}",
  },
  mac: {
    target: ["dmg"],
    icon: "stage/icons/icon.png",
    category: "public.app-category.utilities",
    // Ad-hoc signature unless a Developer ID certificate is provided (CSC_LINK/CSC_NAME); Apple Silicon
    // refuses to run unsigned code. Notarization runs when APPLE_* credentials are present.
    identity: signingConfigured ? undefined : "-",
    hardenedRuntime: true,
    entitlements: "build-resources/entitlements.mac.plist",
    entitlementsInherit: "build-resources/entitlements.mac.plist",
  },
  dmg: {
    artifactName: "${productName}-${version}-mac-${arch}.${ext}",
  },
};
