import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClaudeCodeAdapter } from "../../src/adapters/claude-code.ts";
import type { HarnessAdapter, SessionRef } from "../../src/core/types.ts";
import { collect, fixtureHome, removeHome, setMtime, waitFor } from "./helpers.ts";

const ID = "c4038643-7404-4d28-ab77-000000000001";
const FILE = `.claude/projects/-work-demo/${ID}.jsonl`;
const OTHER = ".claude/projects/-other/c4038643-7404-4d28-ab77-000000000002.jsonl";

let home: string;
let controller: AbortController;

beforeEach(async () => {
  home = await fixtureHome();
  controller = new AbortController();
  await setMtime(join(home, FILE), "2026-09-30T11:24:02Z");
  await setMtime(join(home, OTHER), "2026-09-29T10:00:01Z");
});

afterEach(async () => {
  controller.abort();
  await removeHome(home);
});

function assistantLine(messageId: string, block: Record<string, unknown>, timestamp = "2026-09-30T11:30:00.000Z"): string {
  return `${JSON.stringify({
    type: "assistant",
    isSidechain: false,
    uuid: crypto.randomUUID(),
    timestamp,
    cwd: "/work/demo",
    sessionId: ID,
    message: { id: messageId, type: "message", role: "assistant", content: [block] },
  })}\n`;
}

const systemLine = `${JSON.stringify({ type: "system", subtype: "turn_duration", timestamp: "2026-09-30T11:30:05.000Z", sessionId: ID })}\n`;

async function demoSession(adapter: HarnessAdapter): Promise<SessionRef> {
  const [session] = await adapter.sessions({ cwd: "/work/demo" });
  if (!session) throw new Error("fixture session missing");
  return session;
}

describe("claude-code adapter", () => {
  test("lists sessions by cwd with the file name as id, the latest ai-title, else the first prompt", async () => {
    const adapter = createClaudeCodeAdapter(home);
    const all = await adapter.sessions({});
    expect(all.map((session) => [session.id, session.cwd, session.title])).toEqual([
      [ID, "/work/demo", "Explaining tests"],
      ["c4038643-7404-4d28-ab77-000000000002", "/other", "Hi"],
    ]);
    expect(all.map((session) => session.hasReadableAnswer)).toEqual([true, true]);
    expect((await adapter.sessions({ cwd: "/other" })).map((session) => session.id)).toEqual(["c4038643-7404-4d28-ab77-000000000002"]);
  });

  test("marks a complete transcript with no assistant text as empty", async () => {
    const path = join(home, ".claude/projects/-other/empty.jsonl");
    await writeFile(path, `${JSON.stringify({
      type: "user",
      cwd: "/other",
      sessionId: "empty",
      timestamp: "2026-09-01T10:00:00Z",
      message: { role: "user", content: "Please check this." },
    })}\n`);
    const adapter = createClaudeCodeAdapter(home);
    const empty = (await adapter.sessions({})).find((session) => session.id === "empty");
    expect(empty?.hasReadableAnswer).toBe(false);
  });

  test("merges lines sharing message.id and drops thinking, tools, sidechains and API errors", async () => {
    const adapter = createClaudeCodeAdapter(home, { pollMs: 20 });
    const { items } = collect(adapter.watch(await demoSession(adapter), controller.signal));
    await waitFor(() => items.length === 3);
    expect(items.map((message) => [message.key, message.markdown, message.commentary])).toEqual([
      [`claude-code:${ID}:msg_011CMULTI0000000000001`, "Tests run with `bun test`.\n\nFixtures live under `test/fixtures`.", false],
      [`claude-code:${ID}:msg_011CTOOLS0000000000002`, "Let me look at the files.", true],
      [`claude-code:${ID}:msg_011CFINAL0000000000004`, "There are two test files.", false],
    ]);
    expect(items.every((message) => message.historical)).toBe(true);
    expect(items[0]?.createdAt.toISOString()).toBe("2026-09-30T11:22:42.482Z");
  });

  test("emits a live answer once the next non-answer line closes it", async () => {
    const adapter = createClaudeCodeAdapter(home, { pollMs: 20, settleMs: 60_000 });
    const { items } = collect(adapter.watch(await demoSession(adapter), controller.signal));
    await waitFor(() => items.length === 3);
    await appendFile(
      join(home, FILE),
      assistantLine("msg_live", { type: "thinking", thinking: "", signature: "s" }) +
        assistantLine("msg_live", { type: "text", text: "Part one." }) +
        assistantLine("msg_live", { type: "tool_use", id: "toolu_9", name: "Bash", input: {} }) +
        assistantLine("msg_live", { type: "text", text: "Part two." }) +
        systemLine,
    );
    await waitFor(() => items.length === 4);
    expect(items[3]).toMatchObject({
      key: `claude-code:${ID}:msg_live`,
      markdown: "Part one.\n\nPart two.",
      historical: false,
      commentary: true,
    });
  });

  test("flushes a quiet answer and re-sends it under the same key when a late block arrives", async () => {
    const adapter = createClaudeCodeAdapter(home, { pollMs: 20, settleMs: 50 });
    const { items } = collect(adapter.watch(await demoSession(adapter), controller.signal));
    await waitFor(() => items.length === 3);
    await appendFile(join(home, FILE), assistantLine("msg_late", { type: "text", text: "First block." }));
    await waitFor(() => items.length === 4);
    expect(items[3]?.markdown).toBe("First block.");

    await appendFile(join(home, FILE), assistantLine("msg_late", { type: "text", text: "Second block." }) + systemLine);
    await waitFor(() => items.length === 5);
    expect(items[4]).toMatchObject({ key: items[3]?.key, markdown: "First block.\n\nSecond block.", commentary: false });
  });

  test("re-sends a flushed answer as commentary when its tool_use block arrives late", async () => {
    const adapter = createClaudeCodeAdapter(home, { pollMs: 20, settleMs: 50 });
    const { items } = collect(adapter.watch(await demoSession(adapter), controller.signal));
    await waitFor(() => items.length === 3);
    await appendFile(join(home, FILE), assistantLine("msg_tool", { type: "text", text: "Running it." }));
    await waitFor(() => items.length === 4);
    expect(items[3]?.commentary).toBe(false);

    await appendFile(join(home, FILE), assistantLine("msg_tool", { type: "tool_use", id: "toolu_7", name: "Bash", input: {} }) + systemLine);
    await waitFor(() => items.length === 5);
    expect(items[4]).toMatchObject({ key: items[3]?.key, markdown: "Running it.", commentary: true });
  });
});
