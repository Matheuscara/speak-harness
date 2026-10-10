import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "info" | "warning" | "error";

export interface Logger {
  readonly path: string | undefined;
  write(level: LogLevel, message: string): void;
}

/** Discards everything (tests, and callers that did not ask for a log). */
export const NO_LOG: Logger = { path: undefined, write() {} };

/**
 * Appends one line per entry to `path` (continuation lines indented), rotating to `<path>.1` once the file is
 * over `maxBytes` when the logger is created. Writing never throws: a broken log must not break reading aloud.
 */
export function createFileLogger(path: string, maxBytes = 1_000_000): Logger {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > maxBytes) renameSync(path, `${path}.1`);
  } catch {
    // Unwritable state directory: entries are dropped below.
  }
  return {
    path,
    write(level, message) {
      const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(7)} [${process.pid}] ${message.replace(/\n/g, "\n    ")}\n`;
      try {
        appendFileSync(path, line);
      } catch {
        // Ignored on purpose.
      }
    },
  };
}

/** Message plus stack (when there is one) for an unknown thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}
