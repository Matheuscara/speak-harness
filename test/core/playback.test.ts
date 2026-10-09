import { describe, expect, test } from "bun:test";
import { VoiceNotInstalledError } from "../../src/engine/client.ts";
import { createPlaybackController } from "../../src/core/playback/controller.ts";
import { resolveVoice } from "../../src/core/playback/voices.ts";
import type { Config, PlaybackStatus } from "../../src/core/types.ts";
import { fakeAudio, fakeEngine, fakeSleep, flush, makeScript, testConfig } from "./fakes.ts";

function setup(options: { autoEngine?: boolean; autoAudio?: boolean; config?: Config } = {}) {
  const config = options.config ?? testConfig();
  const engine = fakeEngine({ auto: options.autoEngine ?? true });
  const audio = fakeAudio({ auto: options.autoAudio ?? true });
  const sleep = fakeSleep();
  const playback = createPlaybackController({ engine: engine.engine, audio: audio.audio, config: () => config, sleep: sleep.sleep });
  const statuses: PlaybackStatus[] = [playback.state.status];
  playback.subscribe((state) => {
    if (statuses.at(-1) !== state.status) statuses.push(state.status);
  });
  const played = (): string[] => audio.plays.map((play) => engine.textOf.get(play.chunk) ?? "?");
  return { config, engine, audio, sleep, playback, statuses, played };
}

describe("playback controller", () => {
  test("plays every segment, then returns to idle", async () => {
    const { playback, statuses, played } = setup();
    playback.play(makeScript("m1", ["One.", "Two.", "Three."]));
    await flush();
    // Later segments were synthesized ahead, so they start speaking without a preparing step.
    expect(statuses).toEqual(["idle", "preparing", "speaking", "idle"]);
    expect(played()).toEqual(["One.", "Two.", "Three."]);
    expect(playback.state).toMatchObject({ status: "idle", messageKey: "m1", segmentCount: 3, segmentIndex: 2 });
  });

  test("starting playback never notifies an idle state for the new script", async () => {
    const { playback } = setup({ autoAudio: false });
    const seen: string[] = [];
    playback.subscribe((state) => seen.push(`${state.status}:${state.messageKey}`));
    playback.play(makeScript("m1", ["One."]));
    await flush();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((entry) => entry.startsWith("idle"))).toEqual([]);
  });

  test("synthesizes up to two segments ahead", async () => {
    const { playback, engine } = setup({ autoEngine: false });
    playback.play(makeScript("m1", ["A.", "B.", "C.", "D.", "E."]));
    expect(engine.calls.map((call) => call.request.text)).toEqual(["A.", "B.", "C."]);
    expect(playback.state.status).toBe("preparing");
  });

  test("pause stops the player and resume restarts the same segment without re-synthesizing", async () => {
    const { playback, audio, engine, played } = setup({ autoAudio: false });
    playback.play(makeScript("m1", ["First.", "Second."]));
    await flush();
    expect(playback.state.status).toBe("speaking");
    expect(played()).toEqual(["First."]);

    playback.togglePause();
    expect(playback.state.status).toBe("paused");
    expect(audio.plays[0]?.signal.aborted).toBe(true);

    playback.togglePause();
    await flush();
    expect(playback.state.status).toBe("speaking");
    expect(played()).toEqual(["First.", "First."]);
    expect(engine.calls.filter((call) => call.request.text === "First.")).toHaveLength(1);

    audio.plays[1]?.finish();
    await flush();
    expect(played()).toEqual(["First.", "First.", "Second."]);
  });

  test("stop cancels look-ahead synthesis", async () => {
    const { playback, engine } = setup({ autoEngine: false });
    playback.play(makeScript("m1", ["A.", "B.", "C.", "D."]));
    playback.stop();
    await flush();
    expect(engine.calls).toHaveLength(3);
    expect(engine.calls.every((call) => call.aborted)).toBe(true);
    expect(playback.state.status).toBe("idle");
  });

  test("seeking cancels synthesis that is no longer needed and keeps what still is", async () => {
    const { playback, engine } = setup({ autoEngine: false });
    playback.play(makeScript("m1", ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]));
    playback.seekSegment(2);
    expect(playback.state.segmentIndex).toBe(2);
    const byText = (text: string) => engine.calls.filter((call) => call.request.text === text);
    expect(byText("s0")[0]?.aborted).toBe(true);
    expect(byText("s1")[0]?.aborted).toBe(true);
    expect(byText("s2")).toHaveLength(1);
    expect(byText("s2")[0]?.aborted).toBe(false);
    expect(byText("s3")).toHaveLength(1);
    expect(byText("s4")).toHaveLength(1);

    playback.seekSegment(10);
    expect(playback.state.segmentIndex).toBe(7);
    expect(byText("s2")[0]?.aborted).toBe(true);
    expect(byText("s7")).toHaveLength(1);
  });

  test("seekBlock jumps to the first segment of the next or previous block", async () => {
    const { playback } = setup({ autoAudio: false });
    const script = makeScript("m1", [
      { text: "a1", block: 0 },
      { text: "a2", block: 0 },
      { text: "b1", block: 2 },
      { text: "b2", block: 2 },
      { text: "c1", block: 3 },
    ]);
    playback.play(script, 1);
    playback.seekBlock(1);
    expect(playback.state.segmentIndex).toBe(2);
    playback.seekBlock(1);
    expect(playback.state.segmentIndex).toBe(4);
    playback.seekBlock(-2);
    expect(playback.state.segmentIndex).toBe(0);
  });

  test("seeking while paused moves the position and stays paused", async () => {
    const { playback, played } = setup({ autoAudio: false });
    playback.play(makeScript("m1", ["A.", "B.", "C."]));
    await flush();
    playback.pause();
    playback.seekSegment(1);
    await flush();
    expect(playback.state).toMatchObject({ status: "paused", segmentIndex: 1 });
    playback.resume();
    await flush();
    expect(played()).toEqual(["A.", "B."]);
  });

  test("honors the pause after each segment", async () => {
    const { playback, sleep } = setup();
    playback.play(makeScript("m1", [{ text: "Title", kind: "heading", pause: 600 }, "Body."]));
    await flush();
    expect(sleep.calls).toEqual([600]);
  });

  test("study mode waits after each sentence until continued", async () => {
    const config = testConfig((c) => {
      c.study.pauseAfterSentence = true;
    });
    const { playback, played } = setup({ config });
    playback.setStudyMode(true);
    playback.play(makeScript("m1", ["One.", "Two."]));
    await flush();
    expect(playback.state).toMatchObject({ status: "study-wait", segmentIndex: 0 });
    expect(played()).toEqual(["One."]);

    playback.repeatSegment();
    await flush();
    expect(played()).toEqual(["One.", "One."]);
    expect(playback.state.status).toBe("study-wait");

    playback.continueStudy();
    await flush();
    expect(playback.state).toMatchObject({ status: "study-wait", segmentIndex: 1 });
    playback.continueStudy();
    await flush();
    expect(playback.state.status).toBe("idle");
    expect(played()).toEqual(["One.", "One.", "Two."]);
  });

  test("shadowing leaves silence proportional to the spoken audio", async () => {
    const config = testConfig((c) => {
      c.study.shadowing = true;
      c.study.shadowingFactor = 1.5;
    });
    const { playback, engine, sleep, played } = setup({ config, autoEngine: false });
    playback.setStudyMode(true);
    playback.play(makeScript("m1", ["One.", "Two."]));
    engine.calls[0]?.resolve(2000);
    engine.calls[1]?.resolve(400);
    await flush();
    await flush();
    expect(sleep.calls).toEqual([3000, 600]);
    expect(played()).toEqual(["One.", "Two."]);
    expect(playback.state.status).toBe("idle");
  });

  test("repeat slower re-synthesizes the current segment at speed × slowerSpeed only once", async () => {
    const { playback, engine } = setup({ autoAudio: false });
    playback.play(makeScript("m1", ["A.", "B.", "C.", "D."]));
    await flush();
    playback.repeatSegment({ slower: true });
    const slow = engine.calls.filter((call) => call.request.text === "A." && call.request.speed === 0.75);
    expect(slow).toHaveLength(1);
    expect(engine.calls.filter((call) => call.request.text === "B.").every((call) => call.request.speed === 1)).toBe(true);
  });

  test("speed is bounded to 0.5–2.0 in 0.1 steps and applies to new synthesis", async () => {
    const { playback, engine } = setup({ autoEngine: false });
    playback.setSpeed(1.1 + 0.1);
    expect(playback.state.speed).toBe(1.2);
    playback.setSpeed(9);
    expect(playback.state.speed).toBe(2);
    playback.setSpeed(0.1);
    expect(playback.state.speed).toBe(0.5);
    playback.play(makeScript("m1", ["A."]));
    expect(engine.calls[0]?.request.speed).toBe(0.5);
  });

  test("a missing voice surfaces an install hint and returns to idle", async () => {
    const config = testConfig();
    const engine = fakeEngine({ fail: (request) => new VoiceNotInstalledError(request.voice) });
    const audio = fakeAudio({ auto: true });
    const playback = createPlaybackController({ engine: engine.engine, audio: audio.audio, config: () => config, sleep: fakeSleep().sleep });
    playback.play(makeScript("m1", [{ text: "Olá.", lang: "pt-BR" }]));
    await flush();
    expect(playback.state.status).toBe("idle");
    expect(playback.state.error).toContain("speakh voices install piper:pt_BR-faber-medium");
    expect(audio.plays).toHaveLength(0);
  });

  test("player failures are reported in state.error", async () => {
    const config = testConfig();
    const engine = fakeEngine({ auto: true });
    const playback = createPlaybackController({
      engine: engine.engine,
      audio: { playerName: "broken", play: async () => Promise.reject(new Error("no audio player found")) },
      config: () => config,
    });
    playback.play(makeScript("m1", ["A."]));
    await flush();
    expect(playback.state).toMatchObject({ status: "idle", error: "no audio player found" });
  });

  test("voice follows the segment language and the override", async () => {
    const { playback, engine } = setup({ autoEngine: false });
    playback.play(makeScript("m1", [{ text: "Hi.", lang: "en" }, { text: "Oi.", lang: "pt-BR" }]));
    expect(engine.calls.map((call) => call.request.voice)).toEqual(["kokoro:af_heart", "piper:pt_BR-faber-medium"]);
    expect(playback.state).toMatchObject({ voice: "kokoro:af_heart", lang: "en" });
    playback.setVoiceOverride("alternate");
    playback.seekSegment(1);
    expect(engine.calls.at(-1)?.request).toMatchObject({ text: "Oi.", voice: "kokoro:pf_dora" });
  });
});

describe("resolveVoice", () => {
  const config = testConfig();
  test("auto uses the language map", () => {
    expect(resolveVoice(config, "auto", "en")).toBe("kokoro:af_heart");
    expect(resolveVoice(config, "auto", "pt-BR")).toBe("piper:pt_BR-faber-medium");
  });
  test("overrides win over language", () => {
    expect(resolveVoice(config, "primary", "pt-BR")).toBe("kokoro:af_heart");
    expect(resolveVoice(config, "alternate", "en")).toBe("kokoro:pf_dora");
  });
  test("auto falls back to primary when auto-language is off", () => {
    const off = testConfig((c) => {
      c.voices.autoLanguage = false;
    });
    expect(resolveVoice(off, "auto", "pt-BR")).toBe("kokoro:af_heart");
  });
});
