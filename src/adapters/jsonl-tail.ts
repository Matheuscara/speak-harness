import { watch, type FSWatcher } from "node:fs";
import { open } from "node:fs/promises";

export type TailEvent =
  /** One complete, valid JSON line. `line` counts every complete line since the start (or last reset), 0-based. */
  | { type: "record"; value: unknown; line: number }
  /** Reached the end of the file: always after the first pass, then after every pass that read new bytes. */
  | { type: "idle" }
  /** No new bytes for `settleMs` after the last read that had data. */
  | { type: "settled" }
  /** The file shrank or was replaced; reading restarts from byte 0. */
  | { type: "reset"; reason: "truncated" | "replaced" };

export interface TailOptions {
  signal: AbortSignal;
  /** Poll interval backing up `fs.watch` (missed events, replaced files). Default 1000 ms. */
  pollMs?: number;
  /** Quiet time before a `settled` event. Default 2000 ms. */
  settleMs?: number;
}

const CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;

/**
 * Follows a JSON-lines file: reads it from byte 0, then follows appends. Partial trailing lines are
 * buffered until their newline arrives; broken lines are skipped. Ends when `signal` aborts.
 */
export async function* tailJsonl(path: string, options: TailOptions): AsyncGenerator<TailEvent, void, undefined> {
  const { signal } = options;
  const pollMs = options.pollMs ?? 1000;
  const settleMs = options.settleMs ?? 2000;
  if (signal.aborted) return;

  const decoder = new TextDecoder();
  let offset = 0;
  let ino: number | undefined;
  let line = 0;
  let partial: Uint8Array = new Uint8Array(0);

  let dirty = true;
  let wake: (() => void) | undefined;
  const notify = () => {
    dirty = true;
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };

  let watcher: FSWatcher | undefined;
  const startWatcher = () => {
    watcher?.close();
    watcher = undefined;
    try {
      watcher = watch(path, notify);
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      // Missing file or unsupported platform: polling covers it.
    }
  };

  const timer = setInterval(notify, pollMs);
  signal.addEventListener("abort", notify, { once: true });
  startWatcher();

  function* parse(bytes: Uint8Array): Generator<TailEvent> {
    let start = 0;
    let end = bytes.indexOf(NEWLINE, start);
    while (end !== -1) {
      const text = decoder.decode(bytes.subarray(start, end)).trim();
      const current = line++;
      if (text) {
        let value: unknown;
        let ok = true;
        try {
          value = JSON.parse(text);
        } catch {
          ok = false;
        }
        if (ok) yield { type: "record", value, line: current };
      }
      start = end + 1;
      end = bytes.indexOf(NEWLINE, start);
    }
    partial = bytes.slice(start);
  }

  /** Reads everything after `offset`; returns whether any new bytes were read. */
  async function* pass(): AsyncGenerator<TailEvent, boolean, undefined> {
    let handle;
    try {
      handle = await open(path, "r");
    } catch {
      return false;
    }
    try {
      const stats = await handle.stat();
      let reason: "truncated" | "replaced" | undefined;
      if (ino !== undefined && stats.ino !== ino) reason = "replaced";
      else if (stats.size < offset) reason = "truncated";
      ino = stats.ino;
      if (reason) {
        offset = 0;
        line = 0;
        partial = new Uint8Array(0);
        if (reason === "replaced") startWatcher();
        yield { type: "reset", reason };
      }
      let read = false;
      const buffer = new Uint8Array(CHUNK_BYTES);
      while (offset < stats.size && !signal.aborted) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, stats.size - offset), offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        read = true;
        const chunk = buffer.subarray(0, bytesRead);
        let bytes: Uint8Array;
        if (partial.length) {
          bytes = new Uint8Array(partial.length + bytesRead);
          bytes.set(partial);
          bytes.set(chunk, partial.length);
        } else {
          bytes = chunk;
        }
        yield* parse(bytes);
      }
      return read;
    } finally {
      await handle.close();
    }
  }

  let settleTimer: NodeJS.Timeout | undefined;
  try {
    let first = true;
    let settleAt: number | undefined;
    while (!signal.aborted) {
      dirty = false;
      const read = yield* pass();
      if (signal.aborted) break;
      if (read || first) yield { type: "idle" };
      first = false;
      if (read) settleAt = Date.now() + settleMs;
      else if (settleAt !== undefined && Date.now() >= settleAt) {
        settleAt = undefined;
        yield { type: "settled" };
      }
      if (dirty || signal.aborted) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (settleAt !== undefined) settleTimer = setTimeout(notify, Math.max(0, settleAt - Date.now()));
      });
      clearTimeout(settleTimer);
    }
  } finally {
    clearTimeout(settleTimer);
    clearInterval(timer);
    signal.removeEventListener("abort", notify);
    watcher?.close();
  }
}
