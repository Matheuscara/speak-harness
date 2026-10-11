import { describe, expect, test } from "bun:test";
import { resolvePaths } from "../../src/core/paths.ts";

describe("Windows", () => {
  const home = "C:\\Users\\Ana Maria";

  test("settings and phrases roam in APPDATA; cache and log stay in LOCALAPPDATA", () => {
    const env = { APPDATA: "D:\\Profiles\\ana\\Roaming", LOCALAPPDATA: "D:\\Profiles\\ana\\Local", XDG_CONFIG_HOME: "/x" };
    expect(resolvePaths("win32", env, home)).toMatchObject({
      configFile: "D:\\Profiles\\ana\\Roaming\\speak-harness\\config.toml",
      phrasesFile: "D:\\Profiles\\ana\\Roaming\\speak-harness\\phrases.md",
      cacheDir: "D:\\Profiles\\ana\\Local\\speak-harness\\cache",
      logFile: "D:\\Profiles\\ana\\Local\\speak-harness\\speakh.log",
    });
  });

  test("missing or relative known folders fall back inside the user profile", () => {
    for (const env of [{}, { APPDATA: "Roaming", LOCALAPPDATA: "" }, { APPDATA: "\\Roaming", LOCALAPPDATA: "C:Local" }]) {
      const resolved = resolvePaths("win32", env, home);
      expect(resolved.configFile).toBe("C:\\Users\\Ana Maria\\AppData\\Roaming\\speak-harness\\config.toml");
      expect(resolved.cacheDir).toBe("C:\\Users\\Ana Maria\\AppData\\Local\\speak-harness\\cache");
    }
  });

  test("control goes through one named pipe per user profile", () => {
    const pipe = (profile: string) => {
      const control = resolvePaths("win32", {}, profile).control;
      if (!("pipe" in control)) throw new Error("expected a pipe");
      return control.pipe;
    };
    expect(pipe(home)).toMatch(/^\\\\\.\\pipe\\speak-harness-[0-9a-f]{16}$/);
    // Spelling of the same profile does not change the identity; another profile gets another pipe.
    expect(pipe("c:/users/ana maria/")).toBe(pipe(home));
    expect(pipe("C:\\Users\\Ana")).not.toBe(pipe(home));
  });
});

describe("POSIX", () => {
  const home = "/home/ana";

  test("absolute XDG directories are honored and relative ones ignored", () => {
    const env = { XDG_CONFIG_HOME: "/cfg", XDG_CACHE_HOME: "cache", XDG_DATA_HOME: "/data", XDG_RUNTIME_DIR: "/run/user/1000" };
    expect(resolvePaths("linux", env, home)).toEqual({
      configFile: "/cfg/speak-harness/config.toml",
      cacheDir: "/home/ana/.cache/speak-harness",
      dataDir: "/data/speak-harness",
      phrasesFile: "/data/speak-harness/phrases.md",
      logFile: "/home/ana/.local/state/speak-harness/speakh.log",
      control: { dir: "/run/user/1000/speak-harness" },
    });
  });

  test("APPDATA means nothing outside Windows", () => {
    expect(resolvePaths("darwin", { APPDATA: "C:\\Roaming" }, home).configFile).toBe("/home/ana/.config/speak-harness/config.toml");
  });
});
