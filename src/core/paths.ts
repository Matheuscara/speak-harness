import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const APP = "speak-harness";

function xdg(variable: string, fallback: string): string {
  const value = process.env[variable];
  return value && value.startsWith("/") ? value : join(homedir(), fallback);
}

export const paths = {
  configFile: () => join(xdg("XDG_CONFIG_HOME", ".config"), APP, "config.toml"),
  cacheDir: () => join(xdg("XDG_CACHE_HOME", ".cache"), APP),
  dataDir: () => join(xdg("XDG_DATA_HOME", ".local/share"), APP),
  phrasesFile: () => join(xdg("XDG_DATA_HOME", ".local/share"), APP, "phrases.md"),
  runtimeDir: () => join(process.env.XDG_RUNTIME_DIR || join(tmpdir(), `${APP}-${process.getuid?.() ?? "user"}`), APP),
};
