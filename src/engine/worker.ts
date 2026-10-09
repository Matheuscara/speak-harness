// TTS worker: a Node process speaking JSON lines over stdio (DESIGN.md "Worker protocol").
// Usage: node --experimental-strip-types src/engine/worker.ts [--cache-dir <dir>]
import { createInterface } from "node:readline";
import { paths } from "../core/paths.ts";
import type { EngineId } from "../core/types.ts";
import { findVoice, VOICE_CATALOG } from "./catalog.ts";
import type { SpeechEngine } from "./engine.ts";
import { createKokoroEngine } from "./kokoro.ts";
import { createPiperEngine } from "./piper.ts";
import { encodePcm, VoiceNotInstalledError } from "./protocol.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";

const PROGRESS_INTERVAL_MS = 100;

// stdout carries the protocol only; library logging goes to stderr.
console.log = console.error;
console.info = console.error;

const cacheFlag = process.argv.indexOf("--cache-dir");
const cacheDir = (cacheFlag >= 0 ? process.argv[cacheFlag + 1] : undefined) ?? paths.cacheDir();

const engines: Record<EngineId, SpeechEngine> = {
  kokoro: createKokoroEngine(cacheDir),
  piper: createPiperEngine(cacheDir),
};

function send(message: WorkerResponse): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id: number, error: unknown): void {
  if (error instanceof VoiceNotInstalledError) {
    send({ id, ok: false, error: error.message, code: "voice-not-installed", voice: error.voice });
  } else {
    send({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function resolveVoice(voice: string): { engine: SpeechEngine; name: string } {
  const info = findVoice(voice);
  if (!info) throw new Error(`unknown voice "${voice}"; run "speakh voices list" for the catalog`);
  return { engine: engines[info.engine], name: info.name };
}

// ---------- install (downloads run outside the inference queue; one per model) ----------

interface Install {
  promise: Promise<void>;
  listeners: Set<(done: number, total: number) => void>;
}

const installs = new Map<string, Install>();

async function install(id: number, voice: string): Promise<void> {
  const { engine, name } = resolveVoice(voice);
  if (engine.installed(name)) return;
  // Kokoro voices share one model, so concurrent installs of any Kokoro voice are one download.
  const key = engine.id === "kokoro" ? "kokoro" : voice;
  let lastSent = 0;
  const listener = (done: number, total: number) => {
    const now = Date.now();
    if (done < total && now - lastSent < PROGRESS_INTERVAL_MS) return;
    lastSent = now;
    send({ id, progress: [done, total] });
  };
  let running = installs.get(key);
  if (!running) {
    const listeners = new Set<(done: number, total: number) => void>();
    const promise = engine
      .install(name, (done, total) => {
        for (const notify of listeners) notify(done, total);
      })
      .finally(() => installs.delete(key));
    running = { promise, listeners };
    installs.set(key, running);
  }
  running.listeners.add(listener);
  try {
    await running.promise;
  } finally {
    running.listeners.delete(listener);
  }
}

// ---------- synthesize (single inference at a time) ----------

/** Queued and running synthesis jobs, for `cancel`. */
const jobs = new Map<number, AbortController>();
let queue: Promise<void> = Promise.resolve();

function synthesize(request: Extract<WorkerRequest, { op: "synthesize" }>): void {
  const controller = new AbortController();
  jobs.set(request.id, controller);
  queue = queue.then(async () => {
    const { signal } = controller;
    try {
      if (signal.aborted) return;
      if (!(request.speed > 0) || !Number.isFinite(request.speed)) throw new Error(`invalid speed ${request.speed}`);
      const { engine, name } = resolveVoice(request.voice);
      const chunk = await engine.synthesize({ text: request.text, name, lang: request.lang, speed: request.speed }, signal);
      if (!signal.aborted) send({ id: request.id, ok: true, sampleRate: chunk.sampleRate, pcm: encodePcm(chunk.pcm) });
    } catch (error) {
      if (!signal.aborted) fail(request.id, error);
    } finally {
      jobs.delete(request.id);
    }
  });
}

// ---------- dispatch ----------

function handle(request: WorkerRequest): void {
  switch (request.op) {
    case "voices":
      send({
        id: request.id,
        ok: true,
        voices: VOICE_CATALOG.map((voice) => ({ ...voice, installed: engines[voice.engine].installed(voice.name) })),
      });
      return;
    case "install":
      install(request.id, request.voice).then(
        () => send({ id: request.id, ok: true }),
        (error: unknown) => fail(request.id, error),
      );
      return;
    case "synthesize":
      synthesize(request);
      return;
    case "cancel":
      jobs.get(request.target)?.abort();
      return;
    default: {
      // Unreachable for well-typed clients; reply instead of leaving the request pending.
      const unknownRequest: { id: number; op: string } = request;
      fail(unknownRequest.id, new Error(`unknown op ${JSON.stringify(unknownRequest.op)}`));
    }
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || !("id" in parsed) || typeof parsed.id !== "number") {
    console.error(`tts worker: ignoring malformed request: ${line.slice(0, 200)}`);
    return;
  }
  // The only producer is the engine client, which sends well-typed WorkerRequest values.
  const request = parsed as WorkerRequest;
  try {
    handle(request);
  } catch (error) {
    fail(request.id, error);
  }
});
// The client closing stdin means it is gone; in-flight inference has nobody to answer.
lines.on("close", () => process.exit(0));
