import { expect, test } from "bun:test";
import { createCommandRegistry } from "../../src/core/commands.ts";
import type { Command } from "../../src/core/types.ts";

const command = (run: Command["run"]): Command => ({ id: "stop", title: "Stop", group: "playback", run });

test("runs registered commands with their arguments", async () => {
  const registry = createCommandRegistry();
  const seen: string[][] = [];
  registry.register(command((args) => void seen.push(args)));
  await registry.run("stop", ["now"]);
  await registry.run("stop");
  expect(seen).toEqual([["now"], []]);
  expect(registry.list().map((c) => c.id)).toEqual(["stop"]);
});

test("rejects duplicate ids and unknown commands", async () => {
  const registry = createCommandRegistry();
  const unregister = registry.register(command(() => {}));
  expect(() => registry.register(command(() => {}))).toThrow('Command "stop" is already registered');
  await expect(registry.run("nope")).rejects.toThrow('Unknown command "nope"');
  unregister();
  expect(registry.get("stop")).toBeUndefined();
  registry.register(command(() => {}));
});
