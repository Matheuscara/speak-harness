import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendControlCommand } from "../../src/control/client.ts";
import { startControlServer } from "../../src/control/server.ts";
import { createCommandRegistry } from "../../src/core/commands.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "speakh-ctl-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("runs commands over the socket and reports failures", async () => {
  const registry = createCommandRegistry();
  const received: string[][] = [];
  registry.register({ id: "replay-message", title: "Replay", group: "playback", run: (args) => void received.push(args) });
  registry.register({
    id: "save-phrase",
    title: "Save",
    group: "study",
    run: () => {
      throw new Error("Nothing is being read.");
    },
  });
  const server = await startControlServer(registry, { dir });
  try {
    expect(server.path).toBe(join(dir, `${process.pid}.sock`));
    expect((await stat(server.path)).mode & 0o777).toBe(0o600);
    expect(await readlink(join(dir, "current"))).toBe(`${process.pid}.sock`);

    await sendControlCommand("replay-message", ["fast"], { dir });
    await sendControlCommand("replay-message", [], { dir });
    expect(received).toEqual([["fast"], []]);

    await expect(sendControlCommand("save-phrase", [], { dir })).rejects.toThrow("Nothing is being read.");
    await expect(sendControlCommand("dance", [], { dir })).rejects.toThrow('Unknown command "dance"');
  } finally {
    await server.close();
  }
  expect(existsSync(server.path)).toBe(false);
  expect(existsSync(join(dir, "current"))).toBe(false);
});

test("removes sockets left by dead processes", async () => {
  // PID 2^22 + 1 is above Linux's pid_max, so no live process can own it.
  const stale = join(dir, `${2 ** 22 + 1}.sock`);
  await writeFile(stale, "");
  const server = await startControlServer(createCommandRegistry(), { dir });
  try {
    expect(existsSync(stale)).toBe(false);
  } finally {
    await server.close();
  }
});

test("client explains when no instance is running", async () => {
  await expect(sendControlCommand("stop", [], { dir })).rejects.toThrow("No running speakh instance");
});
