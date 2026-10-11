import { chmod, lstat, mkdir, readdir, readlink, rename, symlink, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { paths } from "../core/paths.ts";
import type { ControlEndpoint } from "../core/paths.ts";
import type { CommandRegistry } from "../core/types.ts";

export const CURRENT_LINK = "current";
/** Pause before a standby instance retries when nothing answers on the pipe, yet binding it failed. */
const PIPE_RETRY_MS = 500;

export interface ControlServer {
  /** The socket or pipe this instance serves (a standby instance once it takes the pipe over). */
  path: string;
  /** `true` once this instance serves `path` (at once, unless it stands by for the pipe); `false` if it closed first. */
  serving: Promise<boolean>;
  close(): Promise<void>;
}

/** An explicit `pipe` or socket `dir`, else this platform's default endpoint. */
export function controlEndpoint(options: { dir?: string; pipe?: string } = {}): ControlEndpoint {
  if (options.pipe !== undefined) return { pipe: options.pipe };
  if (options.dir !== undefined) return { dir: options.dir };
  return paths.controlEndpoint();
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Sockets of running instances (`<pid>.sock`), newest first. */
export async function liveSockets(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const live: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const match = /^(\d+)\.sock$/.exec(name);
    if (!match || !processAlive(Number(match[1]))) continue;
    const stats = await lstat(join(dir, name)).catch(() => undefined);
    if (stats) live.push({ name, mtimeMs: stats.mtimeMs });
  }
  return live.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.name);
}

/** Atomically points `current` at socket `name`. */
async function pointCurrent(dir: string, name: string): Promise<void> {
  const tempLink = join(dir, `.${CURRENT_LINK}.${process.pid}`);
  await unlink(tempLink).catch(() => {});
  await symlink(name, tempLink);
  await rename(tempLink, join(dir, CURRENT_LINK));
}

/** Removes sockets left by processes that are gone, and a `current` link pointing at nothing. */
async function removeStale(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    const match = /^(\d+)\.sock$/.exec(name);
    if (match && !processAlive(Number(match[1]))) await unlink(join(dir, name)).catch(() => {});
  }
  const link = join(dir, CURRENT_LINK);
  const target = await readlink(link).catch(() => undefined);
  if (target !== undefined && !(await lstat(join(dir, target)).catch(() => undefined))) {
    await unlink(link).catch(() => {});
  }
}

function handleConnection(socket: Socket, registry: CommandRegistry): void {
  let buffer = "";
  let queue = Promise.resolve();
  socket.setEncoding("utf8");
  socket.on("data", (data: string) => {
    buffer += data;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line === "") continue;
      queue = queue.then(async () => {
        const reply = await runLine(line, registry);
        if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
      });
    }
  });
  socket.on("error", () => {});
}

async function runLine(line: string, registry: CommandRegistry): Promise<{ ok: true } | { ok: false; error: string }> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return { ok: false, error: "request is not valid JSON" };
  }
  if (typeof request !== "object" || request === null || !("command" in request) || typeof request.command !== "string") {
    return { ok: false, error: 'request must be {"command": string, "args"?: string[]}' };
  }
  const args = "args" in request ? request.args : undefined;
  if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === "string"))) {
    return { ok: false, error: "args must be an array of strings" };
  }
  try {
    await registry.run(request.command, args);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Serves `registry` on `path`; rejects when `path` cannot be listened on. Accepted sockets join `sockets`. */
async function listen(path: string, registry: CommandRegistry, sockets: Set<Socket>): Promise<Server> {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handleConnection(socket, registry);
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(path, () => listening.resolve());
  await listening.promise;
  return server;
}

/** Stops accepting and drops open connections. */
async function stop(server: Server, sockets: Set<Socket>): Promise<void> {
  const stopped = Promise.withResolvers<void>();
  server.close(() => stopped.resolve());
  for (const socket of sockets) socket.destroy();
  await stopped.promise;
}

/**
 * Connects to the instance serving `path`. Resolves `undefined` when none answers; otherwise `gone` settles when that
 * connection ends — the holder closed, crashed or dropped it — or `stopping` aborts.
 */
function watchHolder(path: string, stopping: AbortSignal): Promise<{ gone: Promise<void> } | undefined> {
  const connected = Promise.withResolvers<{ gone: Promise<void> } | undefined>();
  const gone = Promise.withResolvers<void>();
  const socket = createConnection(path);
  const done = () => {
    stopping.removeEventListener("abort", done);
    socket.destroy();
    connected.resolve(undefined);
    gone.resolve();
  };
  stopping.addEventListener("abort", done, { once: true });
  socket.once("connect", () => connected.resolve({ gone: gone.promise }));
  socket.on("error", done);
  socket.on("close", done);
  return connected.promise;
}

/**
 * `<dir>/<pid>.sock` (mode 0600) per instance; `current` points at the newest, and passes to another running instance
 * when its owner closes.
 */
async function startSocketDirServer(registry: CommandRegistry, dir: string): Promise<ControlServer> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await removeStale(dir);

  const name = `${process.pid}.sock`;
  const path = join(dir, name);
  await unlink(path).catch(() => {});

  const sockets = new Set<Socket>();
  const server = await listen(path, registry, sockets);
  await chmod(path, 0o600);

  const link = join(dir, CURRENT_LINK);
  await pointCurrent(dir, name);

  let closed: Promise<void> | undefined;
  return {
    path,
    serving: Promise.resolve(true),
    close() {
      closed ??= (async () => {
        await stop(server, sockets);
        await unlink(path).catch(() => {});
        if ((await readlink(link).catch(() => undefined)) !== name) return;
        // Hand `current` to another running instance (e.g. `speakh follow` next to a closed TUI).
        const next = (await liveSockets(dir)).find((other) => other !== name);
        if (next) await pointCurrent(dir, next).catch(() => {});
        else await unlink(link).catch(() => {});
      })();
      return closed;
    },
  };
}

/**
 * One per-user pipe (Windows): the first instance holds it; later ones stand by, connected to the holder, and take the
 * pipe over the moment that connection ends, so `speakh ctl` and the OMP extension always reach a running instance at
 * the same path. A pipe vanishes with its last handle, so a crashed holder leaves nothing to clean up.
 */
async function startPipeServer(registry: CommandRegistry, path: string): Promise<ControlServer> {
  const sockets = new Set<Socket>();
  const stopping = new AbortController();
  const started = Promise.withResolvers<void>();
  const serving = Promise.withResolvers<boolean>();
  let server: Server | undefined;
  // Connect before binding: whether a pipe bind is exclusive is the runtime's choice, so a live holder is asked first.
  // A standby instance keeps running (as a listening one would) until it takes the pipe over or closes.
  const running = (async () => {
    while (!stopping.signal.aborted) {
      const holder = await watchHolder(path, stopping.signal);
      if (holder) {
        started.resolve();
        await holder.gone;
        continue;
      }
      if (stopping.signal.aborted) break;
      server = await listen(path, registry, sockets).catch(() => undefined);
      if (server) break;
      started.resolve();
      // Nothing answers, yet the bind failed: another instance is binding right now, or the name is not ours.
      await sleep(PIPE_RETRY_MS, undefined, { signal: stopping.signal }).catch(() => {});
    }
    started.resolve();
    serving.resolve(server !== undefined);
  })();
  await started.promise;

  let closed: Promise<void> | undefined;
  return {
    path,
    serving: serving.promise,
    close() {
      closed ??= (async () => {
        stopping.abort();
        await running;
        if (server) await stop(server, sockets);
      })();
      return closed;
    },
  };
}

/**
 * Serves `registry` on the control endpoint: a socket per instance in `dir` (POSIX default) or the shared per-user
 * `pipe` (Windows default). Requests are newline-delimited JSON `{"command": id, "args": [...]}`, answered with
 * `{"ok": true}` or `{"ok": false, "error": "..."}`.
 */
export async function startControlServer(
  registry: CommandRegistry,
  options: { dir?: string; pipe?: string } = {},
): Promise<ControlServer> {
  const endpoint = controlEndpoint(options);
  return "pipe" in endpoint ? startPipeServer(registry, endpoint.pipe) : startSocketDirServer(registry, endpoint.dir);
}
