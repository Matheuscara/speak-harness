import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/core/app.ts";
import { createPhraseStore } from "../../src/core/phrases.ts";
import type { AppCore, AppEvent, Config } from "../../src/core/types.ts";
import { fakeAudio, fakeEngine, fakeSessions, fakeSleep, flush, testConfig } from "./fakes.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "speakh-app-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup(options: { config?: Config; configPath?: string } = {}) {
  const engine = fakeEngine({ auto: true });
  const audio = fakeAudio();
  const sessions = fakeSessions();
  const app = await createApp({
    cwd: dir,
    config: options.config ?? testConfig(),
    configPath: options.configPath,
    engine: engine.engine,
    audio: audio.audio,
    sessions: sessions.service,
    phrases: createPhraseStore(join(dir, "phrases.md")),
    sleep: fakeSleep().sleep,
  });
  const events: AppEvent[] = [];
  app.subscribe((event) => events.push(event));
  /** Finishes every chunk of the answer being read, letting the controller move through its segments. */
  const finishAll = async (): Promise<void> => {
    for (let i = 0; i < 20 && app.playback.state.status !== "idle"; i++) {
      await flush();
      audio.plays.at(-1)?.finish();
      await flush();
    }
  };
  const spokenText = (): string[] => audio.plays.map((play) => engine.textOf.get(play.chunk) ?? "?");
  return { app, engine, audio, sessions, events, finishAll, spokenText };
}

const autoRead = testConfig((c) => {
  c.reading.autoRead = true;
});

describe("auto-read", () => {
  test("a new answer is read when idle; historical answers are not", async () => {
    const env = await setup({ config: autoRead });
    env.sessions.emitMessage("Old answer.", { historical: true });
    await flush();
    expect(env.app.playback.state.status).toBe("idle");

    const message = env.sessions.emitMessage("New answer.");
    await flush();
    expect(env.app.playback.state).toMatchObject({ messageKey: message.key });
    expect(env.app.playback.state.status).not.toBe("idle");
    await env.app.dispose();
  });

  test("while speaking only the newest pending answer is queued by default", async () => {
    const env = await setup({ config: autoRead });
    env.sessions.emitMessage("First answer.");
    env.sessions.emitMessage("Second answer.");
    const third = env.sessions.emitMessage("Third answer.");
    await env.finishAll();
    await flush();
    expect(env.app.playback.state.messageKey).toBe(third.key);
    await env.finishAll();
    expect(env.spokenText()).toEqual(["First answer.", "Third answer."]);
    await env.app.dispose();
  });

  test("queue mode `all` reads every answer in order", async () => {
    const env = await setup({
      config: testConfig((c) => {
        c.reading.autoRead = true;
        c.reading.autoReadQueue = "all";
      }),
    });
    env.sessions.emitMessage("First answer.");
    env.sessions.emitMessage("Second answer.");
    env.sessions.emitMessage("Third answer.");
    for (let i = 0; i < 3; i++) {
      await env.finishAll();
      await flush();
    }
    expect(env.spokenText()).toEqual(["First answer.", "Second answer.", "Third answer."]);
    await env.app.dispose();
  });

  test("stop clears the queue", async () => {
    const env = await setup({ config: autoRead });
    env.sessions.emitMessage("First answer.");
    env.sessions.emitMessage("Second answer.");
    await flush();
    await env.app.commands.run("stop");
    await flush();
    expect(env.app.playback.state.status).toBe("idle");
    expect(env.spokenText()).toEqual(["First answer."]);
    await env.app.dispose();
  });

  test("commentary is never auto-read", async () => {
    const env = await setup({ config: autoRead });
    env.sessions.emitMessage("Let me check the files.", { commentary: true });
    await flush();
    expect(env.app.playback.state.status).toBe("idle");
    await env.app.dispose();
  });

  test("an updated answer is not read twice, and its script follows the new text", async () => {
    const env = await setup({ config: autoRead });
    const message = env.sessions.emitMessage("Short answer.");
    await env.finishAll();
    const updated = env.sessions.updateMessage(message.key, "Short answer. With more detail.");
    await flush();
    expect(env.app.playback.state.status).toBe("idle");
    expect(env.spokenText()).toEqual(["Short answer."]);
    expect(env.app.scriptFor(updated).segments.map((segment) => segment.text)).toEqual(["Short answer.", "With more detail."]);
    await env.app.dispose();
  });

  test("off by default", async () => {
    const env = await setup();
    env.sessions.emitMessage("An answer.");
    await flush();
    expect(env.app.playback.state.status).toBe("idle");
    await env.app.dispose();
  });

  test("the toggle persists to the config file", async () => {
    const configPath = join(dir, "config.toml");
    const env = await setup({ configPath });
    await env.app.commands.run("auto-read");
    expect(env.app.config.reading.autoRead).toBe(true);
    expect(await readFile(configPath, "utf8")).toContain("auto_read = true");
    expect(env.events).toContainEqual({ type: "config", config: env.app.config });
    await env.app.dispose();
  });
});

describe("selection and commands", () => {
  test("default selection and read-latest skip commentary; message stepping does not", async () => {
    const env = await setup();
    const answer = env.sessions.emitMessage("The answer.", { historical: true });
    const narration = env.sessions.emitMessage("Running the tests now.", { historical: true, commentary: true });
    expect(env.app.selectedMessageKey).toBe(answer.key);
    await env.app.commands.run("next-message");
    expect(env.app.selectedMessageKey).toBe(narration.key);
    await env.app.commands.run("read-latest");
    expect(env.app.selectedMessageKey).toBe(answer.key);
    expect(env.app.playback.state.messageKey).toBe(answer.key);
    await env.app.dispose();
  });

  test("selection follows the newest answer until the user picks another", async () => {
    const env = await setup();
    const first = env.sessions.emitMessage("First.", { historical: true });
    const second = env.sessions.emitMessage("Second.", { historical: true });
    expect(env.app.selectedMessageKey).toBe(second.key);
    await env.app.commands.run("prev-message");
    expect(env.app.selectedMessageKey).toBe(first.key);
    env.sessions.emitMessage("Third.");
    expect(env.app.selectedMessageKey).toBe(first.key);
    await env.app.commands.run("read-latest");
    const fourth = env.sessions.emitMessage("Fourth.");
    expect(env.app.selectedMessageKey).toBe(fourth.key);
    expect(env.events).toContainEqual({ type: "selection", messageKey: first.key });
    await env.app.dispose();
  });

  test("play-pause reads the selected answer when idle, then pauses", async () => {
    const env = await setup();
    const message = env.sessions.emitMessage("Hello there. How are you?", { historical: true });
    await env.app.commands.run("play-pause");
    await flush();
    expect(env.app.playback.state).toMatchObject({ status: "speaking", messageKey: message.key });
    await env.app.commands.run("play-pause");
    expect(env.app.playback.state.status).toBe("paused");
    await env.app.dispose();
  });

  test("save-phrase stores the segment being read", async () => {
    const env = await setup();
    const message = env.sessions.emitMessage("Learning by listening works.", { historical: true });
    await env.app.commands.run("play-pause");
    await flush();
    await env.app.commands.run("save-phrase");
    const phrases = await env.app.phrases.list();
    expect(phrases).toHaveLength(1);
    expect(phrases[0]).toMatchObject({ text: "Learning by listening works.", lang: "en", messageKey: message.key });
    await env.app.dispose();
  });

  test("command failures become error notices and still reject", async () => {
    // A regular file where the config directory should be makes saving fail.
    await Bun.write(join(dir, "not-a-dir"), "");
    const env = await setup({ configPath: join(dir, "not-a-dir", "config.toml") });
    await expect(env.app.commands.run("auto-read")).rejects.toThrow();
    await flush();
    expect(env.events.some((event) => event.type === "notice" && event.level === "error")).toBe(true);
    await env.app.dispose();
  });

  test("playback errors are reported as notices", async () => {
    const engine = fakeEngine({ fail: () => new Error("worker crashed") });
    const sessions = fakeSessions();
    const app: AppCore = await createApp({
      cwd: dir,
      config: testConfig(),
      engine: engine.engine,
      audio: fakeAudio({ auto: true }).audio,
      sessions: sessions.service,
      phrases: createPhraseStore(join(dir, "phrases.md")),
    });
    const notices: string[] = [];
    app.subscribe((event) => event.type === "notice" && notices.push(event.text));
    const message = sessions.emitMessage("Hello.", { historical: true });
    app.readMessage(message.key);
    await flush();
    expect(notices).toContain("worker crashed");
    await app.dispose();
  });
});
