import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailJsonl, type TailEvent } from "../../src/adapters/jsonl-tail.ts";
import { collect, waitFor } from "./helpers.ts";

let dir: string;
let controller: AbortController;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "speakh-tail-"));
  controller = new AbortController();
});

afterEach(async () => {
  controller.abort();
  await rm(dir, { recursive: true, force: true });
});

function start(path: string, settleMs = 5000) {
  return collect<TailEvent>(tailJsonl(path, { signal: controller.signal, pollMs: 20, settleMs }));
}

const values = (events: TailEvent[]) => events.flatMap((event) => (event.type === "record" ? [event.value] : []));
const idles = (events: TailEvent[]) => events.filter((event) => event.type === "idle").length;

describe("tailJsonl", () => {
  test("reads existing lines, skips broken ones, then reports idle once caught up", async () => {
    const path = join(dir, "a.jsonl");
    await writeFile(path, '{"n":1}\nnot json\n\n{"n":2}\n');
    const { items } = start(path);
    await waitFor(() => items.some((event) => event.type === "idle"));
    expect(values(items)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(items.filter((event) => event.type === "record").map((event) => event.type === "record" && event.line)).toEqual([0, 3]);
    expect(items.at(-1)).toEqual({ type: "idle" });
  });

  test("buffers a partial line until its newline arrives", async () => {
    const path = join(dir, "a.jsonl");
    await writeFile(path, '{"n":1}\n{"n":');
    const { items } = start(path);
    await waitFor(() => items.some((event) => event.type === "idle"));
    expect(values(items)).toEqual([{ n: 1 }]);

    await appendFile(path, "2}");
    // Each pass that reads bytes ends with an idle event: wait for the pass that read the fragment.
    await waitFor(() => idles(items) === 2);
    expect(values(items)).toEqual([{ n: 1 }]);

    await appendFile(path, '\n{"n":3}\n');
    await waitFor(() => values(items).length === 3);
    expect(values(items)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test("keeps multi-byte characters split across appends intact", async () => {
    const path = join(dir, "a.jsonl");
    const bytes = new TextEncoder().encode('{"t":"ação"}\n');
    const cut = bytes.indexOf(0xc3) + 1; // inside the two-byte "ç"
    await writeFile(path, bytes.subarray(0, cut));
    const { items } = start(path);
    await waitFor(() => items.some((event) => event.type === "idle"));
    await appendFile(path, bytes.subarray(cut));
    await waitFor(() => values(items).length === 1);
    expect(values(items)).toEqual([{ t: "ação" }]);
  });

  test("restarts from the beginning when the file is truncated", async () => {
    const path = join(dir, "a.jsonl");
    await writeFile(path, '{"n":1}\n{"n":2}\n');
    const { items } = start(path);
    await waitFor(() => values(items).length === 2);
    await truncate(path, 0);
    await appendFile(path, '{"n":9}\n');
    await waitFor(() => values(items).length === 3);
    expect(items).toContainEqual({ type: "reset", reason: "truncated" });
    expect(values(items)).toEqual([{ n: 1 }, { n: 2 }, { n: 9 }]);
  });

  test("restarts when the file is replaced", async () => {
    const path = join(dir, "a.jsonl");
    await writeFile(path, '{"n":1}\n');
    const { items } = start(path);
    await waitFor(() => values(items).length === 1);
    const replacement = join(dir, "b.jsonl");
    await writeFile(replacement, '{"n":1}\n{"n":2}\n{"n":3}\n');
    await rename(replacement, path);
    await waitFor(() => values(items).length === 4);
    expect(items).toContainEqual({ type: "reset", reason: "replaced" });
    expect(values(items)).toEqual([{ n: 1 }, { n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test("waits for a missing file and reports settled after a quiet period", async () => {
    const path = join(dir, "later.jsonl");
    const { items } = start(path, 80);
    await waitFor(() => items.some((event) => event.type === "idle"));
    await writeFile(path, '{"n":1}\n');
    await waitFor(() => items.some((event) => event.type === "settled"));
    expect(values(items)).toEqual([{ n: 1 }]);
    expect(items.filter((event) => event.type === "settled")).toHaveLength(1);
  });

  test("ends when the signal aborts", async () => {
    const path = join(dir, "a.jsonl");
    await writeFile(path, '{"n":1}\n');
    const { items, done } = start(path);
    await waitFor(() => values(items).length === 1);
    controller.abort();
    await done;
    expect(values(items)).toEqual([{ n: 1 }]);
  });
});
