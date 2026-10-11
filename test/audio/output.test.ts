import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudioOutput } from "../../src/audio/index.ts";

let dir: string;
const chunk = { sampleRate: 24000, pcm: Float32Array.from([0, 0.5, -0.5]) };

function player(name: string, body: string, where = dir): void {
  const file = join(where, name);
  writeFileSync(file, `#!/usr/bin/env sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/** Players are real subprocesses, so their state is observed by polling, not by fake timers. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "speakh-audio-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Players are faked with shell scripts, so these run on POSIX only — including the Windows player table.
describe.skipIf(process.platform === "win32")("createAudioOutput", () => {
  test("uses the first available player in preference order", async () => {
    player("aplay", "exit 0");
    player("paplay", "exit 0");
    expect((await createAudioOutput({ searchPath: dir })).playerName).toBe("paplay");
  });

  test("fails clearly when no player is installed", async () => {
    await expect(createAudioOutput({ searchPath: dir })).rejects.toThrow(/No audio player found.*pw-play, paplay, aplay, afplay, ffplay/);
  });

  test("plays one temp WAV per chunk and removes it afterwards", async () => {
    player("pw-play", `echo "$1" > "${dir}/path"; cp "$1" "${dir}/played.wav"`);
    const output = await createAudioOutput({ searchPath: dir });
    await output.play(chunk, new AbortController().signal);
    const played = readFileSync(join(dir, "played.wav"));
    expect(played.subarray(0, 4).toString()).toBe("RIFF");
    expect(played.readUInt32LE(24)).toBe(24000);
    expect(played.byteLength).toBe(44 + 6);
    expect(existsSync(readFileSync(join(dir, "path"), "utf8").trim())).toBe(false);
  });

  test("abort kills the player, rejects with AbortError, and removes the temp file", async () => {
    player("pw-play", `echo "$1" > "${dir}/path"; echo $$ > "${dir}/pid"; exec sleep 30`);
    const output = await createAudioOutput({ searchPath: dir });
    const controller = new AbortController();
    const playing = output.play(chunk, controller.signal).catch((e: unknown) => e);
    await waitFor(() => existsSync(join(dir, "pid")) && readFileSync(join(dir, "pid"), "utf8").endsWith("\n"), "player start");
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    expect(alive(pid)).toBe(true);

    controller.abort();
    const error = await playing;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    await waitFor(() => !alive(pid), "player exit");
    expect(existsSync(readFileSync(join(dir, "path"), "utf8").trim())).toBe(false);
  });

  test("an already-aborted signal never starts the player", async () => {
    player("pw-play", `touch "${dir}/started"`);
    const output = await createAudioOutput({ searchPath: dir });
    const error = await output.play(chunk, AbortSignal.abort()).catch((e: unknown) => e);
    expect((error as DOMException).name).toBe("AbortError");
    expect(existsSync(join(dir, "started"))).toBe(false);
  });

  test("a failing player rejects with its stderr", async () => {
    player("pw-play", `echo "no sink available" >&2; exit 2`);
    const output = await createAudioOutput({ searchPath: dir });
    await expect(output.play(chunk, new AbortController().signal)).rejects.toThrow(/pw-play exited with code 2: no sink available/);
  });

  describe("on Windows", () => {
    /** A fake `%SystemRoot%`, holding powershell.exe where Windows ships it. */
    function windowsRoot(body: string): string {
      const root = join(dir, "Windows");
      const bin = join(root, "System32", "WindowsPowerShell", "v1.0");
      mkdirSync(bin, { recursive: true });
      player("powershell.exe", body, bin);
      return root;
    }
    /** A fresh directory standing for PATH. */
    const pathDir = () => mkdtempSync(join(dir, "path-"));

    test("plays through the built-in PowerShell, handing it the WAV path through the environment only", async () => {
      const root = windowsRoot(
        `for arg in "$@"; do printf '%s\\n' "$arg"; done > "${dir}/args"
         printf '%s' "$SPEAKH_WAV_FILE" > "${dir}/path"
         cp "$SPEAKH_WAV_FILE" "${dir}/played.wav"`,
      );
      // ffplay on PATH must not win over the player Windows ships.
      const path = pathDir();
      player("ffplay.exe", `touch "${dir}/ffplay"`, path);
      const output = await createAudioOutput({ platform: "win32", env: { SystemRoot: root }, searchPath: path });
      expect(output.playerName).toBe("powershell");
      await output.play(chunk, new AbortController().signal);

      const played = readFileSync(join(dir, "played.wav"));
      expect(played.subarray(0, 4).toString()).toBe("RIFF");
      expect(played.byteLength).toBe(44 + 6);
      const wav = readFileSync(join(dir, "path"), "utf8");
      expect(existsSync(wav)).toBe(false);
      expect(existsSync(join(dir, "ffplay"))).toBe(false);

      const args = readFileSync(join(dir, "args"), "utf8").trimEnd().split("\n");
      expect(args.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
      const script = args.at(-1)!;
      expect(script).toContain("System.Media.SoundPlayer $env:SPEAKH_WAV_FILE");
      expect(script).toContain(".PlaySync()");
      // Windows re-quotes arguments with double quotes; a script containing one would reach PowerShell broken.
      expect(script).not.toContain('"');
      expect(args.some((arg) => arg.includes(wav))).toBe(false);
    });

    test("a PowerShell failure rejects with its stderr and still removes the WAV", async () => {
      const root = windowsRoot(`printf '%s' "$SPEAKH_WAV_FILE" > "${dir}/path"; echo "Sound API unavailable" >&2; exit 1`);
      const output = await createAudioOutput({ platform: "win32", env: { SystemRoot: root }, searchPath: pathDir() });
      await expect(output.play(chunk, new AbortController().signal)).rejects.toThrow(
        /powershell exited with code 1: Sound API unavailable/,
      );
      expect(existsSync(readFileSync(join(dir, "path"), "utf8"))).toBe(false);
    });

    test("abort stops PowerShell before the WAV is removed", async () => {
      const root = windowsRoot(`printf '%s' "$SPEAKH_WAV_FILE" > "${dir}/path"; echo $$ > "${dir}/pid"; exec sleep 30`);
      const output = await createAudioOutput({ platform: "win32", env: { SystemRoot: root }, searchPath: pathDir() });
      const controller = new AbortController();
      const playing = output.play(chunk, controller.signal).catch((e: unknown) => e);
      await waitFor(() => existsSync(join(dir, "pid")) && readFileSync(join(dir, "pid"), "utf8").endsWith("\n"), "player start");
      const pid = Number(readFileSync(join(dir, "pid"), "utf8"));

      controller.abort();
      expect(((await playing) as DOMException).name).toBe("AbortError");
      // Settled only after the player exited: Windows cannot delete a file a live process holds open.
      expect(alive(pid)).toBe(false);
      expect(existsSync(readFileSync(join(dir, "path"), "utf8"))).toBe(false);
    });

    test("without PowerShell, falls back to ffplay.exe on PATH and never to POSIX players", async () => {
      const path = pathDir();
      player("pw-play", "exit 0", path);
      player("ffplay.exe", "exit 0", path);
      expect((await createAudioOutput({ platform: "win32", env: {}, searchPath: path })).playerName).toBe("ffplay");
    });

    test("with no player at all, points at Windows PowerShell", async () => {
      const path = pathDir();
      player("pw-play", "exit 0", path);
      await expect(createAudioOutput({ platform: "win32", env: {}, searchPath: path })).rejects.toThrow(
        /No audio player found\. Windows PowerShell \(powershell\.exe/,
      );
    });
  });

  test("POSIX never uses the Windows player", async () => {
    const root = join(dir, "Windows", "System32", "WindowsPowerShell", "v1.0");
    mkdirSync(root, { recursive: true });
    player("powershell.exe", "exit 0", root);
    player("powershell.exe", "exit 0");
    await expect(createAudioOutput({ platform: "linux", env: { SystemRoot: join(dir, "Windows") }, searchPath: dir })).rejects.toThrow(
      /No audio player found on PATH/,
    );
  });
});
