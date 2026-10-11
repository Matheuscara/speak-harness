import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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

// `<pid>.sock` files, a `current` symlink and mode bits: the POSIX endpoint.
const posixOnly = test.skipIf(process.platform === "win32");

posixOnly("runs commands over the socket and reports failures", async () => {
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

posixOnly("removes sockets left by dead processes", async () => {
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

posixOnly("client explains when no instance is running", async () => {
  await expect(sendControlCommand("stop", [], { dir })).rejects.toThrow("No running speakh instance");
});

posixOnly("when one instance exits, ctl reaches another one that is still running", async () => {
  const serverModule = join(import.meta.dir, "../../src/control/server.ts");
  const commandsModule = join(import.meta.dir, "../../src/core/commands.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { startControlServer } = await import(${JSON.stringify(serverModule)});
       const { createCommandRegistry } = await import(${JSON.stringify(commandsModule)});
       const registry = createCommandRegistry();
       registry.register({ id: "replay-message", title: "Replay", group: "playback", run() {} });
       await startControlServer(registry, { dir: ${JSON.stringify(dir)} });
       console.log("ready");`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    // This process starts later, takes `current`, then exits.
    const server = await startControlServer(createCommandRegistry(), { dir });
    await server.close();
    await sendControlCommand("replay-message", [], { dir });
  } finally {
    child.kill();
    await child.exited;
  }
});

describe("per-user pipe (the Windows endpoint)", () => {
  // A real named pipe on Windows; elsewhere a socket file exercises the same single-endpoint logic.
  const newPipe = () => (process.platform === "win32" ? `\\\\.\\pipe\\speakh-test-${randomUUID()}` : join(dir, "control.pipe"));
  const reached: string[] = [];
  const instance = (name: string) => {
    const registry = createCommandRegistry();
    registry.register({ id: "replay-message", title: "Replay", group: "playback", run: () => void reached.push(name) });
    return registry;
  };
  beforeEach(() => {
    reached.length = 0;
  });

  test("a later instance stands by and takes the pipe over when the holder exits", async () => {
    const pipe = newPipe();
    const first = await startControlServer(instance("first"), { pipe });
    const second = await startControlServer(instance("second"), { pipe });
    try {
      expect([first.path, second.path]).toEqual([pipe, pipe]);
      expect(await first.serving).toBe(true);
      await sendControlCommand("replay-message", [], { pipe });
      expect(reached).toEqual(["first"]);

      await first.close();
      expect(await second.serving).toBe(true);
      await sendControlCommand("replay-message", [], { pipe });
      expect(reached).toEqual(["first", "second"]);
    } finally {
      await first.close();
      await second.close();
    }
    await expect(sendControlCommand("replay-message", [], { pipe })).rejects.toThrow(
      `No running speakh instance (control pipe ${pipe} is not served)`,
    );
  });

  test("a closed standby instance never takes the pipe", async () => {
    const pipe = newPipe();
    const first = await startControlServer(instance("first"), { pipe });
    const second = await startControlServer(instance("second"), { pipe });
    await second.close();
    expect(await second.serving).toBe(false);
    await first.close();
    await expect(sendControlCommand("replay-message", [], { pipe })).rejects.toThrow("No running speakh instance");
    expect(reached).toEqual([]);
  });

  // Only a real named pipe vanishes with its crashed holder; a socket file would stay behind.
  test.if(process.platform === "win32")("a standby instance takes over from a holder that crashed", async () => {
    const pipe = newPipe();
    const serverModule = join(import.meta.dir, "../../src/control/server.ts");
    const commandsModule = join(import.meta.dir, "../../src/core/commands.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { startControlServer } = await import(${JSON.stringify(serverModule)});
         const { createCommandRegistry } = await import(${JSON.stringify(commandsModule)});
         await startControlServer(createCommandRegistry(), { pipe: ${JSON.stringify(pipe)} });
         console.log("ready");`,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      const standby = await startControlServer(instance("standby"), { pipe });
      try {
        child.kill("SIGKILL");
        expect(await standby.serving).toBe(true);
        await sendControlCommand("replay-message", [], { pipe });
        expect(reached).toEqual(["standby"]);
      } finally {
        await standby.close();
      }
    } finally {
      child.kill();
      await child.exited;
    }
  });
});
