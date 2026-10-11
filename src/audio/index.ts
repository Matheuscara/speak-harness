// Audio output through the first available player; one temp WAV per chunk.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AudioChunk, AudioOutput } from "../core/types.ts";
import { encodeWav } from "./wav.ts";

type Env = Readonly<Record<string, string | undefined>>;

interface Player {
  name: string;
  /** File name searched on PATH. */
  executable: string;
  /** Absolute locations tried before PATH. */
  locations?: (env: Env) => string[];
  /** Arguments that play `file` once and exit. */
  args(file: string): string[];
  /** Variables added to the player's environment. */
  env?(file: string): Record<string, string>;
}

/** The WAV path reaches PowerShell through the environment, so no file name is ever parsed as code or re-quoted. */
const WAV_VARIABLE = "SPEAKH_WAV_FILE";

/**
 * Plays the WAV through .NET's SoundPlayer and exits; a failure exits 1 with the reason on stderr. One line without
 * double quotes, so the Windows command line hands it to PowerShell intact.
 */
const POWERSHELL_PLAY_SCRIPT =
  "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
  `try { (New-Object System.Media.SoundPlayer $env:${WAV_VARIABLE}).PlaySync() } ` +
  "catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }";

/** Players in preference order. */
const POSIX_PLAYERS: readonly Player[] = [
  { name: "pw-play", executable: "pw-play", args: (file) => [file] },
  { name: "paplay", executable: "paplay", args: (file) => [file] },
  { name: "aplay", executable: "aplay", args: (file) => ["-q", file] },
  { name: "afplay", executable: "afplay", args: (file) => [file] },
  { name: "ffplay", executable: "ffplay", args: (file) => ["-nodisp", "-autoexit", "-loglevel", "error", file] },
];

/** Windows PowerShell ships with every supported Windows, so WAV playback needs nothing installed. */
const WINDOWS_PLAYERS: readonly Player[] = [
  {
    name: "powershell",
    executable: "powershell.exe",
    locations: (env) =>
      [env.SystemRoot, env.SYSTEMROOT, env.windir, env.WINDIR].flatMap((root) =>
        root ? [join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")] : [],
      ),
    args: () => ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_PLAY_SCRIPT],
    env: (file) => ({ [WAV_VARIABLE]: file }),
  },
  { name: "ffplay", executable: "ffplay.exe", args: (file) => ["-nodisp", "-autoexit", "-loglevel", "error", file] },
];

export interface AudioOutputOptions {
  /** Directories searched for players (default `env.PATH`). */
  searchPath?: string;
  /** Selects the player table (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** Environment used to locate players (default `process.env`). */
  env?: Env;
}

function executableAt(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findPlayer(players: readonly Player[], searchPath: string, env: Env): { player: Player; path: string } | undefined {
  // Windows PATH entries may be quoted; POSIX ones never are.
  const dirs = searchPath
    .split(delimiter)
    .map((dir) => dir.replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir !== "");
  for (const player of players) {
    const candidates = [...(player.locations?.(env) ?? []), ...dirs.map((dir) => join(dir, player.executable))];
    const path = candidates.find(executableAt);
    if (path) return { player, path };
  }
  return undefined;
}

export async function createAudioOutput(options: AudioOutputOptions = {}): Promise<AudioOutput> {
  const env = options.env ?? process.env;
  const windows = (options.platform ?? process.platform) === "win32";
  const players = windows ? WINDOWS_PLAYERS : POSIX_PLAYERS;
  const found = findPlayer(players, options.searchPath ?? env.PATH ?? env.Path ?? "", env);
  if (!found) {
    throw new Error(
      windows
        ? "No audio player found. Windows PowerShell (powershell.exe, part of Windows) plays WAV natively; " +
            "otherwise put ffplay (from ffmpeg) on PATH."
        : `No audio player found on PATH. Install one of: ${players.map((p) => p.name).join(", ")} ` +
            "(pw-play/paplay come with PipeWire/PulseAudio, aplay with alsa-utils, ffplay with ffmpeg).",
    );
  }
  const { player, path } = found;
  const { name } = player;

  return {
    playerName: name,
    async play(chunk: AudioChunk, signal: AbortSignal): Promise<void> {
      const aborted = () => new DOMException("Playback aborted", "AbortError");
      if (signal.aborted) throw aborted();
      // Unpredictable name, created exclusively and private: a shared temp directory cannot redirect the write.
      const file = join(tmpdir(), `speak-harness-${process.pid}-${randomUUID()}.wav`);
      try {
        await writeFile(file, encodeWav(chunk), { flag: "wx", mode: 0o600 });
        if (signal.aborted) throw aborted();
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const child = spawn(path, player.args(file), {
          stdio: ["ignore", "ignore", "pipe"],
          env: player.env && { ...process.env, ...player.env(file) },
          windowsHide: true,
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (text: string) => {
          stderr = (stderr + text).slice(-2000);
        });
        let escalate: NodeJS.Timeout | undefined;
        const onAbort = () => {
          child.kill("SIGTERM");
          // A player ignoring SIGTERM must still go quiet.
          escalate = setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), 500);
        };
        const settle = (error?: Error) => {
          signal.removeEventListener("abort", onAbort);
          clearTimeout(escalate);
          if (error) reject(error);
          else resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        child.on("error", (error) => settle(new Error(`${name} failed to start: ${error.message}`)));
        // Settling only once the player is gone means it went quiet and no longer holds the WAV open (Windows cannot
        // delete an open file). An aborted player settles on exit: a grandchild holding stderr must not delay it.
        child.on("exit", () => {
          if (signal.aborted) settle(aborted());
        });
        child.on("close", (code, killSignal) => {
          if (signal.aborted) settle(aborted());
          else if (code === 0) settle();
          else settle(new Error(`${name} exited with ${killSignal ? `signal ${killSignal}` : `code ${code}`}: ${stderr.trim()}`));
        });
        await promise;
      } finally {
        await rm(file, { force: true });
      }
    },
  };
}
