import { createAdapters } from "../adapters/index.ts";
import { createAudioOutput } from "../audio/index.ts";
import { createEngineClient } from "../engine/client.ts";
import { findVoice } from "../engine/catalog.ts";
import { createCommandRegistry } from "./commands.ts";
import { cloneConfig, DEFAULT_CONFIG, parseConfig, readConfig, saveConfig, serializeConfig, unknownVoiceWarnings, watchConfig } from "./config/index.ts";
import { NO_LOG, type Logger } from "./log.ts";
import { paths } from "./paths.ts";
import { createPhraseStore } from "./phrases.ts";
import { createPlaybackController } from "./playback/controller.ts";
import type { PlaybackDeps } from "./playback/controller.ts";
import { createSessionService } from "./sessions.ts";
import { buildSpeechScript, buildTableScript, speechOptionsFromConfig } from "./speech/index.ts";
import type {
  AppCore,
  AppEvent,
  AudioOutput,
  Command,
  CommandId,
  Config,
  EngineClient,
  HarnessMessage,
  PhraseStore,
  SessionService,
  SpeechOptions,
  SpeechScript,
  VoiceOverride,
} from "./types.ts";

export interface AppOptions {
  cwd: string;
  /** Config file to load, watch, and save. Defaults to the XDG config file unless `config` is given. */
  configPath?: string;
  /** Initial config. Without `configPath`, changes stay in memory and nothing is watched or saved. */
  config?: Config;
  engine?: EngineClient;
  audio?: AudioOutput;
  sessions?: SessionService;
  phrases?: PhraseStore;
  /** Follow the newest harness session for `cwd` (default true; `speakh say` turns it off). */
  followSessions?: boolean;
  /** Forces auto-read for this process without changing the config file (`speakh follow`). */
  autoRead?: boolean;
  /** Abortable delay used between segments; injected by tests. */
  sleep?: PlaybackDeps["sleep"];
  /** Where warnings, errors and session changes are recorded (default: nowhere). */
  logger?: Logger;
}

/** Opens the system player on first use, so a missing player only fails when something is spoken. */
function lazyAudioOutput(): AudioOutput {
  let output: Promise<AudioOutput> | undefined;
  let name = "auto";
  return {
    get playerName() {
      return name;
    },
    async play(chunk, signal) {
      output ??= createAudioOutput();
      let audio: AudioOutput;
      try {
        audio = await output;
      } catch (error) {
        output = undefined;
        throw error;
      }
      name = audio.playerName;
      return audio.play(chunk, signal);
    },
  };
}

const VOICE_LABELS: Record<VoiceOverride, string> = {
  auto: "auto (per language)",
  primary: "primary",
  alternate: "alternate",
};

/** Longest `speak-text` reply accepted (the OMP extension truncates to this). */
const MAX_SPEAK_TEXT_CHARS = 100_000;
const MAX_EVENT_ID_CHARS = 512;
/** Accepted `speak-text` event ids remembered for deduplication; the oldest are forgotten first. */
const SPOKEN_EVENTS_LIMIT = 256;

export async function createApp(options: AppOptions): Promise<AppCore> {
  const listeners = new Set<(event: AppEvent) => void>();
  /** Notices raised before anyone subscribed (e.g. config errors at startup) are delivered to the first subscriber. */
  const pendingNotices: AppEvent[] = [];
  const emit = (event: AppEvent): void => {
    if (listeners.size === 0) {
      if (event.type === "notice") pendingNotices.push(event);
      return;
    }
    for (const listener of [...listeners]) listener(event);
  };
  const logger = options.logger ?? NO_LOG;
  const notice = (level: "info" | "warning" | "error", text: string): void => {
    if (level !== "info") logger.write(level, text);
    emit({ type: "notice", level, text });
  };
  const isKnownVoice = (id: string): boolean => findVoice(id) !== undefined;

  // ---------- config ----------
  const configPath = options.configPath ?? (options.config ? undefined : paths.configFile());
  let config: Config;
  if (options.config) {
    config = cloneConfig(options.config);
  } else {
    try {
      const loaded = await readConfig(configPath);
      config = loaded.config;
      for (const warning of loaded.warnings) notice("warning", `Config: ${warning}`);
    } catch (error) {
      config = cloneConfig(DEFAULT_CONFIG);
      notice("error", `${error instanceof Error ? error.message : String(error)}\nUsing the default config.`);
    }
  }
  for (const warning of unknownVoiceWarnings(config, isKnownVoice)) notice("warning", `Config: ${warning}`);
  let configVersion = 0;
  let autoReadOverride = options.autoRead;

  // ---------- services ----------
  const engine = options.engine ?? createEngineClient();
  const audio = options.audio ?? lazyAudioOutput();
  const sessions = options.sessions ?? createSessionService(createAdapters(config.harnesses.enabled));
  const phrases = options.phrases ?? createPhraseStore();
  const playback = createPlaybackController({
    engine,
    audio,
    config: () => config,
    sleep: options.sleep,
  });
  const commands = createCommandRegistry();

  // ---------- speech scripts ----------
  const scripts = new Map<string, { version: number; markdown: string; script: SpeechScript }>();
  const speechOptions = (): SpeechOptions => speechOptionsFromConfig(config, findVoice(config.voices.primary)?.lang ?? "en");
  const scriptFor = (message: HarnessMessage): SpeechScript => {
    const cached = scripts.get(message.key);
    if (cached && cached.version === configVersion && cached.markdown === message.markdown) return cached.script;
    const script = buildSpeechScript(message.key, message.markdown, speechOptions());
    scripts.set(message.key, {
      version: configVersion,
      markdown: message.markdown,
      script,
    });
    return script;
  };

  // ---------- selection ----------
  let selected: string | undefined;
  /** Selection follows the newest answer until the user picks another one. */
  let followNewest = true;
  let emittedSelection: string | undefined;
  const findMessage = (key: string | undefined): HarnessMessage | undefined =>
    key === undefined ? undefined : sessions.messages.find((message) => message.key === key);
  /** Newest answer, skipping commentary (narration between tool calls). */
  const newestKey = (): string | undefined => sessions.messages.findLast((message) => !message.commentary)?.key;
  const selectedKey = (): string | undefined => {
    if (followNewest || !findMessage(selected)) return newestKey();
    return selected;
  };
  const emitSelection = (): void => {
    const key = selectedKey();
    if (key === emittedSelection) return;
    emittedSelection = key;
    emit({ type: "selection", messageKey: key });
  };
  const selectMessage = (key: string): void => {
    selected = key;
    followNewest = key === newestKey();
    emitSelection();
  };

  const readMessage = (key: string, fromSegment = 0): void => {
    const message = findMessage(key);
    if (!message) {
      notice("warning", "That answer is no longer available.");
      return;
    }
    selectMessage(key);
    const script = scriptFor(message);
    if (script.segments.length === 0) {
      notice("info", "Nothing to read in this answer.");
      return;
    }
    playback.play(script, fromSegment);
  };

  // ---------- auto-read ----------
  const autoReadQueue: string[] = [];
  const autoReadSeen = new Set<string>();
  const autoReadEnabled = (): boolean => autoReadOverride ?? config.reading.autoRead;

  // ---------- external replies (`speak-text`) ----------
  /**
   * Newest reply from an integration waiting for the player. External replies never interrupt speech, never
   * join the followed session's messages or selection, and only the latest one waits.
   */
  let pendingExternal: SpeechScript | undefined;
  const spokenEvents = new Set<string>();
  const speakExternal = (args: string[]): void => {
    if (args.length !== 3) throw new Error("speak-text expects [eventId, markdown, sourceSessionId]");
    const [eventId = "", markdown = "", sourceSessionId = ""] = args;
    if (eventId.trim() === "" || eventId.length > MAX_EVENT_ID_CHARS) {
      throw new Error(`speak-text: the event id must have 1–${MAX_EVENT_ID_CHARS} characters`);
    }
    if (markdown.trim() === "") throw new Error("speak-text: the reply is empty");
    if (markdown.length > MAX_SPEAK_TEXT_CHARS) throw new Error(`speak-text: the reply exceeds ${MAX_SPEAK_TEXT_CHARS} characters`);
    if (spokenEvents.has(eventId)) return;
    spokenEvents.add(eventId);
    if (spokenEvents.size > SPOKEN_EVENTS_LIMIT) spokenEvents.delete(spokenEvents.values().next().value as string);
    // The followed transcript already auto-reads this reply; speaking it here too would play it twice.
    const followed = sessions.session;
    if (autoReadEnabled() && followed?.harness === "omp" && followed.id === sourceSessionId) return;
    const script = buildSpeechScript(eventId, markdown, speechOptions());
    if (script.segments.length === 0) return;
    if (playback.state.status !== "idle") {
      pendingExternal = script;
      return;
    }
    pendingExternal = undefined;
    playback.play(script);
  };

  const unsubscribeSessions = sessions.subscribe((event) => {
    if (event.type === "warning") {
      notice("warning", `${event.harness}: ${event.message}`);
      return;
    }
    if (event.type === "session") {
      const session = event.session;
      logger.write("info", session ? `following ${session.harness} session ${session.title ?? session.id} (${session.path ?? "no file"})` : "no session");
      selected = undefined;
      followNewest = true;
      autoReadQueue.length = 0;
      emitSelection();
      return;
    }
    const { message } = event;
    emitSelection();
    // A repeated key is an update of the same answer (its cached script is rebuilt from the new text); never re-read it.
    if (!message.final || message.historical || message.commentary || autoReadSeen.has(message.key)) return;
    autoReadSeen.add(message.key);
    if (!autoReadEnabled()) return;
    if (playback.state.status === "idle") readMessage(message.key);
    else if (config.reading.autoReadQueue === "latest") autoReadQueue.splice(0, autoReadQueue.length, message.key);
    else autoReadQueue.push(message.key);
  });

  let lastStatus = playback.state.status;
  let lastError: string | undefined;
  const unsubscribePlayback = playback.subscribe((state) => {
    if (state.error && state.error !== lastError) notice("error", state.error);
    lastError = state.error;
    const becameIdle = lastStatus !== "idle" && state.status === "idle";
    lastStatus = state.status;
    if (becameIdle && !state.error) {
      const next = autoReadQueue.shift();
      if (next) readMessage(next);
      if (pendingExternal && playback.state.status === "idle") {
        const script = pendingExternal;
        pendingExternal = undefined;
        playback.play(script);
      }
    }
  });

  // ---------- config changes ----------
  const applyConfig = (next: Config): void => {
    if (serializeConfig(next) === serializeConfig(config)) return;
    const previous = config;
    config = next;
    configVersion++;
    if (next.voices.speed !== previous.voices.speed) playback.setSpeed(next.voices.speed);
    if (next.harnesses.enabled.join() !== previous.harnesses.enabled.join()) {
      notice("info", "Harness changes apply after restarting speakh.");
    }
    for (const warning of unknownVoiceWarnings(next, isKnownVoice)) {
      if (!unknownVoiceWarnings(previous, isKnownVoice).includes(warning)) notice("warning", `Config: ${warning}`);
    }
    emit({ type: "config", config });
  };

  const updateConfig = async (mutate: (draft: Config) => void): Promise<void> => {
    const draft = cloneConfig(config);
    mutate(draft);
    const next = parseConfig(serializeConfig(draft));
    if (configPath) await saveConfig(next, configPath);
    applyConfig(next);
  };

  const unwatchConfig =
    configPath === undefined
      ? () => {}
      : watchConfig(
          configPath,
          (next) => applyConfig(next),
          (error) => notice("error", `${error.message}\nKeeping the last valid config.`),
          {
            onWarnings: (warnings) => warnings.forEach((warning) => notice("warning", `Config: ${warning}`)),
          },
        );

  // ---------- commands ----------
  /** The playback script belongs to the selected message, so navigation can move inside it. */
  const playingSelection = (): boolean => {
    const key = selectedKey();
    return key !== undefined && playback.script?.messageKey === key;
  };
  const requireSelection = (): string | undefined => {
    const key = selectedKey();
    if (!key) notice("info", "No answer to read yet.");
    return key;
  };
  const navigate = (move: () => void): void => {
    if (playingSelection()) {
      move();
      return;
    }
    const key = requireSelection();
    if (key) readMessage(key);
  };
  const stepMessage = (delta: number): void => {
    const messages = sessions.messages;
    if (messages.length === 0) {
      notice("info", "No answers in this session yet.");
      return;
    }
    const current = messages.findIndex((message) => message.key === selectedKey());
    const from = current < 0 ? messages.length - 1 : current;
    const index = Math.min(messages.length - 1, Math.max(0, from + delta));
    const target = messages[index];
    if (!target) return;
    if (index === from && current >= 0) {
      // At either end: keep whatever is playing instead of restarting the same answer.
      notice("info", delta > 0 ? "This is the newest answer." : "This is the first answer.");
      return;
    }
    const wasSpeaking = ["preparing", "speaking", "study-wait"].includes(playback.state.status);
    selectMessage(target.key);
    if (wasSpeaking) readMessage(target.key);
  };
  const readTable = (): void => {
    const message = findMessage(requireSelection());
    if (!message) return;
    const script = scriptFor(message);
    const tableBlocks = [...new Set(script.segments.filter((segment) => segment.kind === "table").map((segment) => segment.blockIndex))];
    if (tableBlocks.length === 0) {
      notice("info", "No table in this answer.");
      return;
    }
    const currentBlock = playingSelection() ? playback.script?.segments[playback.state.segmentIndex]?.blockIndex : undefined;
    const block = currentBlock === undefined ? tableBlocks[0] : (tableBlocks.find((candidate) => candidate >= currentBlock) ?? tableBlocks.at(-1));
    const table = block === undefined ? undefined : buildTableScript(message.key, message.markdown, block, speechOptions());
    if (!table || table.segments.length === 0) {
      notice("info", "This table has no rows to read.");
      return;
    }
    playback.play(table);
  };
  const setVoice = (mode: VoiceOverride): void => {
    playback.setVoiceOverride(mode);
    const voice = mode === "primary" ? config.voices.primary : mode === "alternate" ? config.voices.alternate : undefined;
    notice("info", `Voice: ${VOICE_LABELS[mode]}${voice ? ` · ${voice}` : ""}`);
  };

  const core: [CommandId, string, Command["group"], (args: string[]) => void | Promise<void>][] = [
    [
      "play-pause",
      "Play / pause",
      "playback",
      () => {
        if (playback.state.status !== "idle") {
          playback.togglePause();
          return;
        }
        const key = requireSelection();
        if (key) readMessage(key);
      },
    ],
    [
      "stop",
      "Stop",
      "playback",
      () => {
        autoReadQueue.length = 0;
        pendingExternal = undefined;
        playback.stop();
      },
    ],
    ["next-sentence", "Next sentence", "navigation", () => navigate(() => playback.seekSegment(1))],
    ["prev-sentence", "Previous sentence", "navigation", () => navigate(() => playback.seekSegment(-1))],
    ["next-block", "Next paragraph", "navigation", () => navigate(() => playback.seekBlock(1))],
    ["prev-block", "Previous paragraph", "navigation", () => navigate(() => playback.seekBlock(-1))],
    ["repeat-sentence", "Repeat sentence", "study", () => navigate(() => playback.repeatSegment())],
    ["repeat-slower", "Repeat sentence slower", "study", () => navigate(() => playback.repeatSegment({ slower: true }))],
    [
      "replay-message",
      "Replay answer",
      "playback",
      () => {
        const key = requireSelection();
        if (key) readMessage(key);
      },
    ],
    [
      "read-latest",
      "Read latest answer",
      "playback",
      () => {
        const key = newestKey();
        if (key) readMessage(key);
        else notice("info", "No answer to read yet.");
      },
    ],
    ["next-message", "Next answer", "navigation", () => stepMessage(1)],
    ["prev-message", "Previous answer", "navigation", () => stepMessage(-1)],
    ["read-table", "Read table rows", "playback", readTable],
    [
      "auto-read",
      "Toggle auto-read",
      "app",
      async () => {
        const enabled = !autoReadEnabled();
        if (autoReadOverride !== undefined) autoReadOverride = enabled;
        else
          await updateConfig((draft) => {
            draft.reading.autoRead = enabled;
          });
        if (!enabled) autoReadQueue.length = 0;
        notice("info", `Auto-read ${enabled ? "on" : "off"}`);
      },
    ],
    [
      "study-mode",
      "Toggle study mode",
      "study",
      () => {
        const enabled = !playback.state.studyMode;
        playback.setStudyMode(enabled);
        notice("info", `Study mode ${enabled ? "on" : "off"}`);
      },
    ],
    ["study-continue", "Continue (study mode)", "study", () => playback.continueStudy()],
    [
      "save-phrase",
      "Save current sentence",
      "study",
      async () => {
        const script = playback.script;
        const segment = script?.segments[playback.state.segmentIndex];
        if (!script || !segment) {
          notice("info", "Nothing is being read.");
          return;
        }
        await phrases.save({
          text: segment.text,
          lang: segment.lang,
          messageKey: script.messageKey,
          savedAt: new Date(),
        });
        notice("info", `Saved phrase: ${segment.text}`);
      },
    ],
    ["voice-auto", "Voice: auto by language", "voice", () => setVoice("auto")],
    ["voice-primary", "Voice: primary", "voice", () => setVoice("primary")],
    ["voice-alternate", "Voice: alternate", "voice", () => setVoice("alternate")],
    ["speed-up", "Speed up", "voice", () => playback.setSpeed(playback.state.speed + 0.1)],
    ["speed-down", "Slow down", "voice", () => playback.setSpeed(playback.state.speed - 0.1)],
    ["speak-text", "Speak a reply from an integration", "playback", speakExternal],
  ];
  for (const [id, title, group, run] of core) {
    commands.register({
      id,
      title,
      group,
      hidden: id === "speak-text",
      async run(args) {
        try {
          await run(args);
        } catch (error) {
          notice("error", error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    });
  }

  if (options.followSessions !== false) {
    sessions.followLatest(options.cwd).catch((error: unknown) => {
      notice("error", `Could not follow a session: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  let disposed: Promise<void> | undefined;
  return {
    get config() {
      return config;
    },
    engine,
    playback,
    sessions,
    phrases,
    commands,
    get selectedMessageKey() {
      return selectedKey();
    },
    scriptFor,
    selectMessage,
    readMessage,
    updateConfig,
    subscribe(listener) {
      listeners.add(listener);
      for (const event of pendingNotices.splice(0)) listener(event);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed ??= (async () => {
        unwatchConfig();
        unsubscribeSessions();
        unsubscribePlayback();
        await playback.dispose();
        await sessions.dispose();
        await engine.close();
        listeners.clear();
      })();
      return disposed;
    },
  };
}
