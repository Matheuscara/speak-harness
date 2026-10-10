import { afterEach, describe, expect, test } from "bun:test";
import { RGBA, TextRenderable } from "@opentui/core";
import {
  createTestRenderer,
  type TestRendererSetup,
} from "@opentui/core/testing";
import { runTui } from "../../src/tui/index.ts";
import { theme } from "../../src/tui/theme.ts";
import { FakeApp, fakeConfig } from "./fake-app.ts";

const HIGHLIGHT = RGBA.fromHex(theme.highlightBg);

interface Harness extends TestRendererSetup {
  app: FakeApp;
  done: Promise<void>;
  settle(): Promise<string>;
  press(...keys: string[]): Promise<string>;
  escape(): Promise<string>;
  highlightedText(): string;
}

let current: Harness | undefined;

async function start(app = new FakeApp()): Promise<Harness> {
  const setup = await createTestRenderer({ width: 90, height: 32 });
  const done = runTui(app, { renderer: setup.renderer, cwd: "/work/vitrum" });
  const settle = async () => {
    await setup.flush();
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  const harness: Harness = {
    ...setup,
    app,
    done,
    settle,
    async press(...keys) {
      for (const key of keys) {
        setup.mockInput.pressKey(key);
        await setup.flush();
      }
      return settle();
    },
    async escape() {
      setup.mockInput.pressEscape();
      // A lone ESC byte is reported only after the stdin parser's 20 ms escape-sequence timeout. That timer runs
      // on the renderer clock, and a ManualClock also stalls frame scheduling (flush never idles), so wait for real.
      await Bun.sleep(30);
      return settle();
    },
    highlightedText() {
      return setup
        .captureSpans()
        .lines.map((line) =>
          line.spans
            .filter((span) => span.bg.equals(HIGHLIGHT))
            .map((span) => span.text)
            .join(""),
        )
        .filter((text) => text !== "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    },
  };
  current = harness;
  await settle();
  return harness;
}

afterEach(async () => {
  if (current && !current.renderer.isDestroyed) {
    current.renderer.destroy();
    await current.done.catch(() => {});
  }
  current = undefined;
});

describe("reader", () => {
  test("shows the newest answer with header and idle status", async () => {
    const t = await start();
    const frame = t.captureCharFrame();
    expect(frame).toContain("omp · vitrum · answer 3/3");
    expect(frame).toContain("What is this task about?");
    expect(frame).toContain("• Temporary: the credential has a TTL.");
    expect(frame).toContain("const user = await vault.issue");
    expect(frame).toContain("ttl  │ number │ 3600");
    expect(frame).toContain("■ READY");
    expect(frame).toContain("SPEED 1.0×");
    expect(frame).toContain("⚙ SETTINGS [,]");
    expect(t.highlightedText()).toBe("");
  });

  test("highlights the current segment and follows playback state", async () => {
    const t = await start();
    await t.press(" ");
    expect(t.app.playback.state.status).toBe("speaking");
    expect(t.highlightedText()).toBe("What is this task about?");

    await t.press("l");
    expect(t.highlightedText()).toBe(
      "Developers use the app's database user to access production.",
    );

    t.app.playback.advanceTo(2);
    await t.settle();
    expect(t.highlightedText()).toBe("Each credential is temporary.");

    t.app.playback.stop();
    await t.settle();
    expect(t.highlightedText()).toBe("");
  });

  test("footer shows playback, voice and speed without repeating segment position", async () => {
    const t = await start();
    await t.press(" ", "l", "+", "t", "2");
    const frame = t.captureCharFrame();
    const status = frame.split("\n").find((line) => line.includes("PLAYING"));
    expect(status).toContain("EN · Dora");
    expect(status).toContain("SPEED 1.1×");
    expect(status).not.toContain("2/7");
    expect(frame).toContain("2/7");
    expect(frame).toContain("⚙ SETTINGS [,]");
  });

  test("auto-scrolls the highlighted sentence into view", async () => {
    const app = new FakeApp();
    await app.sessions.follow(
      app.sessions.messages.length
        ? (await app.sessions.list({}))[1]!
        : (await app.sessions.list({}))[0]!,
    );
    const t = await start(app);
    expect(t.captureCharFrame()).toContain("Paragraph 1 explains");
    await t.press(" ");
    app.playback.advanceTo(25);
    await t.settle();
    await t.settle();
    expect(t.highlightedText()).toContain("Paragraph 26 explains");
    expect(t.captureCharFrame()).not.toContain("Paragraph 1 explains");
  });

  test("re-renders when the shown message arrives again with new text; narration does not replace it", async () => {
    const t = await start();
    const shown = t.app.sessions.messages.at(-1)!;
    t.app.sessions.update(shown.key, "## Updated heading\n\nNew text arrived.");
    let frame = await t.settle();
    expect(frame).toContain("Updated heading");
    expect(frame).not.toContain("What is this task about?");

    t.app.sessions.push("Now running the migration script.", true);
    frame = await t.settle();
    expect(frame).toContain("Updated heading");
    expect(frame).not.toContain("Now running the migration script.");

    t.app.sessions.push("Migration finished without errors.");
    frame = await t.settle();
    expect(frame).toContain("Migration finished without errors.");
  });

  test("notices and harness warnings appear on the notice line", async () => {
    const t = await start();
    t.app.notify("error", "Voice piper:x is not installed");
    expect(await t.settle()).toContain("⚠ Voice piper:x is not installed");
    t.app.sessions.warn("could not parse line 12");
    expect(await t.settle()).toContain("⚠ omp: could not parse line 12");
  });
});

describe("overlays", () => {
  const cases: Array<[string, string, string]> = [
    ["m", "m", "Messages"],
    ["shift+p", "P", "Phrases"],
    [":", ":", "Command palette"],
    ["?", "?", "Keys"],
  ];
  for (const [name, key, title] of cases) {
    test(`${name} opens ${title} and esc closes it`, async () => {
      const t = await start();
      expect(t.captureCharFrame()).not.toContain(`─ ${title} ─`);
      const opened = await t.press(key);
      expect(opened).toContain(`─ ${title} ─`);
      // Global bindings are inactive while an overlay is open.
      await t.press("q");
      expect(t.renderer.isDestroyed).toBe(false);
      const closed = await t.escape();
      expect(closed).not.toContain(`─ ${title} ─`);
      expect(closed).toContain("What is this task about?");
    });
  }

  test("session scope starts here, then can show other folders and follow one", async () => {
    const t = await start();
    const here = await t.press("\t");
    expect(here).toContain("HERE [tab]");
    expect(here).toContain("vitrum");
    expect(here).not.toContain("billing api");
    const all = await t.press("\t");
    expect(all).toContain("ALL FOLDERS [tab]");
    expect(all).toContain("billing api");
    await t.press("j", "\r");
    await t.settle();
    expect(t.app.sessions.followed).toEqual(["s-other"]);
    const after = await t.settle();
    expect(after).toContain("codex · billing api");
    expect(after).toContain("Paragraph 1 explains");
  });

  test("messages marks narration and reads the chosen answer", async () => {
    const t = await start();
    const frame = await t.press("m");
    expect(frame).toContain("┄ Let me check the vault configuration first.");
    expect(frame).toContain("narration");
    await t.press("j", "j", "\r");
    expect(t.app.selectedMessageKey).toBe("omp:s-vitrum:m1");
    expect(t.app.playback.calls).toContain("play:omp:s-vitrum:m1:0");
    expect(await t.settle()).toContain("Você pode testar a conexão agora.");
  });

  test("phrases lists saved phrases and plays one", async () => {
    const t = await start();
    const frame = await t.press("P");
    expect(frame).toContain("Você pode testar a conexão agora.");
    expect(frame).toContain("Each credential is temporary.");
    await t.press("\r");
    expect(t.app.playback.script?.messageKey).toMatch(/^phrase:/);
    expect(t.app.playback.script?.segments[0]?.text).toContain("conexão");
  });

  test("command palette filters fuzzily and runs the chosen command", async () => {
    const t = await start();
    await t.press(":");
    await t.mockInput.typeText("stdy");
    const frame = await t.settle();
    expect(frame).toContain("Toggle study mode");
    expect(frame).not.toContain("Play / pause");
    await t.press("\r");
    expect(t.app.commands.ran).toContain("study-mode");
    expect(t.app.playback.state.studyMode).toBe(true);
    expect(await t.settle()).not.toContain("─ Command palette ─");
  });

  test("help is generated from the live keymap", async () => {
    const t = await start();
    const frame = await t.press("?");
    expect(frame).toMatch(/space\s+Play \/ pause/);
    expect(frame).toMatch(/shift\+l\s+Next block/);
    expect(frame).toMatch(/\+, =\s+Speed up/);
  });
});

test("settings control in the reader footer opens settings by mouse", async () => {
  const t = await start();
  const button = t.renderer.root.findDescendantById("reader-settings") as
    | TextRenderable
    | undefined;
  expect(button).toBeDefined();
  await t.mockMouse.click(button!.x + 2, button!.y);
  expect(await t.settle()).toContain("SETTINGS  /  AUDIO");
});

describe("settings", () => {
  test("speed is the first audio setting and changes persistently; reading options are a separate tab", async () => {
    const t = await start();
    let frame = await t.press(",");
    expect(frame).toContain("SETTINGS  /  AUDIO");
    expect(frame).toContain("Playback speed");
    expect(frame).toContain("0.5× ━━━●─────── 2.0×   1.0×");
    t.mockInput.pressArrow("right");
    await t.settle();
    expect(t.app.config.voices.speed).toBe(1.1);
    frame = await t.press("2");
    expect(frame).toContain("SETTINGS  /  READING");
    expect(frame).toContain("Read new answers automatically");
    await t.press("\r");
    expect(t.app.config.reading.autoRead).toBe(true);
  });

  test("settings tabs are clickable and keep reading preferences separate from audio", async () => {
    const t = await start();
    await t.press(",");
    const tabs = t.renderer.root.findDescendantById("settings-tabs") as
      | TextRenderable
      | undefined;
    expect(tabs).toBeDefined();
    await t.mockMouse.click(tabs!.x + 14, tabs!.y);
    const frame = await t.settle();
    expect(frame).toContain("SETTINGS  /  READING");
    expect(frame).toContain("Read new answers automatically");
  });

  test("voice picker shows installed state and installs with progress", async () => {
    const t = await start();
    await t.press(",", "j", "j", "j", "j", "\r");
    let frame = await t.settle();
    expect(frame).toContain("Voice · Brazilian Portuguese");
    expect(frame).toContain("○ Cadu (pt-BR)");
    expect(frame).toContain("not installed · 63 MB · CC0");
    expect(frame).not.toContain("Heart (US English)");
    await t.press("j", "j", "\r");
    expect(t.app.config.voices.languages["pt-BR"]).toBe(
      "piper:pt_BR-cadu-medium",
    );
    expect(await t.settle()).toContain("press i to install");
    await t.press("i");
    expect(
      await t.waitForFrame((f) =>
        f.includes("Installing piper:pt_BR-cadu-medium… 50% of 63 MB"),
      ),
    ).toContain("50%");
    t.app.engine.finishInstall();
    frame = await t.waitForFrame((f) => f.includes("● Cadu (pt-BR)"));
    expect(t.app.engine.installs).toEqual(["piper:pt_BR-cadu-medium"]);
    expect(frame).toContain("● Cadu (pt-BR)");
  });

  test("keymap editor rebinds a command, reports the conflict, and rebinds live", async () => {
    const t = await start();
    await t.press(",", "4", "\r");
    let frame = await t.settle();
    expect(frame).toContain("─ Key bindings ─");
    expect(frame).toContain("stop · s");
    await t.press("j", "\r"); // "Stop"
    expect(await t.settle()).toContain('Press the new key for "Stop"');
    frame = await t.press("l");
    expect(frame).toContain('Bind l to "Stop"?');
    expect(frame).toContain("⚠ l is already bound to: next-sentence");
    frame = await t.press("\r");
    expect(t.app.config.keys.stop).toEqual(["l"]);
    expect(frame).toContain("Saved: stop → l");
    expect(frame).toContain("stop · l · l also: next-sentence");

    await t.escape();
    await t.escape();
    t.app.commands.ran.length = 0;
    await t.press("s");
    expect(t.app.commands.ran).not.toContain("stop");
  });

  test("esc cancels a captured key without saving", async () => {
    const t = await start();
    await t.press(",", "4", "\r", "\r"); // Key bindings → Play / pause
    await t.press("x");
    await t.escape();
    expect(t.app.configUpdates).toHaveLength(0);
    expect(t.captureCharFrame()).toContain("Rebind cancelled");
  });
});

describe("keymap and lifecycle", () => {
  test("conflicting keys from config are reported on startup", async () => {
    const config = fakeConfig();
    config.keys.stop = ["l"];
    const t = await start(new FakeApp({ config }));
    expect(t.captureCharFrame()).toContain(
      "Key conflicts: l → stop & next-sentence",
    );
  });

  test("leader sequences dispatch commands", async () => {
    const config = fakeConfig();
    config.keys["study-mode"] = ["<leader>s"];
    const t = await start(new FakeApp({ config }));
    await t.press("\\", "s");
    expect(t.app.playback.state.studyMode).toBe(true);
    expect(t.app.commands.ran).not.toContain("stop");
  });

  test("UI commands are registered in the app registry and removed on quit", async () => {
    const t = await start();
    for (const id of [
      "switch-session",
      "messages",
      "phrases",
      "command-palette",
      "settings",
      "help",
      "quit",
    ]) {
      expect(t.app.commands.get(id)?.group).toBe("app");
    }
    await t.press("q");
    await t.done;
    expect(t.app.commands.get("quit")).toBeUndefined();
  });

  test("quit resolves runTui and restores the renderer", async () => {
    const t = await start();
    t.mockInput.pressKey("q");
    await t.done;
    expect(t.renderer.isDestroyed).toBe(true);
  });
});
