import { watchFile, unwatchFile } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify, TomlError } from "smol-toml";
import { paths } from "../paths.ts";
import { LANGS } from "../types.ts";
import type { CommandId, Config, HarnessId, Lang } from "../types.ts";

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.length === 1 ? `Invalid config: ${issues[0]}` : `Invalid config:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export const COMMAND_IDS: readonly CommandId[] = [
  "play-pause",
  "stop",
  "next-sentence",
  "prev-sentence",
  "next-block",
  "prev-block",
  "repeat-sentence",
  "repeat-slower",
  "replay-message",
  "read-latest",
  "next-message",
  "prev-message",
  "read-table",
  "auto-read",
  "study-mode",
  "study-continue",
  "save-phrase",
  "voice-auto",
  "voice-primary",
  "voice-alternate",
  "speed-up",
  "speed-down",
  "switch-session",
  "messages",
  "phrases",
  "command-palette",
  "settings",
  "help",
  "quit",
];

/** Harnesses that have file adapters and can be enabled in `[harnesses]`. */
export const FILE_HARNESSES: readonly HarnessId[] = ["omp", "pi", "codex", "claude-code"];

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;

export const DEFAULT_CONFIG: Config = {
  voices: {
    primary: "kokoro:af_heart",
    alternate: "kokoro:pf_dora",
    autoLanguage: true,
    speed: 1,
    languages: { en: "kokoro:af_heart", "pt-BR": "piper:pt_BR-faber-medium" },
  },
  reading: {
    autoRead: false,
    autoReadQueue: "latest",
    tables: "summary",
    quoteCue: true,
    maxSegmentChars: 240,
  },
  study: {
    pauseAfterSentence: false,
    shadowing: false,
    shadowingFactor: 1,
    slowerSpeed: 0.75,
  },
  keys: {
    leader: "\\",
    "play-pause": ["space"],
    stop: ["s"],
    "next-sentence": ["l"],
    "prev-sentence": ["h"],
    "next-block": ["shift+l"],
    "prev-block": ["shift+h"],
    "repeat-sentence": ["r"],
    "repeat-slower": ["shift+r"],
    "replay-message": ["ctrl+r"],
    "read-latest": ["g"],
    "next-message": ["j"],
    "prev-message": ["k"],
    "read-table": ["shift+t"],
    "auto-read": ["a"],
    "study-mode": ["t"],
    "study-continue": ["return"],
    "save-phrase": ["p"],
    "voice-auto": ["0"],
    "voice-primary": ["1"],
    "voice-alternate": ["2"],
    "speed-up": ["+", "="],
    "speed-down": ["-"],
    "switch-session": ["tab"],
    messages: ["m"],
    phrases: ["shift+p"],
    "command-palette": [":"],
    settings: [","],
    help: ["?"],
    quit: ["q"],
  },
  wrap: { prefix: "ctrl+g" },
  harnesses: { enabled: [...FILE_HARNESSES] },
  lexicon: { en: {}, "pt-BR": {} },
};

export function cloneConfig(config: Config): Config {
  return structuredClone(config);
}

// ---------- Parsing ----------

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (isTable(value)) return "a table";
  return JSON.stringify(value) ?? String(value);
}

/** Reads one TOML section, recording type errors and unknown keys. */
class SectionReader {
  readonly #table: Table;
  readonly #name: string;
  readonly #known = new Set<string>();
  readonly #errors: string[];
  readonly #warnings: string[];

  constructor(table: Table, name: string, errors: string[], warnings: string[]) {
    this.#table = table;
    this.#name = name;
    this.#errors = errors;
    this.#warnings = warnings;
  }

  #take(key: string): unknown {
    this.#known.add(key);
    return this.#table[key];
  }

  #fail(key: string, expected: string, value: unknown): void {
    this.#errors.push(`${this.#name}.${key} must be ${expected} (got ${describe(value)})`);
  }

  string(key: string, fallback: string): string {
    const value = this.#take(key);
    if (value === undefined) return fallback;
    if (typeof value === "string" && value.trim() !== "") return value;
    this.#fail(key, "a non-empty string", value);
    return fallback;
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.#take(key);
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    this.#fail(key, "true or false", value);
    return fallback;
  }

  number(key: string, fallback: number, min: number, max: number, integer = false): number {
    const value = this.#take(key);
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))) {
      return value;
    }
    this.#fail(key, `${integer ? "an integer" : "a number"} between ${min} and ${max}`, value);
    return fallback;
  }

  choice<T extends string>(key: string, fallback: T, options: readonly T[]): T {
    const value = this.#take(key);
    if (value === undefined) return fallback;
    if (typeof value === "string" && (options as readonly string[]).includes(value)) return value as T;
    this.#fail(key, `one of ${options.map((o) => `"${o}"`).join(", ")}`, value);
    return fallback;
  }

  table(key: string): Table | undefined {
    const value = this.#take(key);
    if (value === undefined) return undefined;
    if (isTable(value)) return value;
    this.#fail(key, "a table", value);
    return undefined;
  }

  raw(key: string): unknown {
    return this.#take(key);
  }

  /** Marks keys as known without reading them (documented but unused settings). */
  ignore(...keys: string[]): void {
    for (const key of keys) this.#known.add(key);
  }

  finish(): void {
    for (const key of Object.keys(this.#table)) {
      if (!this.#known.has(key)) this.#warnings.push(`unknown setting ${this.#name}.${key} is ignored`);
    }
  }
}

export interface ConfigInspection {
  config: Config;
  /** Non-fatal findings, e.g. unknown settings. */
  warnings: string[];
}

/** Parses TOML into a full config (defaults merged). Throws `ConfigError` listing every invalid value. */
export function inspectConfig(toml: string): ConfigInspection {
  let doc: Table;
  try {
    doc = parse(toml) as Table;
  } catch (error) {
    const message = error instanceof TomlError || error instanceof Error ? error.message : String(error);
    throw new ConfigError([`TOML syntax error: ${message}`]);
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const config = cloneConfig(DEFAULT_CONFIG);
  const root = new SectionReader(doc, "config", errors, warnings);

  const voicesTable = root.table("voices");
  if (voicesTable) {
    const voices = new SectionReader(voicesTable, "voices", errors, warnings);
    config.voices.primary = voices.string("primary", config.voices.primary);
    config.voices.alternate = voices.string("alternate", config.voices.alternate);
    config.voices.autoLanguage = voices.boolean("auto_language", config.voices.autoLanguage);
    config.voices.speed = voices.number("speed", config.voices.speed, SPEED_MIN, SPEED_MAX);
    const languages = voices.table("languages");
    if (languages) {
      const reader = new SectionReader(languages, "voices.languages", errors, warnings);
      for (const lang of LANGS) config.voices.languages[lang] = reader.string(lang, config.voices.languages[lang]);
      reader.finish();
    }
    voices.finish();
  }

  const readingTable = root.table("reading");
  if (readingTable) {
    const reading = new SectionReader(readingTable, "reading", errors, warnings);
    config.reading.autoRead = reading.boolean("auto_read", config.reading.autoRead);
    config.reading.autoReadQueue = reading.choice("auto_read_queue", config.reading.autoReadQueue, ["latest", "all"]);
    config.reading.tables = reading.choice("tables", config.reading.tables, ["summary", "rows"]);
    config.reading.quoteCue = reading.boolean("quote_cue", config.reading.quoteCue);
    config.reading.maxSegmentChars = reading.number("max_segment_chars", config.reading.maxSegmentChars, 40, 2000, true);
    reading.choice("code_block_cue", "announce", ["announce"]);
    reading.finish();
  }

  const studyTable = root.table("study");
  if (studyTable) {
    const study = new SectionReader(studyTable, "study", errors, warnings);
    config.study.pauseAfterSentence = study.boolean("pause_after_sentence", config.study.pauseAfterSentence);
    config.study.shadowing = study.boolean("shadowing", config.study.shadowing);
    config.study.shadowingFactor = study.number("shadowing_factor", config.study.shadowingFactor, 0, 5);
    config.study.slowerSpeed = study.number("slower_speed", config.study.slowerSpeed, 0.25, 1);
    study.finish();
  }

  const keysTable = root.table("keys");
  if (keysTable) {
    for (const [key, value] of Object.entries(keysTable)) {
      if (key === "leader") {
        if (typeof value === "string" && value !== "") config.keys.leader = value;
        else errors.push(`keys.leader must be a non-empty string (got ${describe(value)})`);
        continue;
      }
      if (!(COMMAND_IDS as readonly string[]).includes(key)) {
        errors.push(`keys.${key}: unknown command "${key}" (see \`speakh --help\` for command ids)`);
        continue;
      }
      const bindings = typeof value === "string" ? [value] : value;
      if (Array.isArray(bindings) && bindings.every((b) => typeof b === "string" && b.trim() !== "")) {
        config.keys[key as CommandId] = bindings as string[];
      } else {
        errors.push(`keys.${key} must be a key string or an array of key strings (got ${describe(value)})`);
      }
    }
  }

  const wrapTable = root.table("wrap");
  if (wrapTable) {
    const wrap = new SectionReader(wrapTable, "wrap", errors, warnings);
    config.wrap.prefix = wrap.string("prefix", config.wrap.prefix);
    wrap.finish();
  }

  const harnessesTable = root.table("harnesses");
  if (harnessesTable) {
    const harnesses = new SectionReader(harnessesTable, "harnesses", errors, warnings);
    const enabled = harnesses.raw("enabled");
    if (enabled !== undefined) {
      if (Array.isArray(enabled) && enabled.every((h) => typeof h === "string" && (FILE_HARNESSES as readonly string[]).includes(h))) {
        config.harnesses.enabled = [...new Set(enabled as HarnessId[])];
      } else {
        errors.push(
          `harnesses.enabled must be an array with any of ${FILE_HARNESSES.map((h) => `"${h}"`).join(", ")} (got ${describe(enabled)})`,
        );
      }
    }
    harnesses.finish();
  }

  const lexiconTable = root.table("lexicon");
  if (lexiconTable) {
    for (const [lang, entries] of Object.entries(lexiconTable)) {
      if (!(LANGS as readonly string[]).includes(lang)) {
        errors.push(`lexicon.${lang}: unknown language (expected ${LANGS.map((l) => `"${l}"`).join(", ")})`);
        continue;
      }
      if (!isTable(entries)) {
        errors.push(`lexicon.${lang} must be a table of word = "pronunciation" (got ${describe(entries)})`);
        continue;
      }
      for (const [word, spoken] of Object.entries(entries)) {
        if (typeof spoken === "string") config.lexicon[lang as Lang][word] = spoken;
        else errors.push(`lexicon.${lang}.${word} must be a string (got ${describe(spoken)})`);
      }
    }
  }

  root.ignore("voices", "reading", "study", "keys", "wrap", "harnesses", "lexicon");
  root.finish();

  if (errors.length > 0) throw new ConfigError(errors);
  return { config, warnings };
}

export function parseConfig(toml: string): Config {
  return inspectConfig(toml).config;
}

/** Warnings for configured voices that `isKnown` does not recognize. Unknown voices are never fatal. */
export function unknownVoiceWarnings(config: Config, isKnown: (voiceId: string) => boolean): string[] {
  const slots: [string, string][] = [
    ["voices.primary", config.voices.primary],
    ["voices.alternate", config.voices.alternate],
    ...LANGS.map((lang): [string, string] => [`voices.languages.${lang}`, config.voices.languages[lang]]),
  ];
  return slots
    .filter(([, voice]) => !isKnown(voice))
    .map(([slot, voice]) => `${slot}: unknown voice "${voice}" (see \`speakh voices list\`)`);
}

// ---------- Serialization ----------

export function serializeConfig(config: Config): string {
  const keys: Record<string, string | string[]> = { leader: config.keys.leader };
  for (const id of COMMAND_IDS) {
    const bindings = config.keys[id];
    if (bindings === undefined) continue;
    keys[id] = bindings.length === 1 ? (bindings[0] as string) : [...bindings];
  }
  const lexicon: Record<string, Record<string, string>> = {};
  for (const lang of LANGS) {
    const entries = config.lexicon[lang];
    if (entries && Object.keys(entries).length > 0) lexicon[lang] = { ...entries };
  }
  const doc: Record<string, unknown> = {
    voices: {
      primary: config.voices.primary,
      alternate: config.voices.alternate,
      auto_language: config.voices.autoLanguage,
      speed: config.voices.speed,
      languages: { ...config.voices.languages },
    },
    reading: {
      auto_read: config.reading.autoRead,
      auto_read_queue: config.reading.autoReadQueue,
      tables: config.reading.tables,
      quote_cue: config.reading.quoteCue,
      max_segment_chars: config.reading.maxSegmentChars,
    },
    study: {
      pause_after_sentence: config.study.pauseAfterSentence,
      shadowing: config.study.shadowing,
      shadowing_factor: config.study.shadowingFactor,
      slower_speed: config.study.slowerSpeed,
    },
    keys,
    wrap: { prefix: config.wrap.prefix },
    harnesses: { enabled: [...config.harnesses.enabled] },
  };
  if (Object.keys(lexicon).length > 0) doc.lexicon = lexicon;
  return `# SpeakHarness config. Edits are applied live; invalid edits keep the last valid config.\n\n${stringify(doc)}\n`;
}

// ---------- Files ----------

/** Reads and validates the config file. A missing file yields the defaults and is not created. */
export async function readConfig(path: string = paths.configFile()): Promise<ConfigInspection> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { config: cloneConfig(DEFAULT_CONFIG), warnings: [] };
    }
    throw error;
  }
  return inspectConfig(text);
}

export async function loadConfig(path: string = paths.configFile()): Promise<Config> {
  return (await readConfig(path)).config;
}

/** Writes the config atomically, creating the file and its directory when missing. */
export async function saveConfig(config: Config, path: string = paths.configFile()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, serializeConfig(config), "utf8");
  await rename(temp, path);
}

/**
 * Hot reload: calls `onChange` with each new valid config and `onError` for invalid edits (the caller keeps
 * its last valid config). Polls the file's stat, which survives atomic replacement and missing directories.
 * Returns a function that stops watching.
 */
export function watchConfig(
  path: string,
  onChange: (config: Config) => void,
  onError: (error: Error) => void,
  options: { intervalMs?: number; onWarnings?: (warnings: string[]) => void } = {},
): () => void {
  let lastText: string | undefined;
  let stopped = false;

  const check = async (): Promise<void> => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        onError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      text = "";
    }
    if (stopped || text === lastText) return;
    lastText = text;
    try {
      const { config, warnings } = inspectConfig(text);
      if (warnings.length > 0) options.onWarnings?.(warnings);
      onChange(config);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  // Record the current contents first so only later edits are reported.
  let reading: Promise<void> = readFile(path, "utf8").then(
    (text) => {
      lastText ??= text;
    },
    () => {
      lastText ??= "";
    },
  );

  const listener = (): void => {
    reading = reading.then(check);
  };
  watchFile(path, { interval: options.intervalMs ?? 500, persistent: false }, listener);
  return () => {
    stopped = true;
    unwatchFile(path, listener);
  };
}
