import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClaudeCodeAdapter } from "../../src/adapters/claude-code.ts";
import { createCodexAdapter } from "../../src/adapters/codex.ts";
import { createOmpAdapter, createPiAdapter } from "../../src/adapters/omp.ts";
import type { HarnessAdapter } from "../../src/core/types.ts";
import { collect, fixtureHome, removeHome, waitFor } from "./helpers.ts";

interface Case {
  name: string;
  create: (home: string) => HarnessAdapter;
  file: string;
  historical: number;
  /** Lines kept when the transcript is rewritten shorter (must include at least one known answer). */
  keep: number;
  answer: Record<string, unknown>;
}

const opts = { pollMs: 20, settleMs: 60_000 };
const ompAnswer = {
  type: "message",
  id: "fresh001",
  message: { role: "assistant", content: [{ type: "text", text: "After restart." }] },
};

const cases: Case[] = [
  {
    name: "omp",
    create: (home) => createOmpAdapter(home, opts),
    file: ".omp/agent/sessions/-work-demo/2026-10-02T10-00-00-000Z_01a11ba3-0000-7000-8000-000000000002.jsonl",
    historical: 3,
    keep: 9,
    answer: ompAnswer,
  },
  {
    name: "pi",
    create: (home) => createPiAdapter(home, opts),
    file: ".pi/agent/sessions/--work-demo--/2026-08-31T19-18-54-761Z_01a05942-0000-70d1-a01a-000000000001.jsonl",
    historical: 1,
    keep: 6,
    answer: ompAnswer,
  },
  {
    name: "codex",
    create: (home) => createCodexAdapter(home, opts),
    file: ".codex/sessions/2026/10/03/rollout-2026-10-03T16-33-14-01a10341-9e49-7821-bc1f-000000000001.jsonl",
    historical: 2,
    keep: 7,
    answer: {
      timestamp: "2026-10-05T00:00:00.000Z",
      type: "response_item",
      payload: { type: "message", id: "fresh001", role: "assistant", content: [{ type: "output_text", text: "After restart." }] },
    },
  },
  {
    name: "claude-code",
    create: (home) => createClaudeCodeAdapter(home, opts),
    file: ".claude/projects/-work-demo/c4038643-7404-4d28-ab77-000000000001.jsonl",
    historical: 3,
    keep: 10,
    answer: {
      type: "assistant",
      timestamp: "2026-10-05T00:00:00.000Z",
      message: { id: "fresh001", role: "assistant", content: [{ type: "text", text: "After restart." }] },
    },
  },
];

let home: string;
let controller: AbortController;

beforeEach(async () => {
  home = await fixtureHome();
  controller = new AbortController();
});

afterEach(async () => {
  controller.abort();
  await removeHome(home);
});

describe("truncation restart", () => {
  for (const testCase of cases) {
    test(`${testCase.name}: re-reads a truncated transcript without repeating known answers`, async () => {
      const adapter = testCase.create(home);
      const path = join(home, testCase.file);
      const session = (await adapter.sessions({})).find((candidate) => candidate.path === path);
      if (!session) throw new Error("fixture session missing");
      const { items } = collect(adapter.watch(session, controller.signal));
      await waitFor(() => items.length === testCase.historical);

      const original = await readFile(path, "utf8");
      const kept = original.split("\n").slice(0, testCase.keep).join("\n");
      const closer = testCase.name === "claude-code" ? `${JSON.stringify({ type: "last-prompt" })}\n` : "";
      const rewritten = `${kept}\n${JSON.stringify(testCase.answer)}\n${closer}`;
      // Truncation is detected by size, so the rewrite must be shorter than what was already read.
      expect(rewritten.length).toBeLessThan(original.length);
      await writeFile(path, rewritten);

      await waitFor(() => items.length === testCase.historical + 1);
      expect(items.at(-1)).toMatchObject({ markdown: "After restart.", historical: false });
      expect(items.at(-1)?.key).toEndWith(":fresh001");
      expect(new Set(items.map((message) => message.key)).size).toBe(items.length);
    });
  }
});
