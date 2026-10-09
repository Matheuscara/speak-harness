import { createConnection } from "node:net";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { CURRENT_LINK } from "./server.ts";

/** Sends one command to the running instance (via the `current` socket link). Throws with the server's error. */
export async function sendControlCommand(
  id: string,
  args: string[] = [],
  options: { dir?: string; timeoutMs?: number } = {},
): Promise<void> {
  const dir = options.dir ?? paths.runtimeDir();
  const path = join(dir, CURRENT_LINK);
  const done = Promise.withResolvers<string>();
  const socket = createConnection(path);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.setTimeout(options.timeoutMs ?? 10_000, () => done.reject(new Error(`speakh did not answer "${id}" in time`)));
  socket.on("connect", () => socket.write(`${JSON.stringify({ command: id, args })}\n`));
  socket.on("data", (data: string) => {
    buffer += data;
    const newline = buffer.indexOf("\n");
    if (newline >= 0) done.resolve(buffer.slice(0, newline));
  });
  socket.on("error", (error) => {
    const code = "code" in error ? error.code : undefined;
    done.reject(
      code === "ENOENT" || code === "ECONNREFUSED"
        ? new Error(`No running speakh instance (no control socket at ${path})`)
        : error,
    );
  });
  socket.on("end", () => done.reject(new Error("speakh closed the control connection without answering")));

  let line: string;
  try {
    line = await done.promise;
  } finally {
    socket.destroy();
  }
  const reply: unknown = JSON.parse(line);
  if (typeof reply !== "object" || reply === null || !("ok" in reply)) throw new Error(`Unexpected reply: ${line}`);
  if (reply.ok !== true) throw new Error("error" in reply && typeof reply.error === "string" ? reply.error : `"${id}" failed`);
}
