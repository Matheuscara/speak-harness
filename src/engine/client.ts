// Engine client: owns the Node TTS worker process and speaks the JSON-lines protocol with it.
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { paths } from "../core/paths.ts";
import type { AudioChunk, EngineClient, SynthesisRequest, VoiceInfo } from "../core/types.ts";
import { VOICE_CATALOG } from "./catalog.ts";
import { decodePcm, VoiceNotInstalledError } from "./protocol.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";

export { VoiceNotInstalledError };

export interface EngineClientOptions {
  /** Model cache root (default `paths.cacheDir()`). */
  cacheDir?: string;
  /** Node.js ≥ 22.18 binary (default `node` from PATH). */
  nodePath?: string;
  /** Worker script (default `./worker.ts`); tests substitute a fake worker. */
  workerPath?: string;
}

type OkResponse = Extract<WorkerResponse, { ok: true }>;
type RequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, "id"> : never) : never;

interface Pending {
  resolve(response: OkResponse): void;
  reject(error: Error): void;
  onProgress?: (done: number, total: number) => void;
}

interface WorkerProcess {
  child: ChildProcessWithoutNullStreams;
  pending: Map<number, Pending>;
  /** Tail of the worker's stderr, quoted in crash errors. */
  stderr: string;
  closed: Promise<void>;
}

const STDERR_TAIL_CHARS = 4000;
const DEFAULT_WORKER = fileURLToPath(new URL("./worker.ts", import.meta.url));

export function createEngineClient(options: EngineClientOptions = {}): EngineClient {
  const nodePath = options.nodePath ?? "node";
  const workerPath = options.workerPath ?? DEFAULT_WORKER;
  const cacheDir = options.cacheDir ?? paths.cacheDir();
  let worker: WorkerProcess | undefined;
  let nextId = 1;
  let closed = false;

  const fail = (proc: WorkerProcess, error: Error) => {
    if (worker === proc) worker = undefined;
    const pending = [...proc.pending.values()];
    proc.pending.clear();
    for (const request of pending) request.reject(error);
  };

  const onLine = (proc: WorkerProcess, line: string) => {
    let message: WorkerResponse;
    try {
      message = JSON.parse(line) as WorkerResponse;
    } catch {
      proc.stderr = `${proc.stderr}${line}\n`.slice(-STDERR_TAIL_CHARS);
      return;
    }
    const request = proc.pending.get(message.id);
    if (!request) return; // cancelled or unknown: drop
    if ("progress" in message) {
      request.onProgress?.(message.progress[0], message.progress[1]);
      return;
    }
    proc.pending.delete(message.id);
    if (proc.pending.size === 0) proc.child.unref();
    if (message.ok) request.resolve(message);
    else if (message.code === "voice-not-installed") request.reject(new VoiceNotInstalledError(message.voice ?? "unknown"));
    else request.reject(new Error(message.error));
  };

  const start = (): WorkerProcess => {
    const child = spawn(
      nodePath,
      ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", workerPath, "--cache-dir", cacheDir],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const closedSignal = Promise.withResolvers<void>();
    const proc: WorkerProcess = { child, pending: new Map(), stderr: "", closed: closedSignal.promise };
    // A live worker must not keep the host process alive while nothing is pending: the pipes are
    // unreferenced once, and only the child handle is ref'd while requests are pending (Bun does not
    // undo a stream ref() with unref()). Node exposes unref on the pipes; Bun's stdin may lack it.
    for (const stream of [child.stdout, child.stderr, child.stdin]) {
      const unref: unknown = Reflect.get(stream, "unref");
      if (typeof unref === "function") unref.call(stream);
    }
    child.unref();
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => onLine(proc, line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      proc.stderr = (proc.stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.stdin.on("error", () => {}); // EPIPE after a crash; reported through "close"
    child.on("error", (error: NodeJS.ErrnoException) => {
      const reason =
        error.code === "ENOENT"
          ? `"${nodePath}" was not found; the TTS worker needs Node.js >= 22.18 on PATH`
          : error.message;
      fail(proc, new Error(`Cannot start the TTS worker: ${reason}`));
      closedSignal.resolve();
    });
    child.on("close", (code, signal) => {
      const status = signal ? `signal ${signal}` : `exit code ${code}`;
      const details = proc.stderr.trim().split("\n").slice(-8).join("\n");
      fail(proc, new Error(`TTS worker exited unexpectedly (${status})${details ? `:\n${details}` : ""}`));
      closedSignal.resolve();
    });
    return proc;
  };

  const request = (body: RequestBody, signal?: AbortSignal, onProgress?: Pending["onProgress"]): Promise<OkResponse> => {
    if (closed) return Promise.reject(new Error("engine client is closed"));
    if (signal?.aborted) return Promise.reject(new DOMException("Synthesis aborted", "AbortError"));
    const { promise, resolve, reject } = Promise.withResolvers<OkResponse>();
    const proc = (worker ??= start());
    const id = nextId++;
    const onAbort = () => {
      if (!proc.pending.delete(id)) return;
      if (proc.pending.size === 0) proc.child.unref();
      const cancel: WorkerRequest = { id: nextId++, op: "cancel", target: id };
      proc.child.stdin.write(`${JSON.stringify(cancel)}\n`);
      reject(new DOMException("Synthesis aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    proc.pending.set(id, {
      resolve: (response) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(response);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
      onProgress,
    });
    proc.child.ref();
    proc.child.stdin.write(`${JSON.stringify({ ...body, id })}\n`);
    return promise;
  };

  return {
    async voices(): Promise<VoiceInfo[]> {
      const response = await request({ op: "voices" });
      const installed = new Set("voices" in response ? response.voices.filter((v) => v.installed).map((v) => v.id) : []);
      return VOICE_CATALOG.map((voice) => ({ ...voice, installed: installed.has(voice.id) }));
    },
    async install(voice, onProgress) {
      await request({ op: "install", voice }, undefined, onProgress);
    },
    async synthesize({ text, voice, lang, speed }: SynthesisRequest, signal?: AbortSignal): Promise<AudioChunk> {
      const response = await request({ op: "synthesize", text, voice, lang, speed }, signal);
      if (!("pcm" in response)) throw new Error("TTS worker returned no audio");
      return { sampleRate: response.sampleRate, pcm: decodePcm(response.pcm) };
    },
    async close() {
      closed = true;
      const proc = worker;
      if (!proc) return;
      worker = undefined;
      fail(proc, new Error("engine client is closed"));
      proc.child.stdin.end();
      proc.child.kill("SIGTERM");
      await proc.closed;
    },
  };
}
