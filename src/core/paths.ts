import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";

const APP = "speak-harness";

/** Where the control server listens: a directory of per-instance sockets (POSIX) or one per-user named pipe (Windows). */
export type ControlEndpoint = { dir: string } | { pipe: string };

export interface AppPaths {
  configFile: string;
  cacheDir: string;
  dataDir: string;
  phrasesFile: string;
  logFile: string;
  control: ControlEndpoint;
}

type Env = Readonly<Record<string, string | undefined>>;

/** `\\?\C:\`, `C:\`, `C:/` or a UNC share; anything else in a known-folder variable is ignored. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/**
 * The per-user control pipe. Named pipes share one machine-wide namespace, so the name carries a digest of the user's
 * profile directory: unique per account, free of characters a pipe name cannot hold, and computable by the OMP
 * extension (src/integrations/omp.js mirrors this function).
 */
export function windowsControlPipe(home: string): string {
  const profile = win32.normalize(home).replace(/\\+$/, "").toLowerCase();
  return `\\\\.\\pipe\\${APP}-${createHash("sha256").update(profile).digest("hex").slice(0, 16)}`;
}

function windowsPaths(env: Env, home: string): AppPaths {
  const knownFolder = (variable: string, ...fallback: string[]) => {
    const value = env[variable];
    return value && WINDOWS_ABSOLUTE.test(value) ? value : win32.join(home, ...fallback);
  };
  // Settings and phrases roam with the profile; the model cache and the log stay on this machine.
  const roaming = win32.join(knownFolder("APPDATA", "AppData", "Roaming"), APP);
  const local = win32.join(knownFolder("LOCALAPPDATA", "AppData", "Local"), APP);
  return {
    configFile: win32.join(roaming, "config.toml"),
    cacheDir: win32.join(local, "cache"),
    dataDir: roaming,
    phrasesFile: win32.join(roaming, "phrases.md"),
    logFile: win32.join(local, "speakh.log"),
    control: { pipe: windowsControlPipe(home) },
  };
}

function posixPaths(env: Env, home: string): AppPaths {
  // XDG base directories must be absolute; relative values are ignored.
  const xdg = (variable: string, fallback: string) => {
    const value = env[variable];
    return value && value.startsWith("/") ? value : posix.join(home, fallback);
  };
  const runtime = env.XDG_RUNTIME_DIR || posix.join(tmpdir(), `${APP}-${process.getuid?.() ?? "user"}`);
  return {
    configFile: posix.join(xdg("XDG_CONFIG_HOME", ".config"), APP, "config.toml"),
    cacheDir: posix.join(xdg("XDG_CACHE_HOME", ".cache"), APP),
    dataDir: posix.join(xdg("XDG_DATA_HOME", ".local/share"), APP),
    phrasesFile: posix.join(xdg("XDG_DATA_HOME", ".local/share"), APP, "phrases.md"),
    logFile: posix.join(xdg("XDG_STATE_HOME", ".local/state"), APP, "speakh.log"),
    control: { dir: posix.join(runtime, APP) },
  };
}

/** Per-user locations on `platform`: APPDATA/LOCALAPPDATA and a named pipe on Windows, XDG directories elsewhere. */
export function resolvePaths(platform: NodeJS.Platform, env: Env, home: string): AppPaths {
  return platform === "win32" ? windowsPaths(env, home) : posixPaths(env, home);
}

const current = (): AppPaths => resolvePaths(process.platform, process.env, homedir());

export const paths = {
  configFile: () => current().configFile,
  cacheDir: () => current().cacheDir,
  dataDir: () => current().dataDir,
  phrasesFile: () => current().phrasesFile,
  logFile: () => current().logFile,
  controlEndpoint: () => current().control,
};
