import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { PlaybackState } from "../../src/core/types.ts";
import { motionAllowed, progressMeter, ReaderView } from "../../src/tui/reader.ts";

const playback = (segmentIndex: number, segmentCount: number, status: PlaybackState["status"] = "speaking"): PlaybackState => ({
  segmentIndex, segmentCount, status, speed: 1, voiceOverride: "auto", studyMode: false,
});

test("segment progress is exact, bounded, and adapts to a narrow pane", () => {
  expect(progressMeter(playback(1, 4), 90)).toMatchObject({ percent: 50, position: "2/4" });
  expect(progressMeter(playback(100, 4), 36)).toMatchObject({ percent: 100, position: "4/4", complete: "━━━━━━━━", remaining: "" });
  expect(progressMeter(playback(0, 0), 36)).toMatchObject({ percent: 0, position: "0/0" });
  expect(progressMeter(playback(1, 4), 36).complete.length).toBeLessThan(progressMeter(playback(1, 4), 90).complete.length);
});

test("NO_COLOR and reduced-motion opt-outs disable animation", () => {
  expect(motionAllowed({})).toBe(true);
  expect(motionAllowed({ NO_COLOR: "1" })).toBe(false);
  expect(motionAllowed({ SPEAKH_REDUCE_MOTION: "1" })).toBe(false);
  expect(motionAllowed({ TERM: "dumb" })).toBe(false);
});

test("reader renders real playback position and survives a pause without moving content", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const reader = new ReaderView(setup.renderer);
  setup.renderer.root.add(reader.root);
  try {
    reader.setPlayback(playback(1, 4));
    await setup.renderOnce();
    const first = setup.captureCharFrame();
    expect(first).toContain("SPEAKHARNESS");
    expect(first).toContain("PROGRESS");
    expect(first).toContain("50%  2/4");
    reader.setPlayback(playback(1, 4, "paused"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("50%  2/4");
  } finally {
    reader.dispose();
    setup.renderer.destroy();
  }
});
