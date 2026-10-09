import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createCodexAdapter } from "../../src/adapters/codex.ts";
import { collect, fixtureHome, removeHome, setMtime, waitFor } from "./helpers.ts";

const ID = "01a10341-9e49-7821-bc1f-000000000001";
const FILE = `.codex/sessions/2026/10/03/rollout-2026-10-03T16-33-14-${ID}.jsonl`;
const OTHER = ".codex/sessions/2026/10/04/rollout-2026-10-04T08-00-00-01a10341-9e49-7821-bc1f-000000000002.jsonl";

let home: string;
let controller: AbortController;

beforeEach(async () => {
  home = await fixtureHome();
  controller = new AbortController();
  await setMtime(join(home, FILE), "2026-10-03T19:40:00Z");
  await setMtime(join(home, OTHER), "2026-10-04T11:00:05Z");
});

afterEach(async () => {
  controller.abort();
  await removeHome(home);
});

describe("codex adapter", () => {
  test("finds rollouts under the dated tree and reads cwd from session_meta", async () => {
    const adapter = createCodexAdapter(home);
    const all = await adapter.sessions({});
    expect(all.map((session) => [session.id, session.cwd])).toEqual([
      ["01a10341-9e49-7821-bc1f-000000000002", "/other"],
      [ID, "/work/demo"],
    ]);
    const demo = await adapter.sessions({ cwd: "/work/demo" });
    expect(demo.map((session) => session.path)).toEqual([join(home, FILE)]);
  });

  test("yields assistant output_text only, then appended answers live", async () => {
    const adapter = createCodexAdapter(home, { pollMs: 20 });
    const [session] = await adapter.sessions({ cwd: "/work/demo" });
    if (!session) throw new Error("fixture session missing");
    const { items } = collect(adapter.watch(session, controller.signal));
    await waitFor(() => items.length === 2);
    expect(items.map((message) => [message.key, message.markdown, message.historical, message.commentary])).toEqual([
      [`codex:${ID}:msg_asst_1`, "I will list the files.", true, true],
      [`codex:${ID}:msg_asst_2`, "There are **three** files.", true, false],
    ]);

    const line = {
      timestamp: "2026-10-03T19:34:00.000Z",
      ordinal: 15,
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }], phase: "final_answer" },
    };
    await appendFile(join(home, FILE), `${JSON.stringify(line)}\n`);
    await waitFor(() => items.length === 3);
    expect(items[2]).toMatchObject({ key: `codex:${ID}:ordinal-15`, markdown: "Done.", historical: false, commentary: false });
    expect(items[2]?.createdAt.toISOString()).toBe("2026-10-03T19:34:00.000Z");
  });
});
