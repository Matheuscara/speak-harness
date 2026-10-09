import { afterEach, describe, expect, test } from "bun:test";
import { createSessionService } from "../../src/core/sessions.ts";
import type { HarnessAdapter, HarnessId, HarnessMessage, SessionRef, SessionService, StoreEvent } from "../../src/core/types.ts";
import { waitFor } from "./helpers.ts";

interface FakeAdapter extends HarnessAdapter {
  list: SessionRef[];
  fail?: Error;
  push(sessionId: string, message: Omit<HarnessMessage, "session">): void;
  breakWatch(sessionId: string, error: Error): void;
  /** Session ids whose watch is currently running. */
  watching: Set<string>;
}

function fakeAdapter(id: HarnessId, list: SessionRef[] = []): FakeAdapter {
  const queues = new Map<string, Array<Omit<HarnessMessage, "session"> | Error>>();
  const wakers = new Map<string, () => void>();
  const queue = (sessionId: string) => {
    let items = queues.get(sessionId);
    if (!items) queues.set(sessionId, (items = []));
    return items;
  };
  const adapter: FakeAdapter = {
    id,
    label: id,
    list,
    watching: new Set(),
    async sessions(filter) {
      if (adapter.fail) throw adapter.fail;
      return adapter.list.filter((session) => filter.cwd === undefined || session.cwd === filter.cwd);
    },
    async *watch(session, signal) {
      adapter.watching.add(session.id);
      try {
        const items = queue(session.id);
        while (!signal.aborted) {
          const next = items.shift();
          if (next instanceof Error) throw next;
          if (next) {
            yield { ...next, session };
            continue;
          }
          await new Promise<void>((resolve) => {
            wakers.set(session.id, resolve);
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      } finally {
        adapter.watching.delete(session.id);
      }
    },
    push(sessionId, message) {
      queue(sessionId).push(message);
      wakers.get(sessionId)?.();
    },
    breakWatch(sessionId, error) {
      queue(sessionId).push(error);
      wakers.get(sessionId)?.();
    },
  };
  return adapter;
}

const ref = (harness: HarnessId, id: string, cwd: string, updated: string): SessionRef => ({
  harness,
  id,
  cwd,
  path: `/transcripts/${id}.jsonl`,
  updatedAt: new Date(updated),
});

const msg = (key: string, markdown: string, historical = false): Omit<HarnessMessage, "session"> => ({
  key,
  markdown,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  final: true,
  historical,
  commentary: false,
});

let service: SessionService | undefined;

afterEach(async () => {
  await service?.dispose();
  service = undefined;
});

function track(target: SessionService): StoreEvent[] {
  const events: StoreEvent[] = [];
  target.subscribe((event) => events.push(event));
  return events;
}

describe("session service", () => {
  test("lists sessions from every adapter newest first; a failing adapter only warns, once", async () => {
    const omp = fakeAdapter("omp", [ref("omp", "o1", "/a", "2026-10-01T00:00:00Z")]);
    const codex = fakeAdapter("codex", [ref("codex", "c1", "/a", "2026-10-03T00:00:00Z"), ref("codex", "c2", "/b", "2026-10-04T00:00:00Z")]);
    const claude = fakeAdapter("claude-code");
    claude.fail = new Error("permission denied");
    service = createSessionService([omp, codex, claude]);
    const events = track(service);

    expect((await service.list({})).map((session) => session.id)).toEqual(["c2", "c1", "o1"]);
    expect((await service.list({ cwd: "/a" })).map((session) => session.id)).toEqual(["c1", "o1"]);
    expect(events).toEqual([{ type: "warning", harness: "claude-code", message: "permission denied" }]);
  });

  test("follow streams messages in order and replaces a re-sent key in place", async () => {
    const omp = fakeAdapter("omp", [ref("omp", "o1", "/a", "2026-10-01T00:00:00Z")]);
    service = createSessionService([omp]);
    const events = track(service);
    const [session] = await service.list({});
    if (!session) throw new Error("missing session");

    omp.push("o1", msg("omp:o1:1", "one", true));
    omp.push("o1", msg("omp:o1:2", "two", true));
    await service.follow(session);
    await waitFor(() => service?.messages.length === 2);
    omp.push("o1", msg("omp:o1:3", "three"));
    omp.push("o1", msg("omp:o1:2", "two, grown"));
    await waitFor(() => events.filter((event) => event.type === "message").length === 4);

    expect(service.session?.id).toBe("o1");
    expect(service.messages.map((message) => message.markdown)).toEqual(["one", "two, grown", "three"]);
    expect(events[0]).toEqual({ type: "session", session });
  });

  test("a failing watch becomes a warning and keeps the service usable", async () => {
    const omp = fakeAdapter("omp", [ref("omp", "o1", "/a", "2026-10-01T00:00:00Z")]);
    const pi = fakeAdapter("pi", [ref("pi", "p1", "/a", "2026-10-02T00:00:00Z")]);
    service = createSessionService([omp, pi]);
    const events = track(service);
    const sessions = await service.list({});

    await service.follow(sessions[1] as SessionRef);
    omp.breakWatch("o1", new Error("transcript vanished"));
    await waitFor(() => events.some((event) => event.type === "warning"));
    expect(events).toContainEqual({ type: "warning", harness: "omp", message: "transcript vanished" });

    pi.push("p1", msg("pi:p1:1", "still works"));
    await service.follow(sessions[0] as SessionRef);
    await waitFor(() => service?.messages.length === 1);
    expect(service.messages[0]?.markdown).toBe("still works");
  });

  test("followLatest follows the newest session for cwd and switches when a new one appears", async () => {
    const omp = fakeAdapter("omp", [ref("omp", "old", "/a", "2026-10-01T00:00:00Z"), ref("omp", "elsewhere", "/b", "2026-10-09T00:00:00Z")]);
    const codex = fakeAdapter("codex", [ref("codex", "newer", "/a", "2026-10-02T00:00:00Z")]);
    service = createSessionService([omp, codex], { pollMs: 10 });
    const events = track(service);

    await service.followLatest("/a");
    expect(service.session?.id).toBe("newer");
    expect(codex.watching.has("newer")).toBe(true);
    codex.push("newer", msg("codex:newer:1", "from newer"));
    await waitFor(() => service?.messages.length === 1);

    omp.list.push(ref("omp", "fresh", "/a", "2026-10-05T00:00:00Z"));
    await waitFor(() => service?.session?.id === "fresh");
    expect(service.messages).toEqual([]);
    await waitFor(() => !codex.watching.has("newer"));
    expect(omp.watching.has("fresh")).toBe(true);
    expect(events.filter((event) => event.type === "session").map((event) => event.type === "session" && event.session?.id)).toEqual(["newer", "fresh"]);
  });

  test("followLatest with no session waits for the first one; follow() stops switching", async () => {
    const omp = fakeAdapter("omp");
    service = createSessionService([omp], { pollMs: 10 });

    await service.followLatest("/a");
    expect(service.session).toBeUndefined();
    omp.list.push(ref("omp", "first", "/a", "2026-10-01T00:00:00Z"));
    await waitFor(() => service?.session?.id === "first");

    const chosen = ref("omp", "chosen", "/z", "2026-09-01T00:00:00Z");
    await service.follow(chosen);
    let polls = 0;
    const sessions = omp.sessions;
    omp.sessions = (filter) => {
      polls++;
      return sessions(filter);
    };
    omp.list.push(ref("omp", "later", "/a", "2026-10-02T00:00:00Z"));
    // Negative check against the real poll timer: five intervals pass without any poll.
    await Bun.sleep(50);
    expect(polls).toBe(0);
    expect(service.session?.id).toBe("chosen");
  });

  test("addManual appends numbered manual and capture messages", async () => {
    service = createSessionService([]);
    const events = track(service);
    const first = service.addManual("# Pasted");
    const second = service.addManual("More");
    const captured = service.addManual("From the screen", "capture");

    expect([first.key, second.key, captured.key]).toEqual(["manual:1", "manual:2", "capture:1"]);
    expect(captured.session.harness).toBe("capture");
    expect(first).toMatchObject({ final: true, historical: false, commentary: false, markdown: "# Pasted" });
    expect(captured.commentary).toBe(false);
    expect(service.messages).toEqual([first, second, captured]);
    expect(events).toHaveLength(3);
  });

  test("dispose stops the watch and silences listeners", async () => {
    const omp = fakeAdapter("omp", [ref("omp", "o1", "/a", "2026-10-01T00:00:00Z")]);
    service = createSessionService([omp]);
    const events = track(service);
    await service.follow(omp.list[0] as SessionRef);
    await waitFor(() => omp.watching.has("o1"));
    await service.dispose();
    expect(omp.watching.has("o1")).toBe(false);
    const count = events.length;
    omp.push("o1", msg("omp:o1:1", "late"));
    expect(events).toHaveLength(count);
    service = undefined;
  });
});
