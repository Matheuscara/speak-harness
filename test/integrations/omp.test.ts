import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installOmpExtension, OMP_EXTENSION_FILE } from "../../src/cli/main.ts";
import { startControlServer } from "../../src/control/server.ts";
import { createCommandRegistry } from "../../src/core/commands.ts";
import type * as OmpExtension from "../../src/integrations/omp.js";
import type { OmpSessionStopEvent } from "../../src/integrations/omp.js";
import {
  createStopHandler,
  sendControlRequest,
} from "../../src/integrations/omp.js";

const SOURCE = new URL("../../src/integrations/omp.js", import.meta.url);

let dir: string;
let savedRuntimeDir: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "speakh-omp-"));
  savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
});
afterEach(async () => {
  if (savedRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
  await rm(dir, { recursive: true, force: true });
});

function stopEvent(
  overrides: Partial<OmpSessionStopEvent> = {},
): OmpSessionStopEvent {
  return {
    session_id: "s1",
    turn_id: 0,
    stop_hook_active: false,
    signal: new AbortController().signal,
    last_assistant_message: {
      role: "assistant",
      stopReason: "stop",
      timestamp: 1700,
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "# Done\n\nAll tests pass." },
        {
          type: "toolCall",
          id: "t1",
          name: "bash",
          arguments: { command: "ls" },
        },
        { type: "text", text: "Next step." },
      ],
    },
    ...overrides,
  };
}

test("installs a copy, is idempotent, updates its own file and refuses foreign ones", async () => {
  const agentDir = join(dir, "agent");
  const target = join(agentDir, "extensions", OMP_EXTENSION_FILE);
  const source = await readFile(SOURCE, "utf8");

  expect(await installOmpExtension(agentDir)).toEqual({
    path: target,
    status: "installed",
  });
  expect(await readFile(target, "utf8")).toBe(source);
  expect(await installOmpExtension(agentDir)).toEqual({
    path: target,
    status: "unchanged",
  });

  await writeFile(
    target,
    source.replace("TIMEOUT_MS = 2_500", "TIMEOUT_MS = 9_000"),
  );
  expect(await installOmpExtension(agentDir)).toEqual({
    path: target,
    status: "updated",
  });
  expect(await readFile(target, "utf8")).toBe(source);

  await writeFile(target, "export default () => {};\n");
  await expect(installOmpExtension(agentDir)).rejects.toThrow(
    "is not the SpeakHarness extension",
  );
  expect(await readFile(target, "utf8")).toBe("export default () => {};\n");
});

test("the installed extension hands only final reply text to the running speakh, once per reply", async () => {
  const agentDir = join(dir, "agent");
  const { path } = await installOmpExtension(agentDir);
  process.env.XDG_RUNTIME_DIR = dir;

  const received: string[][] = [];
  const registry = createCommandRegistry();
  registry.register({
    id: "speak-text",
    title: "Speak text",
    group: "playback",
    run: (args) => void received.push(args),
  });
  const server = await startControlServer(registry, {
    dir: join(dir, "speak-harness"),
  });
  try {
    // Loaded from the installed copy, as OMP does: it must not depend on the SpeakHarness tree. Dynamic on purpose:
    // the installed path is only known at run time.
    const extension = (await import(path)) as typeof OmpExtension;
    const handlers = new Map<
      string,
      (event: OmpSessionStopEvent) => Promise<unknown>
    >();
    extension.default({
      on: (name, handler) => void handlers.set(name, handler),
    });
    expect([...handlers.keys()]).toEqual(["session_stop"]);
    const onStop = handlers.get("session_stop")!;

    expect(await onStop(stopEvent())).toBeUndefined();
    expect(received).toEqual([
      ["omp:s1:0:1700", "# Done\n\nAll tests pass.\n\nNext step.", "s1"],
    ]);

    // Not speakable: a hook-requested continuation, a failed or aborted reply, a reply that is only a tool call.
    await onStop(stopEvent({ stop_hook_active: true }));
    for (const stopReason of ["error", "aborted"]) {
      await onStop(
        stopEvent({
          last_assistant_message: {
            ...stopEvent().last_assistant_message!,
            stopReason,
          },
        }),
      );
    }
    await onStop(
      stopEvent({
        last_assistant_message: {
          role: "assistant",
          timestamp: 1,
          content: [{ type: "toolCall", id: "t", name: "x" }],
        },
      }),
    );
    expect(received).toHaveLength(1);

    // OMP restarts turn_id on every prompt; the next prompt's reply still gets its own id.
    await onStop(
      stopEvent({
        last_assistant_message: {
          role: "assistant",
          timestamp: 1800,
          content: [{ type: "text", text: "Second." }],
        },
      }),
    );
    expect(received[1]).toEqual(["omp:s1:0:1800", "Second.", "s1"]);
  } finally {
    await server.close();
  }
});

test("an absent, silent or aborted speakh never blocks the chat or leaks the reply", async () => {
  const logs: string[] = [];
  const handler = createStopHandler({
    path: join(dir, "missing.sock"),
    log: (line) => logs.push(line),
  });
  await handler(stopEvent());
  expect(logs).toHaveLength(1);
  expect(logs[0]).not.toContain("All tests pass");

  const silentPath = join(dir, "silent.sock");
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(silentPath, resolve));
  try {
    const started = performance.now();
    expect(
      await sendControlRequest("speak-text", ["id", "text", "s1"], {
        path: silentPath,
        timeoutMs: 100,
      }),
    ).toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(performance.now() - started).toBeLessThan(1_000);

    const abort = new AbortController();
    const pending = sendControlRequest("speak-text", ["id", "text", "s1"], {
      path: silentPath,
      signal: abort.signal,
    });
    abort.abort();
    expect(await pending).toEqual({ ok: false, reason: "aborted" });
  } finally {
    silent.close();
  }
});

test("a refusal from speakh is reported without the reply text", async () => {
  const registry = createCommandRegistry();
  await mkdir(join(dir, "rt"), { recursive: true });
  const server = await startControlServer(registry, { dir: join(dir, "rt") });
  try {
    const logs: string[] = [];
    await createStopHandler({
      path: join(dir, "rt", "current"),
      log: (line) => logs.push(line),
    })(stopEvent());
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("All tests pass");
  } finally {
    await server.close();
  }
});
