import { createConnection } from "node:net";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { CURRENT_LINK, liveSockets } from "./server.ts";

class NotListening extends Error {}

/** Sends one request line to the socket at `path` and returns the reply line. */
async function request(path: string, id: string, args: string[], timeoutMs: number): Promise<string> {
  const done = Promise.withResolvers<string>();
  const socket = createConnection(path);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.setTimeout(timeoutMs, () => done.reject(new Error(`speakh did not answer "${id}" in time`)));
  socket.on("connect", () => socket.write(`${JSON.stringify({ command: id, args })}\n`));
  socket.on("data", (data: string) => {
    buffer += data;
    const newline = buffer.indexOf("\n");
    if (newline >= 0) done.resolve(buffer.slice(0, newline));
  });
  socket.on("error", (error) => {
    const code = "code" in error ? error.code : undefined;
    done.reject(code === "ENOENT" || code === "ECONNREFUSED" ? new NotListening(path) : error);
  });
  socket.on("end", () => done.reject(new Error("speakh closed the control connection without answering")));
  try {
    return await done.promise;
  } finally {
    socket.destroy();
  }
}

/**
 * Sends one command to the running instance: the `current` socket link first, then any other running
 * instance (newest first). Throws with the server's error.
 */
export async function sendControlCommand(
  id: string,
  args: string[] = [],
  options: { dir?: string; timeoutMs?: number } = {},
): Promise<void> {
  const dir = options.dir ?? paths.runtimeDir();
  const candidates = [CURRENT_LINK, ...(await liveSockets(dir))];
  let line: string | undefined;
  for (const name of candidates) {
    try {
      line = await request(join(dir, name), id, args, options.timeoutMs ?? 10_000);
      break;
    } catch (error) {
      if (!(error instanceof NotListening)) throw error;
    }
  }
  if (line === undefined) throw new Error(`No running speakh instance (no control socket in ${dir})`);
  const reply: unknown = JSON.parse(line);
  if (typeof reply !== "object" || reply === null || !("ok" in reply)) throw new Error(`Unexpected reply: ${line}`);
  if (reply.ok !== true) throw new Error("error" in reply && typeof reply.error === "string" ? reply.error : `"${id}" failed`);
}
