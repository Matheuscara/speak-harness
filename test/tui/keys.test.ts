import { afterAll, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { Command } from "../../src/core/types.ts";
import { KeyController, keyFromEvent } from "../../src/tui/keys.ts";
import { filterCommands, fuzzyScore } from "../../src/tui/overlays/palette.ts";
import { fakeConfig } from "./fake-app.ts";

const { renderer } = await createTestRenderer({ width: 40, height: 10 });
const keys = new KeyController(renderer, { onCommand: () => {}, blocked: () => false, title: (id) => id });
keys.bind(fakeConfig().keys);
afterAll(() => {
  keys.dispose();
  renderer.destroy();
});

describe("key analysis", () => {
  test("default keys have no conflicts or invalid entries", () => {
    expect(keys.analyze(fakeConfig().keys)).toEqual({ conflicts: [], invalid: [] });
  });

  test("the same stroke spelled differently is a conflict", () => {
    const config = fakeConfig();
    config.keys.stop = ["ctrl+shift+x"];
    config.keys.quit = ["shift+ctrl+x"];
    expect(keys.analyze(config.keys).conflicts).toEqual([{ key: "ctrl+shift+x", commands: ["stop", "quit"] }]);
  });

  test("invalid key syntax is reported, not thrown", () => {
    const config = fakeConfig();
    config.keys.stop = ["ctrl+"];
    const { invalid } = keys.analyze(config.keys);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ command: "stop", key: "ctrl+" });
  });

  test("conflictsFor lists the other commands bound to a candidate key", () => {
    expect(keys.conflictsFor(fakeConfig().keys, "stop", "l")).toEqual(["next-sentence"]);
    expect(keys.conflictsFor(fakeConfig().keys, "next-sentence", "l")).toEqual([]);
  });

  test("keyFromEvent produces binding syntax", () => {
    const base = { ctrl: false, meta: false, shift: false, super: false };
    expect(keyFromEvent({ ...base, name: "r", ctrl: true })).toBe("ctrl+r");
    expect(keyFromEvent({ ...base, name: "l", shift: true })).toBe("shift+l");
    expect(keyFromEvent({ ...base, name: " " })).toBe("space");
    expect(keyFromEvent({ ...base, name: "?" })).toBe("?");
  });
});

describe("fuzzy filter", () => {
  const command = (id: Command["id"], title: string): Command => ({ id, title, group: "app", run: () => {} });
  const commands = [command("play-pause", "Play / pause"), command("study-mode", "Toggle study mode"), command("speed-up", "Speed up")];

  test("matches subsequences and ranks tighter matches first", () => {
    expect(fuzzyScore("xyz", "Play / pause")).toBeUndefined();
    expect(filterCommands(commands, "sp")[0]?.id).toBe("speed-up");
    expect(filterCommands(commands, "stdy").map((c) => c.id)).toEqual(["study-mode"]);
    expect(filterCommands(commands, "").map((c) => c.id)).toEqual(["play-pause", "study-mode", "speed-up"]);
  });
});
