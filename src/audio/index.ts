// Audio output through the first available command-line player; one temp WAV per chunk.
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AudioChunk, AudioOutput } from "../core/types.ts";
import { encodeWav } from "./wav.ts";

/** Players in preference order, with arguments that play one file and exit. */
const PLAYERS: readonly { name: string; args: (file: string) => string[] }[] = [
  { name: "pw-play", args: (file) => [file] },
  { name: "paplay", args: (file) => [file] },
  { name: "aplay", args: (file) => ["-q", file] },
  { name: "afplay", args: (file) => [file] },
  { name: "ffplay", args: (file) => ["-nodisp", "-autoexit", "-loglevel", "error", file] },
];

export interface AudioOutputOptions {
  /** Directories searched for players (default `process.env.PATH`). */
  searchPath?: string;
}

function findExecutable(name: string, searchPath: string): string | undefined {
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

export async function createAudioOutput(options: AudioOutputOptions = {}): Promise<AudioOutput> {
  const searchPath = options.searchPath ?? process.env.PATH ?? "";
  let player: { name: string; path: string; args: (file: string) => string[] } | undefined;
  for (const candidate of PLAYERS) {
    const path = findExecutable(candidate.name, searchPath);
    if (path) {
      player = { ...candidate, path };
      break;
    }
  }
  if (!player) {
    throw new Error(
      `No audio player found on PATH. Install one of: ${PLAYERS.map((p) => p.name).join(", ")} ` +
        "(pw-play/paplay come with PipeWire/PulseAudio, aplay with alsa-utils, ffplay with ffmpeg).",
    );
  }
  const { name, path, args } = player;
  let counter = 0;

  return {
    playerName: name,
    async play(chunk: AudioChunk, signal: AbortSignal): Promise<void> {
      const aborted = () => new DOMException("Playback aborted", "AbortError");
      if (signal.aborted) throw aborted();
      const file = join(tmpdir(), `speak-harness-${process.pid}-${Date.now()}-${counter++}.wav`);
      try {
        await writeFile(file, encodeWav(chunk));
        if (signal.aborted) throw aborted();
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const child = spawn(path, args(file), { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (text: string) => {
          stderr = (stderr + text).slice(-2000);
        });
        const onAbort = () => {
          child.kill("SIGTERM");
          // A player ignoring SIGTERM must still go quiet.
          setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), 500).unref();
          reject(aborted());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        child.on("error", (error) => reject(new Error(`${name} failed to start: ${error.message}`)));
        child.on("close", (code, killSignal) => {
          signal.removeEventListener("abort", onAbort);
          if (code === 0) resolve();
          else reject(new Error(`${name} exited with ${killSignal ? `signal ${killSignal}` : `code ${code}`}: ${stderr.trim()}`));
        });
        await promise;
      } finally {
        await rm(file, { force: true });
      }
    },
  };
}
