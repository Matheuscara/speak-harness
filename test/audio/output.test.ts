import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudioOutput } from "../../src/audio/index.ts";

let dir: string;
const chunk = { sampleRate: 24000, pcm: Float32Array.from([0, 0.5, -0.5]) };

function player(name: string, body: string): void {
  const file = join(dir, name);
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

describe("createAudioOutput", () => {
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
});
