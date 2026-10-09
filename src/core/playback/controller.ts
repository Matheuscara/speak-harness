import { SPEED_MAX, SPEED_MIN } from "../config/index.ts";
import { VoiceNotInstalledError } from "../../engine/client.ts";
import type {
  AudioChunk,
  AudioOutput,
  Config,
  EngineClient,
  PlaybackController,
  PlaybackState,
  SpeechScript,
  SpeechSegment,
  VoiceOverride,
} from "../types.ts";
import { resolveVoice } from "./voices.ts";

/** Segments synthesized ahead of the one playing. */
const LOOKAHEAD = 2;

export interface PlaybackDeps {
  engine: EngineClient;
  audio: AudioOutput;
  config: () => Config;
  /** Abortable delay; rejects when `signal` aborts. Injected by tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface SynthJob {
  voice: string;
  speed: number;
  ready: boolean;
  abort: AbortController;
  promise: Promise<AudioChunk>;
}

/** Speed steps are 0.1 within [0.5, 2.0]. */
export function clampSpeed(speed: number): number {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(speed * 10) / 10));
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal.aborted) {
    reject(signal.reason);
    return promise;
  }
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

class Controller implements PlaybackController {
  readonly #deps: PlaybackDeps;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #listeners = new Set<(state: PlaybackState) => void>();
  readonly #jobs = new Map<number, SynthJob>();
  #state: PlaybackState;
  #script: SpeechScript | undefined;
  /** Aborts the running loop: player, silences, and waiting on synthesis. */
  #run: AbortController | undefined;

  constructor(deps: PlaybackDeps) {
    this.#deps = deps;
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#state = {
      status: "idle",
      segmentIndex: 0,
      segmentCount: 0,
      speed: clampSpeed(deps.config().voices.speed),
      voiceOverride: "auto",
      studyMode: false,
    };
  }

  get state(): PlaybackState {
    return this.#state;
  }

  get script(): SpeechScript | undefined {
    return this.#script;
  }

  subscribe(listener: (state: PlaybackState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  play(script: SpeechScript, fromSegment = 0): void {
    this.#halt();
    this.#cancelJobs();
    this.#script = script;
    const count = script.segments.length;
    const index = Math.min(Math.max(0, fromSegment), Math.max(0, count - 1));
    if (count === 0) {
      this.#set({ status: "idle", messageKey: script.messageKey, segmentIndex: 0, segmentCount: 0, error: undefined });
      return;
    }
    // Single transition into "preparing": listeners must never observe a spurious "idle" for the new script.
    this.#set({ status: "preparing", messageKey: script.messageKey, segmentIndex: index, segmentCount: count, error: undefined });
    this.#start(index);
  }

  togglePause(): void {
    const { status } = this.#state;
    if (status === "speaking" || status === "preparing") this.pause();
    else if (status === "paused") this.resume();
    else if (status === "study-wait") this.continueStudy();
  }

  pause(): void {
    const { status } = this.#state;
    if (status !== "speaking" && status !== "preparing") return;
    this.#halt();
    this.#set({ status: "paused" });
  }

  resume(): void {
    if (this.#state.status !== "paused") return;
    this.#start(this.#state.segmentIndex);
  }

  stop(): void {
    this.#halt();
    this.#cancelJobs();
    this.#set({ status: "idle" });
  }

  seekSegment(delta: number): void {
    const count = this.#script?.segments.length ?? 0;
    if (count === 0) return;
    this.#moveTo(Math.min(count - 1, Math.max(0, this.#state.segmentIndex + delta)));
  }

  seekBlock(delta: number): void {
    const segments = this.#script?.segments ?? [];
    const current = segments[this.#state.segmentIndex];
    if (!current) return;
    const blocks = [...new Set(segments.map((segment) => segment.blockIndex))];
    const position = Math.min(blocks.length - 1, Math.max(0, blocks.indexOf(current.blockIndex) + delta));
    const target = segments.findIndex((segment) => segment.blockIndex === blocks[position]);
    if (target >= 0) this.#moveTo(target);
  }

  repeatSegment(options: { slower?: boolean } = {}): void {
    if (!this.#script || this.#script.segments.length === 0) return;
    const slower = this.#state.speed * this.#deps.config().study.slowerSpeed;
    const speed = options.slower ? Math.max(SPEED_MIN, Math.round(slower * 100) / 100) : undefined;
    this.#start(this.#state.segmentIndex, speed);
  }

  continueStudy(): void {
    if (this.#state.status !== "study-wait") return;
    const next = this.#state.segmentIndex + 1;
    if (next >= this.#state.segmentCount) {
      this.#halt();
      this.#set({ status: "idle" });
      return;
    }
    this.#start(next);
  }

  setSpeed(speed: number): void {
    this.#set({ speed: clampSpeed(speed) });
  }

  setVoiceOverride(mode: VoiceOverride): void {
    this.#set({ voiceOverride: mode });
  }

  setStudyMode(enabled: boolean): void {
    this.#set({ studyMode: enabled });
    if (!enabled && this.#state.status === "study-wait") this.continueStudy();
  }

  async dispose(): Promise<void> {
    this.stop();
    this.#listeners.clear();
  }

  // ---------- internals ----------

  #set(patch: Partial<PlaybackState>): void {
    const next = { ...this.#state, ...patch };
    const changed = (Object.keys(patch) as (keyof PlaybackState)[]).some((key) => next[key] !== this.#state[key]);
    if (!changed) return;
    this.#state = next;
    for (const listener of [...this.#listeners]) listener(next);
  }

  #halt(): void {
    this.#run?.abort();
    this.#run = undefined;
  }

  #cancelJobs(): void {
    for (const job of this.#jobs.values()) job.abort.abort();
    this.#jobs.clear();
  }

  #moveTo(index: number): void {
    if (this.#state.status === "paused") {
      this.#set({ segmentIndex: index });
      return;
    }
    this.#start(index);
  }

  #start(index: number, speedOverride?: number): void {
    this.#halt();
    const run = new AbortController();
    this.#run = run;
    void this.#loop(run, index, speedOverride);
  }

  /** Returns the cached synthesis for `index` when it matches voice and speed; otherwise (re)starts it. */
  #job(index: number, segment: SpeechSegment, voice: string, speed: number): SynthJob {
    const existing = this.#jobs.get(index);
    if (existing && existing.voice === voice && existing.speed === speed) return existing;
    existing?.abort.abort();
    const abort = new AbortController();
    const promise = this.#deps.engine.synthesize({ text: segment.text, voice, lang: segment.lang, speed }, abort.signal);
    const job: SynthJob = { voice, speed, ready: false, abort, promise };
    promise.then(
      () => {
        job.ready = true;
      },
      () => {},
    );
    this.#jobs.set(index, job);
    return job;
  }

  /** Keeps synthesis for the segments after `index` warm and cancels work outside the window. */
  #prefetch(index: number, config: Config): void {
    for (const [jobIndex, job] of this.#jobs) {
      if (jobIndex < index || jobIndex > index + LOOKAHEAD) {
        job.abort.abort();
        this.#jobs.delete(jobIndex);
      }
    }
    const segments = this.#script?.segments ?? [];
    for (let next = index + 1; next <= index + LOOKAHEAD; next++) {
      const segment = segments[next];
      if (!segment) break;
      this.#job(next, segment, resolveVoice(config, this.#state.voiceOverride, segment.lang), this.#state.speed);
    }
  }

  /** Ends the run with a user-facing error; a missing voice explains how to install it. */
  #fail(run: AbortController, error: unknown): void {
    if (this.#run === run) this.#run = undefined;
    this.#cancelJobs();
    const message =
      error instanceof VoiceNotInstalledError
        ? `Voice ${error.voice} is not installed. Install it with: speakh voices install ${error.voice}`
        : error instanceof Error
          ? error.message
          : String(error);
    this.#set({ status: "idle", error: message });
  }

  async #loop(run: AbortController, start: number, speedOverride: number | undefined): Promise<void> {
    const { signal } = run;
    const segments = this.#script?.segments ?? [];
    let index = start;
    let speedOnce = speedOverride;
    while (!signal.aborted) {
      const segment = segments[index];
      if (!segment) {
        this.#run = undefined;
        this.#set({ status: "idle" });
        return;
      }
      const config = this.#deps.config();
      const voice = resolveVoice(config, this.#state.voiceOverride, segment.lang);
      const job = this.#job(index, segment, voice, speedOnce ?? this.#state.speed);
      this.#prefetch(index, config);
      this.#set({ status: job.ready ? "speaking" : "preparing", segmentIndex: index, voice, lang: segment.lang });

      let chunk: AudioChunk;
      try {
        chunk = await job.promise;
      } catch (error) {
        if (!signal.aborted) this.#fail(run, error);
        return;
      }
      if (signal.aborted) return;
      this.#set({ status: "speaking" });
      try {
        await this.#deps.audio.play(chunk, signal);
      } catch (error) {
        if (!signal.aborted) this.#fail(run, error);
        return;
      }
      if (signal.aborted) return;
      if (this.#jobs.get(index) === job) this.#jobs.delete(index);
      speedOnce = undefined;

      // Study mode: shadowing leaves silence proportional to the spoken audio; the wait step stops after each
      // sentence (always, unless shadowing alone is chosen as the hands-free rhythm).
      const study = this.#state.studyMode && segment.kind !== "cue";
      const spokenMs = (chunk.pcm.length / chunk.sampleRate) * 1000;
      const silenceMs =
        study && config.study.shadowing
          ? Math.max(segment.pauseAfterMs, Math.round(spokenMs * config.study.shadowingFactor))
          : segment.pauseAfterMs;
      if (silenceMs > 0) {
        try {
          await this.#sleep(silenceMs, signal);
        } catch {
          return;
        }
        if (signal.aborted) return;
      }
      if (study && (config.study.pauseAfterSentence || !config.study.shadowing)) {
        this.#set({ status: "study-wait" });
        return;
      }
      index++;
    }
  }
}

export function createPlaybackController(deps: PlaybackDeps): PlaybackController {
  return new Controller(deps);
}
