import { describe, expect, test } from "bun:test";
import { answerText, cleanCapture, locateInput, ScreenCapture, scrollOffset, type ScreenSnapshot } from "../../src/capture/screen.ts";

function screen(lines: string[], rows: number, cursorY = lines.length - 1, visible = true): ScreenSnapshot {
  return { lines, rows, cursor: { x: 0, y: cursorY, visible } };
}

describe("scrollOffset", () => {
  test("0 when lines only changed in place or were appended", () => {
    expect(scrollOffset(["$ ls", "a b"], ["$ ls", "a b", "$ echo hi"], 5)).toBe(0);
    expect(scrollOffset(["$ ec"], ["$ echo"], 5)).toBe(0);
  });

  test("detects the rows the content moved up", () => {
    expect(scrollOffset(["one", "two", "three", "four"], ["three", "four", "five", "six"], 4)).toBe(2);
    expect(scrollOffset(["a", "$ seq 5", "1", "2"], ["1", "2", "3", "4"], 4)).toBe(2);
  });

  test("0 when the screen was redrawn and no shift explains it", () => {
    expect(scrollOffset(["one", "two", "three"], ["alpha", "beta", "gamma"], 3)).toBe(0);
  });
});

describe("cleanCapture", () => {
  test("drops the trailing prompt, blank runs and indentation", () => {
    expect(cleanCapture(["  Answer line one", "  line two", "", "", "", "  more", "", "bash-5.2$"])).toBe(
      "Answer line one\nline two\n\nmore",
    );
  });

  test("drops frames, rules, answer markers and harness status lines", () => {
    const lines = [
      "",
      "● A TTL is the time a credential",
      "  stays valid.",
      "",
      "╭────────────────────────────╮",
      "│ >                          │",
      "╰────────────────────────────╯",
      "  ? for shortcuts",
    ];
    expect(cleanCapture(lines)).toBe("A TTL is the time a credential\nstays valid.");
  });

  test("recognizes common prompts and status hints at the end", () => {
    for (const tail of ["$", "user@host:~/work$", "(venv) ❯", "sqlite>", ">>>", "esc to interrupt", "⏎ send   ⌃J newline   12K tokens used   88% context left", "✻ Thinking… (3s)"]) {
      expect(cleanCapture(["Done.", tail])).toBe("Done.");
    }
  });

  test("keeps prompt-like text in the middle of an answer", () => {
    expect(cleanCapture(["Run this:", "$", "then wait."])).toBe("Run this:\n$\nthen wait.");
  });
});

describe("locateInput", () => {
  test("keeps the original row while it shows the submitted line", () => {
    expect(locateInput(["$ ls", "$ echo hi", "hi", "$"], 1, "$ echo hi")).toBe(1);
  });

  test("accepts the original row when the echo of the typed text arrived after Enter", () => {
    expect(locateInput(["bash-5.3$ echo hi", "hi", "bash-5.3$"], 0, "bash-5.3$")).toBe(0);
  });

  test("finds the echo of the typed text when the input area was redrawn", () => {
    const lines = ["Welcome", "> what is a TTL", "", "● It is…", "│ >   │"];
    expect(locateInput(lines, 4, "│ > what is a TTL │")).toBe(1);
  });

  test("-1 when the input cannot be found", () => {
    expect(locateInput(["$"], 3, "$ clear")).toBe(-1);
    expect(locateInput(["x"], 3, "$")).toBe(-1);
  });
});

describe("answerText", () => {
  test("text between the input line and the visible cursor", () => {
    const lines = ["$ echo hi", "hi", "$", "status: ok"];
    expect(answerText({ lines, inputRow: 0, inputLine: "$ echo hi", cursorRow: 2 })).toBe("hi");
    expect(answerText({ lines, inputRow: 0, inputLine: "$ echo hi", cursorRow: undefined })).toBe("hi\n$\nstatus: ok");
  });
});

describe("ScreenCapture", () => {
  test("returns the answer once the screen stays unchanged for idleMs", () => {
    const capture = new ScreenCapture({ idleMs: 1500 });
    expect(capture.submit(screen(["$ ls", "a", "$ echo hi there"], 6), 0)).toBeUndefined();
    expect(capture.waiting).toBe(true);
    // Nothing printed yet: no deadline, nothing to return.
    expect(capture.deadline).toBeUndefined();
    expect(capture.poll(5000)).toBeUndefined();

    expect(capture.observe(screen(["$ ls", "a", "$ echo hi there", "hi there"], 6), 100)).toBe(true);
    expect(capture.observe(screen(["$ ls", "a", "$ echo hi there", "hi there", "$"], 6), 200)).toBe(true);
    // A redraw with the same text does not move the deadline.
    expect(capture.observe(screen(["$ ls", "a", "$ echo hi there", "hi there", "$"], 6), 900)).toBe(false);
    expect(capture.deadline).toBe(1700);
    expect(capture.poll(1699)).toBeUndefined();
    expect(capture.poll(1700)).toBe("hi there");
    expect(capture.waiting).toBe(false);
    // Later changes (no new input) are ignored.
    expect(capture.observe(screen(["$ ls", "x"], 6), 2000)).toBe(false);
    expect(capture.poll(9000)).toBeUndefined();
  });

  test("keeps rows that scroll off the top", () => {
    const capture = new ScreenCapture({ idleMs: 1000 });
    capture.submit(screen(["$ ls", "a", "$ seq 5"], 4), 0);
    capture.observe(screen(["$ ls", "a", "$ seq 5", "1"], 4), 10);
    capture.observe(screen(["a", "$ seq 5", "1", "2"], 4), 20);
    capture.observe(screen(["1", "2", "3", "4"], 4), 30);
    capture.observe(screen(["3", "4", "5", "$"], 4), 40);
    expect(capture.poll(1040)).toBe("1\n2\n3\n4\n5");
  });

  test("a new input flushes the answer still settling", () => {
    const capture = new ScreenCapture({ idleMs: 1500 });
    capture.submit(screen(["$ echo one"], 6), 0);
    capture.observe(screen(["$ echo one", "one", "$ echo two"], 6), 100);
    expect(capture.submit(screen(["$ echo one", "one", "$ echo two"], 6), 200)).toBe("one");
    capture.observe(screen(["$ echo one", "one", "$ echo two", "two", "$"], 6), 300);
    expect(capture.poll(1800)).toBe("two");
  });

  test("captures a harness answer drawn above a boxed input area", () => {
    const capture = new ScreenCapture({ idleMs: 1500 });
    const before = [
      " ✻ Welcome to the harness",
      "",
      "╭──────────────────────────────╮",
      "│ > what is a TTL              │",
      "╰──────────────────────────────╯",
      "  ? for shortcuts",
    ];
    capture.submit(screen(before, 12, 3), 0);
    const thinking = [" ✻ Welcome to the harness", "", "> what is a TTL", "", "✻ Thinking… (1s)", "", ...before.slice(2, 3), "│ >                            │", ...before.slice(4)];
    capture.observe(screen(thinking, 12, 7), 100);
    const after = [
      " ✻ Welcome to the harness",
      "",
      "> what is a TTL",
      "",
      "● A TTL is the time a credential",
      "  stays valid.",
      "",
      "╭──────────────────────────────╮",
      "│ >                            │",
      "╰──────────────────────────────╯",
      "  ? for shortcuts",
    ];
    capture.observe(screen(after, 12, 8), 1200);
    expect(capture.poll(2600)).toBeUndefined();
    expect(capture.poll(2700)).toBe("A TTL is the time a credential\nstays valid.");
  });

  test("nothing when the output is only a new prompt or the screen was cleared", () => {
    const capture = new ScreenCapture({ idleMs: 100 });
    capture.submit(screen(["$ true"], 6), 0);
    capture.observe(screen(["$ true", "$"], 6), 10);
    expect(capture.poll(200)).toBeUndefined();
    capture.submit(screen(["$ x", "$ clear"], 6), 300);
    capture.observe(screen(["$"], 6, 0), 310);
    expect(capture.poll(500)).toBeUndefined();
  });
});
