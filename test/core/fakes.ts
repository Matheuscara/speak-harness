import { DEFAULT_CONFIG } from "../../src/core/config/index.ts";
import type {
  AudioChunk,
  AudioOutput,
  Config,
  EngineClient,
  HarnessMessage,
  Lang,
  SegmentKind,
  SessionRef,
  SessionService,
  SpeechScript,
  StoreEvent,
  SynthesisRequest,
} from "../../src/core/types.ts";

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const abortError = (): DOMException => new DOMException("Aborted", "AbortError");

export function testConfig(mutate?: (config: Config) => void): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  mutate?.(config);
  return config;
}

export interface SynthCall {
  request: SynthesisRequest;
  aborted: boolean;
  resolve(durationMs?: number): void;
  reject(error: Error): void;
}

/** Engine whose syntheses stay pending until resolved, unless `auto` resolves them with `durationMs` of audio. */
export function fakeEngine(options: { auto?: boolean; durationMs?: number; fail?: (request: SynthesisRequest) => Error | undefined } = {}) {
  const calls: SynthCall[] = [];
  /** Text each chunk was synthesized from, so tests can tell what the player received. */
  const textOf = new WeakMap<AudioChunk, string>();
  const engine: EngineClient = {
    voices: async () => [],
    install: async () => {},
    close: async () => {},
    synthesize(request, signal) {
      const deferred = Promise.withResolvers<AudioChunk>();
      const call: SynthCall = {
        request,
        aborted: false,
        resolve(durationMs = options.durationMs ?? 100) {
          const chunk: AudioChunk = { sampleRate: 1000, pcm: new Float32Array(durationMs) };
          textOf.set(chunk, request.text);
          deferred.resolve(chunk);
        },
        reject: (error) => deferred.reject(error),
      };
      signal?.addEventListener(
        "abort",
        () => {
          call.aborted = true;
          deferred.reject(abortError());
        },
        { once: true },
      );
      calls.push(call);
      const failure = options.fail?.(request);
      if (failure) queueMicrotask(() => call.reject(failure));
      else if (options.auto) queueMicrotask(() => call.resolve());
      return deferred.promise;
    },
  };
  return { engine, calls, textOf };
}

export interface PlayCall {
  chunk: AudioChunk;
  signal: AbortSignal;
  finish(): void;
}

/** Player that finishes each chunk immediately when `auto`, otherwise when the test calls `finish()`. */
export function fakeAudio(options: { auto?: boolean } = {}) {
  const plays: PlayCall[] = [];
  const audio: AudioOutput = {
    playerName: "fake",
    play(chunk, signal) {
      const deferred = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => deferred.reject(abortError()), { once: true });
      plays.push({ chunk, signal, finish: () => deferred.resolve() });
      if (options.auto) queueMicrotask(() => deferred.resolve());
      return deferred.promise;
    },
  };
  return { audio, plays };
}

export function fakeSleep() {
  const calls: number[] = [];
  const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
    calls.push(ms);
    if (signal.aborted) throw abortError();
  };
  return { sleep, calls };
}

export interface SegmentSpec {
  text: string;
  block?: number;
  kind?: SegmentKind;
  lang?: Lang;
  pause?: number;
}

export function makeScript(messageKey: string, specs: (SegmentSpec | string)[]): SpeechScript {
  const segments = specs.map((spec, index) => {
    const s = typeof spec === "string" ? { text: spec } : spec;
    return {
      index,
      text: s.text,
      display: { start: 0, end: s.text.length },
      kind: s.kind ?? "sentence",
      blockIndex: s.block ?? index,
      lang: s.lang ?? "en",
      pauseAfterMs: s.pause ?? 0,
    };
  });
  return {
    messageKey,
    segments,
    blocks: new Set(segments.map((segment) => segment.blockIndex)).size,
    dominantLang: "en",
  };
}

/** In-memory session service: tests push messages with `emitMessage`. */
export function fakeSessions() {
  const listeners = new Set<(event: StoreEvent) => void>();
  const messages: HarnessMessage[] = [];
  const session: SessionRef = { harness: "omp", id: "s1", updatedAt: new Date(0) };
  let counter = 0;
  const emit = (event: StoreEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const emitMessage = (
    markdown: string,
    options: { historical?: boolean; final?: boolean; commentary?: boolean } = {},
  ): HarnessMessage => {
    counter++;
    const message: HarnessMessage = {
      key: `omp:s1:${counter}`,
      session,
      markdown,
      createdAt: new Date(counter * 1000),
      final: options.final ?? true,
      historical: options.historical ?? false,
      commentary: options.commentary ?? false,
    };
    messages.push(message);
    emit({ type: "message", message });
    return message;
  };
  /** Replaces a message in place and emits it again, like the session service does for merged transcripts. */
  const updateMessage = (key: string, markdown: string): HarnessMessage => {
    const index = messages.findIndex((message) => message.key === key);
    const previous = messages[index];
    if (!previous) throw new Error(`no message ${key}`);
    const message: HarnessMessage = { ...previous, markdown };
    messages[index] = message;
    emit({ type: "message", message });
    return message;
  };
  const service: SessionService = {
    get session() {
      return session;
    },
    messages,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list: async () => [session],
    followLatest: async () => {},
    follow: async () => {},
    addManual: (markdown) => emitMessage(markdown),
    dispose: async () => {},
  };
  return { service, emitMessage, updateMessage, emit };
}
