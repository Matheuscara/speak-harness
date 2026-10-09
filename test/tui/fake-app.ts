// In-memory AppCore for TUI tests and development. Depends only on the shared contract and mdast.

import type { Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type {
  AppCore,
  AppEvent,
  AudioChunk,
  Command,
  CommandId,
  CommandRegistry,
  Config,
  EngineClient,
  HarnessMessage,
  Lang,
  Phrase,
  PhraseStore,
  PlaybackController,
  PlaybackState,
  SessionRef,
  SessionService,
  SpeechScript,
  SpeechSegment,
  StoreEvent,
  VoiceInfo,
  VoiceOverride,
} from "../../src/core/types.ts";

export function fakeConfig(): Config {
  return {
    voices: {
      primary: "kokoro:af_heart",
      alternate: "kokoro:pf_dora",
      autoLanguage: true,
      speed: 1,
      languages: { en: "kokoro:af_heart", "pt-BR": "piper:pt_BR-faber-medium" },
    },
    reading: { autoRead: false, autoReadQueue: "latest", tables: "summary", quoteCue: true, maxSegmentChars: 240 },
    study: { pauseAfterSentence: false, shadowing: false, shadowingFactor: 1, slowerSpeed: 0.75 },
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
    harnesses: { enabled: ["omp", "pi", "codex", "claude-code"] },
    lexicon: { en: {}, "pt-BR": {} },
  };
}

export const MESSAGE_EN = `## What is this task about?

Developers use the **app's database user** to access production. Each credential is temporary.

- **Temporary:** the credential has a TTL.
- Scoped to one \`schema\` only.

\`\`\`ts
const user = await vault.issue("db");
console.log(user.ttl);
\`\`\`

| name | type | default |
| --- | --- | --- |
| ttl | number | 3600 |
`;

export const MESSAGE_PT = `Você pode testar a conexão agora. O comando abaixo não altera nada no banco.

Depois disso, rode as migrações com cuidado.`;

export const MESSAGE_LONG = Array.from(
  { length: 30 },
  (_, i) => `Paragraph ${i + 1} explains one more detail about the rollout plan so the reader can scroll.`,
).join("\n\n");

const PT_HINT = /[ãõçáéíóúâêô]|\b(você|não|que|com|para|depois|rode)\b/i;

function offset(node: { position?: { start: { offset?: number }; end: { offset?: number } } }): { start: number; end: number } {
  return { start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? 0 };
}

/** Stub speech script: headings, sentences, list items, code cues and table summaries with source ranges. */
export function fakeScript(messageKey: string, markdown: string): SpeechScript {
  const tree: Root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const segments: SpeechSegment[] = [];
  const push = (kind: SpeechSegment["kind"], text: string, display: { start: number; end: number }, blockIndex: number) => {
    segments.push({ index: segments.length, kind, text, display, blockIndex, lang: PT_HINT.test(text) ? "pt-BR" : "en", pauseAfterMs: 0 });
  };
  const sentences = (start: number, end: number, blockIndex: number, kind: SpeechSegment["kind"]) => {
    const slice = markdown.slice(start, end);
    for (const part of new Intl.Segmenter("en", { granularity: "sentence" }).segment(slice)) {
      const text = part.segment.trimEnd();
      if (!text.trim()) continue;
      push(kind, text.replace(/[*`]/g, ""), { start: start + part.index, end: start + part.index + text.length }, blockIndex);
    }
  };
  tree.children.forEach((node: RootContent, blockIndex) => {
    const range = offset(node);
    switch (node.type) {
      case "heading": {
        const first = node.children[0];
        const last = node.children.at(-1);
        if (first && last) push("heading", markdown.slice(offset(first).start, offset(last).end), { start: offset(first).start, end: offset(last).end }, blockIndex);
        break;
      }
      case "paragraph":
        sentences(range.start, range.end, blockIndex, "sentence");
        break;
      case "list":
        for (const item of node.children) {
          const para = item.children[0];
          if (para) push("list-item", markdown.slice(offset(para).start, offset(para).end).replace(/[*`]/g, ""), offset(para), blockIndex);
        }
        break;
      case "code":
        push("cue", `${node.lang ?? ""} code block, ${node.value.split("\n").length} lines`, range, blockIndex);
        break;
      case "table":
        push("table", `table with ${node.children[0]?.children.length ?? 0} columns`, range, blockIndex);
        break;
    }
  });
  return { messageKey, segments, blocks: tree.children.length, dominantLang: segments[0]?.lang ?? "en" };
}

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}

export class FakePlayback implements PlaybackController {
  state: PlaybackState = { status: "idle", segmentIndex: 0, segmentCount: 0, speed: 1, voiceOverride: "auto", studyMode: false };
  script: SpeechScript | undefined;
  readonly calls: string[] = [];
  private emitter = new Emitter<PlaybackState>();
  private readonly voiceFor: (lang: Lang, override: VoiceOverride) => string;
  constructor(voiceFor: (lang: Lang, override: VoiceOverride) => string) {
    this.voiceFor = voiceFor;
  }

  subscribe(listener: (state: PlaybackState) => void): () => void {
    return this.emitter.subscribe(listener);
  }
  private set(patch: Partial<PlaybackState>): void {
    const next = { ...this.state, ...patch };
    const segment = this.script?.segments[next.segmentIndex];
    if (segment) {
      next.lang = segment.lang;
      next.voice = this.voiceFor(segment.lang, next.voiceOverride);
    }
    this.state = next;
    this.emitter.emit(next);
  }
  play(script: SpeechScript, fromSegment = 0): void {
    this.calls.push(`play:${script.messageKey}:${fromSegment}`);
    this.script = script;
    this.set({ status: "speaking", messageKey: script.messageKey, segmentIndex: fromSegment, segmentCount: script.segments.length, error: undefined });
  }
  togglePause(): void {
    this.calls.push("togglePause");
    if (this.state.status === "paused") this.resume();
    else if (this.state.status !== "idle") this.pause();
  }
  pause(): void {
    this.set({ status: "paused" });
  }
  resume(): void {
    this.set({ status: "speaking" });
  }
  stop(): void {
    this.calls.push("stop");
    this.set({ status: "idle" });
  }
  seekSegment(delta: number): void {
    this.calls.push(`seekSegment:${delta}`);
    if (!this.script) return;
    const index = Math.max(0, Math.min(this.script.segments.length - 1, this.state.segmentIndex + delta));
    this.set({ segmentIndex: index, status: this.state.status === "idle" ? "speaking" : this.state.status });
  }
  seekBlock(delta: number): void {
    this.calls.push(`seekBlock:${delta}`);
    const segments = this.script?.segments ?? [];
    const current = segments[this.state.segmentIndex]?.blockIndex ?? 0;
    const target = delta > 0 ? segments.find((s) => s.blockIndex > current) : [...segments].reverse().find((s) => s.blockIndex < current);
    if (target) this.set({ segmentIndex: target.index });
  }
  repeatSegment(options?: { slower?: boolean }): void {
    this.calls.push(options?.slower ? "repeatSlower" : "repeat");
    this.set({});
  }
  continueStudy(): void {
    this.calls.push("continueStudy");
    if (this.state.status === "study-wait") this.set({ status: "speaking" });
  }
  setSpeed(speed: number): void {
    this.set({ speed: Math.round(speed * 100) / 100 });
  }
  setVoiceOverride(mode: VoiceOverride): void {
    this.set({ voiceOverride: mode });
  }
  setStudyMode(enabled: boolean): void {
    this.set({ studyMode: enabled });
  }
  /** Test helper: jump to a segment as the real controller would while speaking. */
  advanceTo(index: number): void {
    this.set({ segmentIndex: index });
  }
  async dispose(): Promise<void> {}
}

export const FAKE_SESSIONS: SessionRef[] = [
  { harness: "omp", id: "s-vitrum", title: "vitrum", cwd: "/work/vitrum", updatedAt: new Date("2026-10-08T10:00:00Z") },
  { harness: "codex", id: "s-other", title: "billing api", cwd: "/work/billing", updatedAt: new Date("2026-10-07T09:00:00Z") },
];

function message(session: SessionRef, id: string, markdown: string, minutes: number, commentary = false): HarnessMessage {
  return {
    key: `${session.harness}:${session.id}:${id}`,
    session,
    markdown,
    createdAt: new Date(session.updatedAt.getTime() - minutes * 60_000),
    final: true,
    historical: true,
    commentary,
  };
}

export class FakeSessions implements SessionService {
  session: SessionRef | undefined;
  messages: HarnessMessage[] = [];
  readonly followed: string[] = [];
  private emitter = new Emitter<StoreEvent>();
  private byId = new Map<string, HarnessMessage[]>();

  constructor(sessions: SessionRef[] = FAKE_SESSIONS) {
    const [vitrum, other] = sessions;
    if (vitrum) {
      this.byId.set(vitrum.id, [
        message(vitrum, "m1", MESSAGE_PT, 5),
        message(vitrum, "c1", "Let me check the vault configuration first.", 2, true),
        message(vitrum, "m2", MESSAGE_EN, 1),
      ]);
    }
    if (other) this.byId.set(other.id, [message(other, "m1", MESSAGE_LONG, 3)]);
    this.sessionsList = sessions;
    this.session = vitrum;
    this.messages = vitrum ? [...(this.byId.get(vitrum.id) ?? [])] : [];
  }
  private sessionsList: SessionRef[];

  subscribe(listener: (event: StoreEvent) => void): () => void {
    return this.emitter.subscribe(listener);
  }
  async list(filter: { cwd?: string }): Promise<SessionRef[]> {
    return this.sessionsList.filter((s) => !filter.cwd || s.cwd === filter.cwd);
  }
  async followLatest(cwd: string): Promise<void> {
    const [latest] = await this.list({ cwd });
    if (latest) await this.follow(latest);
  }
  async follow(session: SessionRef): Promise<void> {
    this.followed.push(session.id);
    this.session = session;
    this.messages = [...(this.byId.get(session.id) ?? [])];
    this.emitter.emit({ type: "session", session });
  }
  addManual(markdown: string, harness: "manual" | "capture" = "manual"): HarnessMessage {
    const session = this.session ?? { harness, id: "manual", updatedAt: new Date() };
    const added = { ...message(session, `x${this.messages.length + 1}`, markdown, 0), historical: false, createdAt: new Date() };
    this.messages.push(added);
    this.emitter.emit({ type: "message", message: added });
    return added;
  }
  /** Test helper: a new message from the harness (commentary or final answer). */
  push(markdown: string, commentary = false): HarnessMessage {
    const session = this.session ?? FAKE_SESSIONS[0]!;
    const added = { ...message(session, `n${this.messages.length + 1}`, markdown, 0, commentary), historical: false, createdAt: new Date() };
    this.messages.push(added);
    this.emitter.emit({ type: "message", message: added });
    return added;
  }
  /** Test helper: the same key arrives again with new text. */
  update(key: string, markdown: string): void {
    const index = this.messages.findIndex((m) => m.key === key);
    const current = this.messages[index];
    if (!current) throw new Error(`Unknown message ${key}`);
    const updated = { ...current, markdown };
    this.messages[index] = updated;
    this.emitter.emit({ type: "message", message: updated });
  }
  warn(text: string): void {
    this.emitter.emit({ type: "warning", harness: "omp", message: text });
  }
  async dispose(): Promise<void> {}
}

export const FAKE_VOICES: VoiceInfo[] = [
  { id: "kokoro:af_heart", engine: "kokoro", name: "af_heart", lang: "en", label: "Heart (US English)", gender: "female", sizeBytes: 92_000_000, installed: true, license: "Apache-2.0" },
  { id: "kokoro:pf_dora", engine: "kokoro", name: "pf_dora", lang: "pt-BR", label: "Dora (Portuguese)", gender: "female", sizeBytes: 92_000_000, installed: true, license: "Apache-2.0" },
  { id: "piper:pt_BR-faber-medium", engine: "piper", name: "pt_BR-faber-medium", lang: "pt-BR", label: "Faber (pt-BR)", gender: "male", sizeBytes: 63_000_000, installed: true, license: "CC0" },
  { id: "piper:pt_BR-cadu-medium", engine: "piper", name: "pt_BR-cadu-medium", lang: "pt-BR", label: "Cadu (pt-BR)", gender: "male", sizeBytes: 63_000_000, installed: false, license: "CC0" },
];

export class FakeEngine implements EngineClient {
  readonly voiceList = FAKE_VOICES.map((v) => ({ ...v }));
  readonly installs: string[] = [];
  async voices(): Promise<VoiceInfo[]> {
    return this.voiceList.map((v) => ({ ...v }));
  }
  private release: (() => void) | undefined;
  /** Reports 50% progress, then waits for `finishInstall()` so tests can observe the in-progress state. */
  async install(voice: string, onProgress?: (done: number, total: number) => void): Promise<void> {
    const info = this.voiceList.find((v) => v.id === voice);
    if (!info) throw new Error(`unknown voice ${voice}`);
    this.installs.push(voice);
    onProgress?.(info.sizeBytes / 2, info.sizeBytes);
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    onProgress?.(info.sizeBytes, info.sizeBytes);
    info.installed = true;
  }
  finishInstall(): void {
    this.release?.();
    this.release = undefined;
  }
  async synthesize(): Promise<AudioChunk> {
    return { sampleRate: 24000, pcm: new Float32Array(0) };
  }
  async close(): Promise<void> {}
}

export class FakePhrases implements PhraseStore {
  readonly saved: Phrase[] = [
    { text: "Each credential is temporary.", lang: "en", messageKey: "omp:s-vitrum:m2", savedAt: new Date("2026-10-08T09:30:00Z") },
    { text: "Você pode testar a conexão agora.", lang: "pt-BR", messageKey: "omp:s-vitrum:m1", savedAt: new Date("2026-10-08T09:31:00Z") },
  ];
  async save(phrase: Phrase): Promise<void> {
    this.saved.push(phrase);
  }
  async list(): Promise<Phrase[]> {
    return [...this.saved];
  }
}

export class FakeCommands implements CommandRegistry {
  private commands = new Map<string, Command>();
  readonly ran: string[] = [];
  register(command: Command): () => void {
    this.commands.set(command.id, command);
    return () => {
      if (this.commands.get(command.id) === command) this.commands.delete(command.id);
    };
  }
  get(id: string): Command | undefined {
    return this.commands.get(id);
  }
  list(): Command[] {
    return [...this.commands.values()];
  }
  async run(id: string, args: string[] = []): Promise<void> {
    const command = this.commands.get(id);
    if (!command) throw new Error(`Unknown command: ${id}`);
    this.ran.push(id);
    await command.run(args);
  }
}

export class FakeApp implements AppCore {
  config: Config;
  readonly engine = new FakeEngine();
  readonly sessions: FakeSessions;
  readonly phrases = new FakePhrases();
  readonly commands = new FakeCommands();
  readonly playback: FakePlayback;
  selectedMessageKey: string | undefined;
  readonly configUpdates: Config[] = [];
  private emitter = new Emitter<AppEvent>();

  constructor(options: { config?: Config; sessions?: FakeSessions } = {}) {
    this.config = options.config ?? fakeConfig();
    this.sessions = options.sessions ?? new FakeSessions();
    this.playback = new FakePlayback((lang, override) =>
      override === "primary" ? this.config.voices.primary : override === "alternate" ? this.config.voices.alternate : this.config.voices.languages[lang],
    );
    this.registerCoreCommands();
  }

  get selected(): HarnessMessage | undefined {
    const messages = this.sessions.messages;
    return messages.find((m) => m.key === this.selectedMessageKey) ?? messages.findLast((m) => !m.commentary);
  }

  scriptFor(message: HarnessMessage): SpeechScript {
    return fakeScript(message.key, message.markdown);
  }
  selectMessage(key: string): void {
    this.selectedMessageKey = key;
    this.emitter.emit({ type: "selection", messageKey: key });
  }
  readMessage(key: string, fromSegment = 0): void {
    const message = this.sessions.messages.find((m) => m.key === key);
    if (!message) throw new Error(`Unknown message ${key}`);
    if (this.selectedMessageKey !== key) this.selectMessage(key);
    this.playback.play(this.scriptFor(message), fromSegment);
  }
  async updateConfig(mutate: (draft: Config) => void): Promise<void> {
    const draft = structuredClone(this.config);
    mutate(draft);
    this.config = draft;
    this.configUpdates.push(draft);
    this.emitter.emit({ type: "config", config: draft });
  }
  subscribe(listener: (event: AppEvent) => void): () => void {
    return this.emitter.subscribe(listener);
  }
  notify(level: "info" | "warning" | "error", text: string): void {
    this.emitter.emit({ type: "notice", level, text });
  }
  async dispose(): Promise<void> {}

  private registerCoreCommands(): void {
    const pb = this.playback;
    const read = (from = 0) => {
      const message = this.selected;
      if (message) this.readMessage(message.key, from);
    };
    const step = (delta: number) => {
      const messages = this.sessions.messages;
      const index = messages.findIndex((m) => m.key === this.selected?.key);
      const next = messages[Math.max(0, Math.min(messages.length - 1, index + delta))];
      if (next) this.selectMessage(next.key);
    };
    const commands: Array<[CommandId, string, Command["group"], () => void | Promise<void>]> = [
      ["play-pause", "Play / pause", "playback", () => (pb.script?.messageKey === this.selected?.key && pb.state.status !== "idle" ? pb.togglePause() : read())],
      ["stop", "Stop", "playback", () => pb.stop()],
      ["next-sentence", "Next sentence", "navigation", () => pb.seekSegment(1)],
      ["prev-sentence", "Previous sentence", "navigation", () => pb.seekSegment(-1)],
      ["next-block", "Next block", "navigation", () => pb.seekBlock(1)],
      ["prev-block", "Previous block", "navigation", () => pb.seekBlock(-1)],
      ["repeat-sentence", "Repeat sentence", "playback", () => pb.repeatSegment()],
      ["repeat-slower", "Repeat slower", "study", () => pb.repeatSegment({ slower: true })],
      ["replay-message", "Replay message", "playback", () => read(0)],
      ["read-latest", "Read latest answer", "navigation", () => {
        const latest = this.sessions.messages.findLast((m) => !m.commentary);
        if (latest) this.readMessage(latest.key);
      }],
      ["next-message", "Next message", "navigation", () => step(1)],
      ["prev-message", "Previous message", "navigation", () => step(-1)],
      ["read-table", "Read table rows", "navigation", () => this.notify("info", "No table here")],
      ["auto-read", "Toggle auto-read", "playback", () => this.updateConfig((c) => void (c.reading.autoRead = !c.reading.autoRead))],
      ["study-mode", "Toggle study mode", "study", () => pb.setStudyMode(!pb.state.studyMode)],
      ["study-continue", "Continue (study)", "study", () => pb.continueStudy()],
      ["save-phrase", "Save phrase", "study", async () => {
        const segment = pb.script?.segments[pb.state.segmentIndex];
        if (segment) await this.phrases.save({ text: segment.text, lang: segment.lang, messageKey: pb.script?.messageKey ?? "", savedAt: new Date() });
      }],
      ["voice-auto", "Voice: automatic", "voice", () => pb.setVoiceOverride("auto")],
      ["voice-primary", "Voice: primary", "voice", () => pb.setVoiceOverride("primary")],
      ["voice-alternate", "Voice: alternate", "voice", () => pb.setVoiceOverride("alternate")],
      ["speed-up", "Speed up", "voice", () => pb.setSpeed(pb.state.speed + 0.1)],
      ["speed-down", "Speed down", "voice", () => pb.setSpeed(pb.state.speed - 0.1)],
    ];
    for (const [id, title, group, run] of commands) this.commands.register({ id, title, group, run });
  }
}
