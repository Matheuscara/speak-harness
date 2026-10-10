import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { runTui } from "../../src/tui/index.ts";
import { FakeApp, fakeConfig } from "./fake-app.ts";

interface Wrapped extends TestRendererSetup {
  app: FakeApp;
  done: Promise<void>;
  settle(): Promise<string>;
  /** Renders until `predicate` holds for the frame (PTY output arrives asynchronously). */
  until(predicate: (frame: string) => boolean, timeoutMs?: number): Promise<string>;
  press(key: string, modifiers?: { ctrl?: boolean }): Promise<string>;
  type(text: string): Promise<string>;
  escape(): Promise<string>;
  /** Left pane rows (the harness terminal), right-trimmed. */
  harnessRows(): string[];
}

let current: Wrapped | undefined;
let dir: string;

// Each test runs real child processes on a PTY.
setDefaultTimeout(15_000);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "speakh-wrap-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(async () => {
  if (current && !current.renderer.isDestroyed) {
    current.renderer.destroy();
    await current.done.catch(() => {});
  }
  current = undefined;
});

const WIDTH = 100;
const HEIGHT = 24;
/** splitWidths(100): reader 40 columns including its separator. */
const HARNESS_COLS = 60;

async function wrap(command: string[], app = new FakeApp()): Promise<Wrapped> {
  const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  const done = runTui(app, { renderer: setup.renderer, cwd: dir, wrapCommand: command });
  const settle = async () => {
    await setup.flush();
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  const wrapped: Wrapped = {
    ...setup,
    app,
    done,
    settle,
    // Real child processes write to the PTY asynchronously and nothing signals "output drawn": poll the frame.
    async until(predicate, timeoutMs = 4000) {
      const end = Date.now() + timeoutMs;
      let frame = await settle();
      while (!predicate(frame)) {
        if (Date.now() > end) throw new Error(`timed out waiting for frame:\n${frame}`);
        await Bun.sleep(20);
        frame = await settle();
      }
      return frame;
    },
    async press(key, modifiers) {
      setup.mockInput.pressKey(key, modifiers);
      await setup.flush();
      return settle();
    },
    async type(text) {
      await setup.mockInput.typeText(text);
      return settle();
    },
    async escape() {
      setup.mockInput.pressEscape();
      // A lone ESC is reported after the stdin parser's 20 ms escape-sequence timeout.
      await Bun.sleep(30);
      return settle();
    },
    harnessRows() {
      return setup
        .captureCharFrame()
        .split("\n")
        .slice(1)
        .map((line) => line.slice(0, HARNESS_COLS).trimEnd());
    },
  };
  current = wrapped;
  await settle();
  return wrapped;
}

const ctrlG = { ctrl: true };

describe("wrap mode", () => {
  test("splits the screen: harness output left, reader right, title bars show the focused pane", async () => {
    const t = await wrap(["bash", "-c", "printf hello; sleep 0.3"]);
    const frame = await t.until((f) => f.includes("hello"));
    const [titles = ""] = frame.split("\n");
    expect(titles.slice(0, HARNESS_COLS)).toContain("● bash -c printf hello; sleep 0.3");
    expect(titles.slice(HARNESS_COLS)).toContain("│ ○ SpeakHarness · ctrl+g ? keys");
    expect(t.harnessRows()[0]).toBe("hello");
    // Not a known harness: the reader follows the capture session.
    expect(t.app.sessions.session?.harness).toBe("capture");
    expect(frame).toContain("capture · bash");
    expect(frame).toContain("■ — · af_heart · 1.0× · –");

    const exited = await t.until((f) => f.includes("harness exited (code 0)"));
    expect(exited.split("\n")[0]).toContain(" ■ bash · exited (code 0) · press any key to quit");
    expect(t.renderer.isDestroyed).toBe(false);
    t.mockInput.pressKey("x");
    await t.done;
    expect(t.renderer.isDestroyed).toBe(true);
  });

  test("keys go to the harness; prefix + key runs a command; esc returns focus", async () => {
    const t = await wrap(["cat"]);
    await t.type("abc");
    await t.until(() => t.harnessRows()[0] === "abc");
    // Bound reader keys reach the harness, not SpeakHarness.
    await t.press(" ");
    await t.press("q");
    expect(t.app.playback.calls).toEqual([]);
    expect(t.renderer.isDestroyed).toBe(false);
    await t.until(() => t.harnessRows()[0] === "abc q");

    let frame = await t.press("g", ctrlG);
    expect(frame).toContain(" PREFIX ");
    expect(frame.split("\n")[0]).toContain("● SpeakHarness · next key: command");
    frame = await t.press("?");
    expect(frame).toContain("─ Keys ─");
    expect(frame).not.toContain(" PREFIX ");
    expect(frame.split("\n")[0]).toContain("● SpeakHarness · esc back to cat");
    // The overlay has the keyboard: these keys scroll help instead of reaching the harness.
    await t.press("j");
    frame = await t.escape();
    expect(frame).not.toContain("─ Keys ─");
    expect(frame.split("\n")[0]).toContain("● cat");

    await t.type("d");
    t.mockInput.pressEnter();
    await t.until(() => t.harnessRows()[1] === "abc qd");
    expect(t.harnessRows().slice(0, 2)).toEqual(["abc qd", "abc qd"]);

    await t.press("g", ctrlG);
    await t.press("t");
    expect(t.app.commands.ran.at(-1)).toBe("study-mode");
    expect(t.app.playback.state.studyMode).toBe(true);
    expect(await t.settle()).not.toContain(" PREFIX ");

    t.mockInput.pressKey("d", ctrlG);
    await t.until((f) => f.includes("harness exited (code 0)"));
    t.mockInput.pressKey("return");
    await t.done;
    expect(t.renderer.isDestroyed).toBe(true);
  });

  test("prefix then → keeps keys in the reader for several commands; esc gives them back to the harness", async () => {
    const t = await wrap(["cat"]);
    await t.press("g", ctrlG);
    t.mockInput.pressArrow("right");
    let frame = await t.settle();
    expect(frame.split("\n")[0]).toContain("● SpeakHarness · esc back to cat");
    expect(frame).not.toContain(" PREFIX ");
    await t.press("t");
    await t.press("a");
    expect(t.app.commands.ran.slice(-2)).toEqual(["study-mode", "auto-read"]);
    frame = await t.escape();
    expect(frame.split("\n")[0]).toContain("● cat");
    await t.type("z");
    await t.until(() => t.harnessRows()[0] === "z");
    expect(t.app.commands.ran.at(-1)).toBe("auto-read");
  });

  test("prefix twice sends a literal prefix, esc cancels, unbound keys warn", async () => {
    const t = await wrap(["cat"]);
    await t.press("g", ctrlG);
    await t.press("g", ctrlG);
    // The tty echoes BEL as ^G.
    await t.until(() => t.harnessRows()[0] === "^G");

    let frame = await t.press("g", ctrlG);
    expect(frame).toContain(" PREFIX ");
    frame = await t.escape();
    expect(frame).not.toContain(" PREFIX ");
    await t.type("x");
    await t.until(() => t.harnessRows()[0] === "^Gx");

    await t.press("g", ctrlG);
    frame = await t.press("z");
    expect(frame).toContain("ctrl+g z is not bound to a command");
    expect(frame).not.toContain(" PREFIX ");
    await t.type("y");
    await t.until(() => t.harnessRows()[0] === "^Gxy");
  });

  test("a leader sequence after the prefix stays in SpeakHarness until it runs its command", async () => {
    const config = fakeConfig();
    config.keys["study-mode"] = ["<leader>s"];
    const t = await wrap(["cat"], new FakeApp({ config }));
    await t.press("g", ctrlG);
    expect(await t.press("\\")).toContain(" PREFIX ");
    await t.press("s");
    expect(t.app.playback.state.studyMode).toBe(true);
    expect(await t.settle()).not.toContain(" PREFIX ");
    await t.type("ok");
    await t.until(() => t.harnessRows()[0] === "ok");
  });

  test("paste goes to the harness; a click into the harness pane closes an open overlay", async () => {
    const t = await wrap(["cat"]);
    await t.mockInput.pasteBracketedText("pasted");
    await t.until(() => t.harnessRows()[0] === "pasted");
    await t.press("g", ctrlG);
    expect(await t.press("?")).toContain("─ Keys ─");
    // Left of the overlay panel, inside the harness terminal.
    await t.mockMouse.click(2, 3);
    const frame = await t.settle();
    expect(frame).not.toContain("─ Keys ─");
    expect(frame.split("\n")[0]).toContain("● cat");
    await t.type("!");
    await t.until(() => t.harnessRows()[0] === "pasted!");
  });

  test("resizing the renderer resizes the panes and the harness PTY", async () => {
    const t = await wrap(["bash", "--norc", "--noprofile"]);
    await t.until(() => /\$$/.test(t.harnessRows()[0] ?? ""));
    t.resize(120, 30);
    // splitWidths(120): reader 48 columns, harness 72; one row for the title bar.
    const titles = (await t.settle()).split("\n")[0] ?? "";
    expect(titles.indexOf("│ ○ SpeakHarness")).toBe(72);
    await t.type("stty size");
    t.mockInput.pressEnter();
    await t.until(() => t.harnessRows()[1] === "29 72");
  });

  test("prefix + q quits and stops the harness", async () => {
    const pidFile = join(dir, "pid");
    const t = await wrap(["bash", "-c", `echo $$ > ${pidFile}; exec sleep 30`]);
    const pid = Number((await waitForFile(pidFile)).trim());
    expect(alive(pid)).toBe(true);
    await t.press("g", ctrlG);
    t.mockInput.pressKey("q");
    await t.done;
    expect(t.renderer.isDestroyed).toBe(true);
    expect(alive(pid)).toBe(false);
  });

  // The capture idle timer runs on the real clock next to real PTY I/O; its timing is covered with synthetic clocks
  // in test/capture/screen.test.ts.
  test("captures the answer to an input once the screen is idle", async () => {
    const t = await wrap(["bash", "--norc", "--noprofile"]);
    await t.until(() => /\$$/.test(t.harnessRows()[0] ?? ""));
    await t.type("echo captured answer");
    await t.until(() => (t.harnessRows()[0] ?? "").endsWith("$ echo captured answer"));
    t.mockInput.pressEnter();
    await t.until(() => t.harnessRows()[1] === "captured answer");
    const frame = await t.until((f) => f.includes("answer 1/1"), 4000);
    expect(t.app.sessions.messages.map((m) => m.markdown)).toEqual(["captured answer"]);
    expect(t.app.sessions.messages[0]?.key).toStartWith("capture:capture:x");
    expect(frame.split("\n").some((line) => line.slice(HARNESS_COLS).includes("captured answer"))).toBe(true);
  });

  test("a recognized harness keeps the normal session following", async () => {
    const omp = join(dir, "omp");
    await writeFile(omp, "#!/bin/sh\nprintf 'fake omp'\nsleep 30\n");
    await chmod(omp, 0o755);
    const t = await wrap([omp, "--resume"]);
    await t.until(() => t.harnessRows()[0] === "fake omp");
    expect(t.app.sessions.followed).toEqual([]);
    expect(await t.settle()).toContain("omp · vitrum · answer 3/3");
  });

  test("a command that cannot start rejects runTui and restores the terminal", async () => {
    const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
    const done = runTui(new FakeApp(), { renderer: setup.renderer, cwd: dir, wrapCommand: ["speakh-no-such-harness"] });
    await expect(done).rejects.toThrow("cannot run speakh-no-such-harness");
    expect(setup.renderer.isDestroyed).toBe(true);
  });
});

/** Polls for a file a real child process writes. */
async function waitForFile(path: string, timeoutMs = 4000): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.trim() !== "") return text;
    if (Date.now() > end) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(20);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
