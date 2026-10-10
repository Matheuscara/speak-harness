import { describe, expect, test } from "bun:test";
import { splitWidths } from "../../src/tui/wrap/index.ts";
import { PrefixState } from "../../src/tui/wrap/prefix.ts";

const PREFIX = { prefix: true, escape: false };
const ESC = { prefix: false, escape: true };
const KEY = { prefix: false, escape: false };

describe("PrefixState", () => {
  test("keys go to the harness until the prefix", () => {
    const state = new PrefixState();
    expect(state.press(KEY)).toBe("harness");
    expect(state.press(ESC)).toBe("harness");
    expect(state.active).toBe(false);
  });

  test("prefix then a key resolves one command through the keymap", () => {
    const state = new PrefixState();
    expect(state.press(PREFIX)).toBe("arm");
    expect(state.active).toBe(true);
    expect(state.press(KEY)).toBe("keymap");
    state.resolved(false);
    expect(state.active).toBe(false);
    expect(state.press(KEY)).toBe("harness");
  });

  test("prefix twice sends a literal prefix to the harness", () => {
    const state = new PrefixState();
    state.press(PREFIX);
    expect(state.press(PREFIX)).toBe("literal");
    expect(state.active).toBe(false);
  });

  test("esc cancels the prefix", () => {
    const state = new PrefixState();
    state.press(PREFIX);
    expect(state.press(ESC)).toBe("cancel");
    expect(state.press(KEY)).toBe("harness");
  });

  test("a multi-key sequence keeps keys in SpeakHarness until it resolves, times out or is cancelled", () => {
    const state = new PrefixState();
    state.press(PREFIX);
    expect(state.press(KEY)).toBe("keymap");
    state.resolved(true);
    expect(state.phase).toBe("sequence");
    expect(state.press(KEY)).toBe("keymap");
    state.resolved(false);
    expect(state.phase).toBe("idle");

    state.press(PREFIX);
    state.press(KEY);
    state.resolved(true);
    state.sequenceCleared();
    expect(state.phase).toBe("idle");

    state.press(PREFIX);
    state.press(KEY);
    state.resolved(true);
    expect(state.press(ESC)).toBe("cancel");
    expect(state.phase).toBe("idle");
  });

  test("prefix then → keeps the keyboard in the reader across commands until esc, ← or the prefix", () => {
    const RIGHT = { ...KEY, right: true };
    const LEFT = { ...KEY, left: true };
    for (const back of [ESC, LEFT, PREFIX]) {
      const state = new PrefixState();
      state.press(PREFIX);
      expect(state.press(RIGHT)).toBe("focus-reader");
      expect(state.readerFocused).toBe(true);
      expect(state.press(KEY)).toBe("keymap");
      state.resolved(false);
      expect(state.press(KEY)).toBe("keymap");
      state.resolved(true);
      // Esc inside a pending sequence only cancels the sequence; the reader keeps the keyboard.
      if (back !== ESC) expect(state.press(ESC)).toBe("cancel");
      else state.resolved(false);
      expect(state.press(back)).toBe("focus-harness");
      expect(state.readerFocused).toBe(false);
      expect(state.press(KEY)).toBe("harness");
    }
  });
});

describe("splitWidths", () => {
  test("reader ≈40% with at least 36 columns, harness keeps at least 20", () => {
    expect(splitWidths(200)).toEqual({ harness: 120, reader: 80 });
    expect(splitWidths(80)).toEqual({ harness: 44, reader: 36 });
    expect(splitWidths(50)).toEqual({ harness: 20, reader: 30 });
  });
});
