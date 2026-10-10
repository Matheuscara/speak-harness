import { chmod, lstat, mkdir, readdir, readlink, rename, symlink, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import type { CommandRegistry } from "../core/types.ts";

export const CURRENT_LINK = "current";

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

/**
 * Listens on `<runtimeDir>/<pid>.sock` (mode 0600) and points `current` at it. Requests are newline-delimited
 * JSON `{"command": id, "args": [...]}`, answered with `{"ok": true}` or `{"ok": false, "error": "..."}`.
 */
export async function startControlServer(
  registry: CommandRegistry,
  options: { dir?: string } = {},
): Promise<{ path: string; close(): Promise<void> }> {
  const dir = options.dir ?? paths.runtimeDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await removeStale(dir);

  const name = `${process.pid}.sock`;
  const path = join(dir, name);
  await unlink(path).catch(() => {});

  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handleConnection(socket, registry);
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(path, () => listening.resolve());
  await listening.promise;
  await chmod(path, 0o600);

  const link = join(dir, CURRENT_LINK);
  await pointCurrent(dir, name);

  let closed: Promise<void> | undefined;
  return {
    path,
    close() {
      closed ??= (async () => {
        const stopped = Promise.withResolvers<void>();
        server.close(() => stopped.resolve());
        for (const socket of sockets) socket.destroy();
        await stopped.promise;
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
