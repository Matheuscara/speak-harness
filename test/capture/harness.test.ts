import { describe, expect, test } from "bun:test";
import { recognizeHarness } from "../../src/capture/harness.ts";

describe("recognizeHarness", () => {
  const cases: Array<[string[], string | undefined]> = [
    [["omp"], "omp"],
    [["pi", "--continue"], "pi"],
    [["/home/me/.nix-profile/bin/codex", "resume"], "codex"],
    [["claude", "--model", "opus"], "claude-code"],
    [["bunx", "@oh-my-pi/pi-coding-agent"], "omp"],
    [["bunx", "--bun", "@oh-my-pi/pi-coding-agent@18.8.4"], "omp"],
    [["npx", "-y", "@openai/codex@latest"], "codex"],
    [["npx", "-p", "@anthropic-ai/claude-code", "claude"], "claude-code"],
    [["npx", "--package=@openai/codex", "--", "codex", "exec"], "codex"],
    [["npx", "codex"], "codex"],
    [["bun", "x", "@mariozechner/pi-coding-agent"], "pi"],
    [["pnpm", "dlx", "@anthropic-ai/claude-code"], "claude-code"],
    [["yarn", "dlx", "@openai/codex"], "codex"],
    [["npm", "exec", "--", "@openai/codex"], "codex"],
    [["env", "FOO=1", "-u", "BAR", "claude", "--resume"], "claude-code"],
    [["bash"], undefined],
    [["bash", "-c", "omp"], undefined],
    [["bunx", "cowsay", "omp"], undefined],
    [["npx", "@someone/codex"], undefined],
    [["bun", "run", "codex"], undefined],
    [["codex-helper"], undefined],
    [[], undefined],
  ];
  for (const [command, expected] of cases) {
    test(`${command.join(" ") || "(empty)"} → ${expected ?? "capture"}`, () => {
      expect(recognizeHarness(command)).toBe(expected as never);
    });
  }
});
