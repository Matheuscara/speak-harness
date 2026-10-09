import { expect, test } from "bun:test";
import { DEFAULT_VOICES, parseCliArgs, UsageError } from "../../src/cli/main.ts";

test("parses every mode", () => {
  expect(parseCliArgs([])).toEqual({ kind: "tui" });
  expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
  expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
  expect(parseCliArgs(["run", "--", "omp", "--resume"])).toEqual({ kind: "run", command: ["omp", "--resume"] });
  expect(parseCliArgs(["say", "answer.md"])).toEqual({ kind: "say", source: "answer.md" });
  expect(parseCliArgs(["say", "-"])).toEqual({ kind: "say", source: "-" });
  expect(parseCliArgs(["say"])).toEqual({ kind: "say", source: undefined });
  expect(parseCliArgs(["follow"])).toEqual({ kind: "follow" });
  expect(parseCliArgs(["ctl", "speed-up"])).toEqual({ kind: "ctl", command: "speed-up", args: [] });
  expect(parseCliArgs(["voices"])).toEqual({ kind: "voices-list" });
  expect(parseCliArgs(["voices", "list"])).toEqual({ kind: "voices-list" });
  expect(parseCliArgs(["voices", "install", "piper:pt_BR-faber-medium"])).toEqual({
    kind: "voices-install",
    voice: "piper:pt_BR-faber-medium",
  });
  expect(parseCliArgs(["setup"])).toEqual({ kind: "setup" });
});

test("rejects incomplete or unknown invocations", () => {
  expect(() => parseCliArgs(["run", "--"])).toThrow(UsageError);
  expect(() => parseCliArgs(["ctl"])).toThrow(UsageError);
  expect(() => parseCliArgs(["voices", "install"])).toThrow(UsageError);
  expect(() => parseCliArgs(["dance"])).toThrow('unknown command "dance"');
});

test("default voices are the three voices of the default config", () => {
  expect([...DEFAULT_VOICES].sort()).toEqual(["kokoro:af_heart", "kokoro:pf_dora", "piper:pt_BR-faber-medium"]);
});
