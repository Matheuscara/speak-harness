import type { HarnessAdapter, HarnessId, HarnessMessage, SessionRef, SessionService, StoreEvent } from "./types.ts";

interface ActiveWatch {
  controller: AbortController;
  done: Promise<void>;
}

interface LatestFollow {
  cwd: string;
  /** Sessions already known for `cwd`; only a session not seen before triggers a switch. */
  seen: Set<string>;
  timer: NodeJS.Timeout | undefined;
  stopped: boolean;
}

/**
 * Message store over harness adapters. Following a session streams its assistant answers in transcript order;
 * a message re-delivered with a known key (an answer that grew) replaces the stored one in place.
 */
export function createSessionService(adapters: HarnessAdapter[], options: { pollMs?: number } = {}): SessionService {
  const pollMs = options.pollMs ?? 2000;
  const listeners = new Set<(event: StoreEvent) => void>();
  const lastWarning = new Map<HarnessId, string>();
  const manualCounts: Record<"manual" | "capture", number> = { manual: 0, capture: 0 };
  let session: SessionRef | undefined;
  let messages: HarnessMessage[] = [];
  let indexByKey = new Map<string, number>();
  let active: ActiveWatch | undefined;
  let latest: LatestFollow | undefined;
  let disposed = false;
  // Session switches run one at a time, in call order.
  let switching: Promise<void> = Promise.resolve();

  const sessionKey = (ref: SessionRef) => `${ref.harness}:${ref.id}`;

  function emit(event: StoreEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        // A broken listener must not stop the stream; surface it outside this loop.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  function warn(harness: HarnessId, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (lastWarning.get(harness) === message) return;
    lastWarning.set(harness, message);
    emit({ type: "warning", harness, message });
  }

  function store(message: HarnessMessage): void {
    const index = indexByKey.get(message.key);
    if (index === undefined) {
      indexByKey.set(message.key, messages.length);
      messages.push(message);
    } else {
      messages[index] = message;
    }
    emit({ type: "message", message });
  }

  async function stopWatch(): Promise<void> {
    const current = active;
    active = undefined;
    if (!current) return;
    current.controller.abort();
    await current.done;
  }

  function startWatch(ref: SessionRef): void {
    const adapter = adapters.find((candidate) => candidate.id === ref.harness);
    if (!adapter) return;
    const controller = new AbortController();
    const done = (async () => {
      try {
        for await (const message of adapter.watch(ref, controller.signal)) {
          if (controller.signal.aborted) break;
          store(message);
        }
      } catch (error) {
        if (!controller.signal.aborted) warn(adapter.id, error);
      }
    })();
    active = { controller, done };
  }

  function switchTo(ref: SessionRef | undefined): Promise<void> {
    switching = switching.then(async () => {
      await stopWatch();
      if (disposed) return;
      session = ref;
      messages = [];
      indexByKey = new Map();
      emit({ type: "session", session: ref });
      if (ref) startWatch(ref);
    });
    return switching;
  }

  function stopLatest(): void {
    if (!latest) return;
    latest.stopped = true;
    clearTimeout(latest.timer);
    latest = undefined;
  }

  async function list(filter: { cwd?: string }): Promise<SessionRef[]> {
    const results = await Promise.allSettled(adapters.map((adapter) => adapter.sessions(filter)));
    const refs: SessionRef[] = [];
    results.forEach((result, index) => {
      const adapter = adapters[index] as HarnessAdapter;
      if (result.status === "fulfilled") {
        lastWarning.delete(adapter.id);
        refs.push(...result.value);
      } else {
        warn(adapter.id, result.reason);
      }
    });
    return refs.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async function pollLatest(follow: LatestFollow): Promise<void> {
    const refs = await list({ cwd: follow.cwd });
    if (follow.stopped) return;
    const newest = refs[0];
    const appeared = newest !== undefined && !follow.seen.has(sessionKey(newest));
    for (const ref of refs) follow.seen.add(sessionKey(ref));
    if (newest && (session === undefined || appeared) && sessionKey(newest) !== (session && sessionKey(session))) {
      await switchTo(newest);
    }
  }

  function schedule(follow: LatestFollow): void {
    if (follow.stopped) return;
    follow.timer = setTimeout(() => {
      void pollLatest(follow).finally(() => schedule(follow));
    }, pollMs);
  }

  return {
    get session() {
      return session;
    },
    get messages() {
      return messages;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    list,

    async followLatest(cwd) {
      stopLatest();
      if (disposed) return;
      const follow: LatestFollow = { cwd, seen: new Set(), timer: undefined, stopped: false };
      latest = follow;
      const refs = await list({ cwd });
      if (follow.stopped) return;
      for (const ref of refs) follow.seen.add(sessionKey(ref));
      const newest = refs[0];
      if (!newest || !session || sessionKey(newest) !== sessionKey(session)) await switchTo(newest);
      schedule(follow);
    },

    async follow(ref) {
      stopLatest();
      if (disposed) return;
      await switchTo(ref);
    },

    addManual(markdown, harness = "manual") {
      const count = ++manualCounts[harness];
      const now = new Date();
      const message: HarnessMessage = {
        key: `${harness}:${count}`,
        session: { harness, id: harness, updatedAt: now },
        markdown,
        createdAt: now,
        final: true,
        historical: false,
        commentary: false,
      };
      store(message);
      return message;
    },

    async dispose() {
      disposed = true;
      stopLatest();
      await switching;
      await stopWatch();
      listeners.clear();
    },
  };
}
