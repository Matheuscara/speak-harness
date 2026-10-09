import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  DEFAULT_CONFIG,
  inspectConfig,
  loadConfig,
  parseConfig,
  saveConfig,
  serializeConfig,
  unknownVoiceWarnings,
  watchConfig,
} from "../../src/core/config/index.ts";
import type { Config } from "../../src/core/types.ts";

function configError(toml: string): ConfigError {
  try {
    parseConfig(toml);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("parseConfig", () => {
  test("empty file yields the defaults", () => {
    expect(parseConfig("")).toEqual(DEFAULT_CONFIG);
  });

  test("reads snake_case keys and merges defaults", () => {
    const config = parseConfig(`
[voices]
speed = 1.3
auto_language = false

[voices.languages]
"pt-BR" = "kokoro:pf_dora"

[reading]
auto_read = true
auto_read_queue = "all"
code_block_cue = "announce"

[study]
shadowing_factor = 2
`);
    expect(config.voices).toMatchObject({ speed: 1.3, autoLanguage: false, primary: "kokoro:af_heart" });
    expect(config.voices.languages).toEqual({ en: "kokoro:af_heart", "pt-BR": "kokoro:pf_dora" });
    expect(config.reading).toMatchObject({ autoRead: true, autoReadQueue: "all", tables: "summary" });
    expect(config.study.shadowingFactor).toBe(2);
  });

  test("[keys] accepts a string or an array and keeps defaults for other commands", () => {
    const config = parseConfig(`
[keys]
leader = ","
play-pause = "k"
stop = ["s", "x"]
quit = []
`);
    expect(config.keys.leader).toBe(",");
    expect(config.keys["play-pause"]).toEqual(["k"]);
    expect(config.keys.stop).toEqual(["s", "x"]);
    expect(config.keys.quit).toEqual([]);
    expect(config.keys["speed-up"]).toEqual(["+", "="]);
  });

  test("unknown command ids in [keys] are errors", () => {
    const error = configError(`[keys]\nplay-pauze = "space"`);
    expect(error.message).toContain('unknown command "play-pauze"');
  });

  test("reports every bad value with its path", () => {
    const error = configError(`
[voices]
speed = "fast"

[reading]
tables = "all"
max_segment_chars = 12.5

[harnesses]
enabled = ["omp", "vim"]
`);
    expect(error.issues).toHaveLength(4);
    expect(error.message).toContain('voices.speed must be a number between 0.5 and 2 (got "fast")');
    expect(error.message).toContain("reading.tables must be one of");
    expect(error.message).toContain("reading.max_segment_chars must be an integer");
    expect(error.message).toContain("harnesses.enabled");
  });

  test("speed outside 0.5–2.0 is rejected", () => {
    expect(configError(`[voices]\nspeed = 3`).message).toContain("voices.speed");
  });

  test("TOML syntax errors become ConfigError", () => {
    expect(configError(`[voices\nspeed = 1`).message).toContain("TOML syntax error");
  });

  test("unknown settings are warnings, not errors", () => {
    const { warnings } = inspectConfig(`[voices]\nvolume = 3\n[extra]\na = 1`);
    expect(warnings).toEqual(["unknown setting voices.volume is ignored", "unknown setting config.extra is ignored"]);
  });

  test("unknown voices are warnings", () => {
    const config = parseConfig(`[voices]\nalternate = "kokoro:nobody"`);
    const warnings = unknownVoiceWarnings(config, (id) => id !== "kokoro:nobody");
    expect(warnings).toEqual(['voices.alternate: unknown voice "kokoro:nobody" (see `speakh voices list`)']);
  });

  test("lexicon entries per language", () => {
    const config = parseConfig(`[lexicon.en]\nTTL = "T T L"\n[lexicon."pt-BR"]\nex = "por exemplo"`);
    expect(config.lexicon).toEqual({ en: { TTL: "T T L" }, "pt-BR": { ex: "por exemplo" } });
    expect(configError(`[lexicon.fr]\na = "b"`).message).toContain("unknown language");
  });
});

describe("serializeConfig", () => {
  test("round-trips a modified config", () => {
    const config: Config = structuredClone(DEFAULT_CONFIG);
    config.voices.speed = 1.4;
    config.voices.languages["pt-BR"] = "piper:pt_BR-cadu-medium";
    config.reading.autoRead = true;
    config.study.slowerSpeed = 0.6;
    config.keys["play-pause"] = ["space", "k"];
    config.keys.stop = ["x"];
    config.harnesses.enabled = ["omp", "codex"];
    config.lexicon.en = { SQL: "S Q L" };
    const toml = serializeConfig(config);
    expect(toml).toContain("auto_read = true");
    expect(toml).toContain('stop = "x"');
    expect(parseConfig(toml)).toEqual(config);
  });

  test("defaults round-trip", () => {
    expect(parseConfig(serializeConfig(DEFAULT_CONFIG))).toEqual(DEFAULT_CONFIG);
  });
});

describe("config files", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "speakh-config-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("missing file loads defaults without creating it; save creates it", async () => {
    const path = join(dir, "nested", "config.toml");
    expect(await loadConfig(path)).toEqual(DEFAULT_CONFIG);
    expect(existsSync(path)).toBe(false);
    const config = structuredClone(DEFAULT_CONFIG);
    config.reading.autoRead = true;
    await saveConfig(config, path);
    expect(await readFile(path, "utf8")).toContain("auto_read = true");
    expect(await loadConfig(path)).toEqual(config);
  });

  test("watch reports valid edits and errors, keeping the caller's last valid config", async () => {
    // Real time on purpose: this exercises fs.watchFile stat polling, which fake timers cannot drive.
    const path = join(dir, "config.toml");
    await writeFile(path, "[voices]\nspeed = 1\n");
    const changes: Config[] = [];
    const errors: Error[] = [];
    const stop = watchConfig(path, (config) => changes.push(config), (error) => errors.push(error), { intervalMs: 10 });
    try {
      await Bun.sleep(50); // let the watcher record the initial contents before the first edit
      await writeFile(path, "[voices]\nspeed = 1.5\n");
      await waitFor(() => changes.length === 1);
      expect(changes[0]?.voices.speed).toBe(1.5);

      await writeFile(path, "[voices]\nspeed = 'very fast'\n");
      await waitFor(() => errors.length === 1);
      expect(errors[0]).toBeInstanceOf(ConfigError);
      expect(changes).toHaveLength(1);
    } finally {
      stop();
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}
