// Shared contracts between SpeakHarness modules. Keep this file dependency-free.

// ---------- Languages ----------

export type Lang = "en" | "pt-BR";
export const LANGS: readonly Lang[] = ["en", "pt-BR"];

// ---------- Harness messages ----------

export type HarnessId = "omp" | "pi" | "codex" | "claude-code" | "capture" | "manual";

export interface SessionRef {
  harness: HarnessId;
  /** Stable id within the harness (usually the transcript file name without extension). */
  id: string;
  title?: string;
  cwd?: string;
  /** Transcript path for file-backed harnesses. */
  path?: string;
  updatedAt: Date;
}

export interface HarnessMessage {
  /** `${harness}:${sessionId}:${messageId}`; stable across restarts. */
  key: string;
  session: SessionRef;
  /** Assistant text only (no thinking, tool calls, or tool output). */
  markdown: string;
  createdAt: Date;
  /** False while a capture-based message may still grow. File adapters always emit final messages. */
  final: boolean;
  /** True when the message already existed when watching started. */
  historical: boolean;
}

export interface HarnessAdapter {
  id: HarnessId;
  label: string;
  /** Newest first. With `cwd`, only sessions whose working directory equals it. */
  sessions(filter: { cwd?: string }): Promise<SessionRef[]>;
  /** Yields existing assistant messages (`historical: true`) in order, then new ones as they are appended. Ends when `signal` aborts. */
  watch(session: SessionRef, signal: AbortSignal): AsyncIterable<HarnessMessage>;
}

// ---------- Speech script ----------

export type SegmentKind = "heading" | "sentence" | "list-item" | "quote" | "cue" | "table";

export interface SpeechSegment {
  index: number;
  /** Exactly what the engine speaks. */
  text: string;
  /** Offsets into the source markdown, for highlight. */
  display: { start: number; end: number };
  kind: SegmentKind;
  blockIndex: number;
  lang: Lang;
  pauseAfterMs: number;
}

export interface SpeechScript {
  messageKey: string;
  segments: SpeechSegment[];
  blocks: number;
  dominantLang: Lang;
}

export interface SpeechOptions {
  tables: "summary" | "rows";
  quoteCue: boolean;
  autoLanguage: boolean;
  /** Language used when detection is off or undetermined for the whole message. */
  defaultLang: Lang;
  /** User lexicon entries; merged over the built-in lexicon (user wins). */
  lexicon: Record<Lang, Record<string, string>>;
  maxSegmentChars: number;
}

// ---------- Engines ----------

export type EngineId = "kokoro" | "piper";

export interface VoiceInfo {
  /** `${engine}:${name}`, e.g. `kokoro:af_heart`, `piper:pt_BR-faber-medium`. */
  id: string;
  engine: EngineId;
  name: string;
  lang: Lang;
  label: string;
  gender?: "female" | "male";
  sizeBytes: number;
  installed: boolean;
  license: string;
}

export interface SynthesisRequest {
  text: string;
  voice: string;
  lang: Lang;
  speed: number;
}

export interface AudioChunk {
  sampleRate: number;
  pcm: Float32Array;
}

export interface EngineClient {
  voices(): Promise<VoiceInfo[]>;
  /** Downloads model files for `voice` (Kokoro voices share one model). No-op when installed. */
  install(voice: string, onProgress?: (done: number, total: number) => void): Promise<void>;
  /** Rejects with an `AbortError` when `signal` aborts. */
  synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<AudioChunk>;
  close(): Promise<void>;
}

// ---------- Audio output ----------

export interface AudioOutput {
  readonly playerName: string;
  /** Resolves when the chunk finished playing; rejects with an `AbortError` when `signal` aborts (player stopped). */
  play(chunk: AudioChunk, signal: AbortSignal): Promise<void>;
}

// ---------- Config ----------

export type CommandId =
  | "play-pause"
  | "stop"
  | "next-sentence"
  | "prev-sentence"
  | "next-block"
  | "prev-block"
  | "repeat-sentence"
  | "repeat-slower"
  | "replay-message"
  | "read-latest"
  | "next-message"
  | "prev-message"
  | "read-table"
  | "auto-read"
  | "study-mode"
  | "study-continue"
  | "save-phrase"
  | "voice-auto"
  | "voice-primary"
  | "voice-alternate"
  | "speed-up"
  | "speed-down"
  | "switch-session"
  | "messages"
  | "phrases"
  | "command-palette"
  | "settings"
  | "help"
  | "quit";

export interface Config {
  voices: {
    primary: string;
    alternate: string;
    autoLanguage: boolean;
    speed: number;
    languages: Record<Lang, string>;
  };
  reading: {
    autoRead: boolean;
    /** What happens when a new answer arrives while speaking: queue only the newest, or every answer. */
    autoReadQueue: "latest" | "all";
    tables: "summary" | "rows";
    quoteCue: boolean;
    maxSegmentChars: number;
  };
  study: {
    pauseAfterSentence: boolean;
    shadowing: boolean;
    /** Shadowing silence = spoken duration × factor. */
    shadowingFactor: number;
    slowerSpeed: number;
  };
  /** `leader` plus one entry per command; a command may have several bindings. */
  keys: { leader: string } & Partial<Record<CommandId, string[]>>;
  wrap: { prefix: string };
  harnesses: { enabled: HarnessId[] };
  lexicon: Record<Lang, Record<string, string>>;
}

// ---------- Playback ----------

export type PlaybackStatus = "idle" | "preparing" | "speaking" | "paused" | "study-wait";
export type VoiceOverride = "auto" | "primary" | "alternate";

export interface PlaybackState {
  status: PlaybackStatus;
  messageKey?: string;
  segmentIndex: number;
  segmentCount: number;
  voice?: string;
  lang?: Lang;
  speed: number;
  voiceOverride: VoiceOverride;
  studyMode: boolean;
  error?: string;
}

export interface PlaybackController {
  readonly state: PlaybackState;
  readonly script: SpeechScript | undefined;
  subscribe(listener: (state: PlaybackState) => void): () => void;
  play(script: SpeechScript, fromSegment?: number): void;
  togglePause(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  seekSegment(delta: number): void;
  seekBlock(delta: number): void;
  repeatSegment(options?: { slower?: boolean }): void;
  /** Leaves `study-wait` and continues with the next segment. */
  continueStudy(): void;
  setSpeed(speed: number): void;
  setVoiceOverride(mode: VoiceOverride): void;
  setStudyMode(enabled: boolean): void;
  dispose(): Promise<void>;
}

// ---------- Sessions and messages ----------

export type StoreEvent =
  | { type: "session"; session: SessionRef | undefined }
  | { type: "message"; message: HarnessMessage }
  | { type: "warning"; harness: HarnessId; message: string };

export interface MessageStore {
  readonly session: SessionRef | undefined;
  /** Messages of the followed session, oldest first. */
  readonly messages: readonly HarnessMessage[];
  subscribe(listener: (event: StoreEvent) => void): () => void;
}

export interface SessionService extends MessageStore {
  /** Sessions from all enabled adapters, newest first. */
  list(filter: { cwd?: string }): Promise<SessionRef[]>;
  /** Follows the newest session for `cwd`; keeps checking for a newer one while running. */
  followLatest(cwd: string): Promise<void>;
  follow(session: SessionRef): Promise<void>;
  /** Adds a message from stdin/clipboard/file or capture. */
  addManual(markdown: string, harness?: Extract<HarnessId, "manual" | "capture">): HarnessMessage;
  dispose(): Promise<void>;
}

// ---------- Phrases ----------

export interface Phrase {
  text: string;
  lang: Lang;
  messageKey: string;
  savedAt: Date;
}

export interface PhraseStore {
  save(phrase: Phrase): Promise<void>;
  list(): Promise<Phrase[]>;
}

// ---------- Commands ----------

export interface Command {
  id: CommandId;
  title: string;
  group: "playback" | "navigation" | "voice" | "study" | "app";
  run(args: string[]): void | Promise<void>;
}

export interface CommandRegistry {
  register(command: Command): () => void;
  get(id: string): Command | undefined;
  list(): Command[];
  /** Throws for unknown ids. */
  run(id: string, args?: string[]): Promise<void>;
}

// ---------- App core (composition root shared by TUI and headless modes) ----------

export interface AppCore {
  readonly config: Config;
  readonly engine: EngineClient;
  readonly playback: PlaybackController;
  readonly sessions: SessionService;
  readonly phrases: PhraseStore;
  readonly commands: CommandRegistry;
  /** Message currently selected for reading (defaults to the newest). */
  readonly selectedMessageKey: string | undefined;
  scriptFor(message: HarnessMessage): SpeechScript;
  selectMessage(key: string): void;
  readMessage(key: string, fromSegment?: number): void;
  updateConfig(mutate: (draft: Config) => void): Promise<void>;
  /** Fires on config, selection, and auto-read changes. */
  subscribe(listener: (event: AppEvent) => void): () => void;
  dispose(): Promise<void>;
}

export type AppEvent =
  | { type: "config"; config: Config }
  | { type: "selection"; messageKey: string | undefined }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string };
