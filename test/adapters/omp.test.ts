import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createOmpAdapter, createPiAdapter } from "../../src/adapters/omp.ts";
import type { HarnessMessage } from "../../src/core/types.ts";
import { collect, FIXTURES, fixtureHome, removeHome, setMtime, waitFor } from "./helpers.ts";

const SESSIONS = ".omp/agent/sessions";
const NEW_ID = "01a11ba3-0000-7000-8000-000000000002";
const OLD_ID = "01a11ba3-0000-7000-8000-000000000001";
const NEW_FILE = `${SESSIONS}/-work-demo/2026-10-02T10-00-00-000Z_${NEW_ID}.jsonl`;
const OLD_FILE = `${SESSIONS}/-work-demo/2026-10-01T09-00-00-000Z_${OLD_ID}.jsonl`;
const OTHER_FILE = `${SESSIONS}/-other/2026-10-03T09-00-00-000Z_01a11ba3-0000-7000-8000-000000000003.jsonl`;

let home: string;
let controller: AbortController;

beforeEach(async () => {
  home = await fixtureHome();
  controller = new AbortController();
  await setMtime(join(home, OLD_FILE), "2026-10-01T09:05:00Z");
  await setMtime(join(home, NEW_FILE), "2026-10-02T10:05:00Z");
  await setMtime(join(home, OTHER_FILE), "2026-10-03T09:05:00Z");
});

afterEach(async () => {
  controller.abort();
  await removeHome(home);
});

const text = (messages: HarnessMessage[]) => messages.map((message) => message.markdown);

describe("omp adapter", () => {
  test("lists sessions newest first with id, title and cwd from the header", async () => {
    const adapter = createOmpAdapter(home);
    const all = await adapter.sessions({});
    expect(all.map((session) => session.id)).toEqual(["01a11ba3-0000-7000-8000-000000000003", NEW_ID, OLD_ID]);

    const demo = await adapter.sessions({ cwd: "/work/demo/" });
    expect(demo.map((session) => [session.id, session.title, session.cwd])).toEqual([
      [NEW_ID, "Demo answers", "/work/demo"],
      [OLD_ID, "Earlier work", "/work/demo"],
    ]);
    expect(demo[0]?.harness).toBe("omp");
    expect(demo[0]?.path).toBe(join(home, NEW_FILE));
    expect(await adapter.sessions({ cwd: "/nowhere" })).toEqual([]);
  });

  test("yields only assistant text as historical messages, then completes a partial line live", async () => {
    const adapter = createOmpAdapter(home, { pollMs: 20 });
    const [session] = await adapter.sessions({ cwd: "/work/demo" });
    if (!session) throw new Error("fixture session missing");
    const { items } = collect(adapter.watch(session, controller.signal));
    await waitFor(() => items.length === 3);
    expect(text(items)).toEqual([
      "Checking the config first.",
      "## Build\n\nThe build has **two** steps.\n\nRun `bun test` after it.",
      "O build tem duas etapas.",
    ]);
    expect(items.map((message) => message.key)).toEqual([
      `omp:${NEW_ID}:a0000007`,
      `omp:${NEW_ID}:a0000009`,
      `omp:${NEW_ID}:a0000015`,
    ]);
    expect(items.every((message) => message.historical && message.final)).toBe(true);
    // Text sent next to a tool call is narration; the rest are answers.
    expect(items.map((message) => message.commentary)).toEqual([true, false, false]);
    expect(items[0]?.createdAt.toISOString()).toBe("2026-10-02T10:00:03.000Z");

    const rest = await readFile(join(FIXTURES, "omp-partial-rest.txt"), "utf8");
    await appendFile(join(home, NEW_FILE), rest);
    await waitFor(() => items.length === 4);
    expect(items[3]).toMatchObject({
      key: `omp:${NEW_ID}:a0000016`,
      markdown: "Answer still being written.",
      historical: false,
    });

    const live = JSON.stringify({
      type: "message",
      id: "a0000017",
      timestamp: "2026-10-02T10:00:10.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "A new answer." }] },
    });
    await appendFile(join(home, NEW_FILE), `${live}\n`);
    await waitFor(() => items.length === 5);
    expect(items[4]).toMatchObject({ markdown: "A new answer.", historical: false });
  });
});

describe("pi adapter", () => {
  test("lists Pi sessions with the latest session_info name and skips empty answers", async () => {
    const adapter = createPiAdapter(home, { pollMs: 20 });
    const sessions = await adapter.sessions({ cwd: "/work/demo" });
    expect(sessions.map((session) => [session.harness, session.id, session.title])).toEqual([
      ["pi", "01a05942-0000-70d1-a01a-000000000001", "Named pi session"],
    ]);
    const [session] = sessions;
    if (!session) throw new Error("fixture session missing");
    const { items } = collect(adapter.watch(session, controller.signal));
    await waitFor(() => items.length === 1);
    expect(items[0]).toMatchObject({
      key: "pi:01a05942-0000-70d1-a01a-000000000001:p0000005",
      markdown: "Pi summary answer.",
      commentary: false,
    });
  });
});
