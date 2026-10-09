import { readdir, open, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { HarnessAdapter, HarnessId, HarnessMessage, SessionRef } from "../core/types.ts";
import { tailJsonl } from "./jsonl-tail.ts";

/** One assistant answer as parsed from a transcript, before it becomes a `HarnessMessage`. */
export interface MessageDraft {
  /** Message id within the session (the transcript's own id when present). */
  id: string;
  markdown: string;
  /** In-between narration sent alongside tool calls. */
  commentary: boolean;
  createdAt?: Date;
}

/** Stateful mapper from transcript records to assistant answers. */
export interface TranscriptParser {
  push(record: unknown, line: number): MessageDraft[];
  /** Emits answers still held back (end of history, or the tail went quiet). */
  flush(): MessageDraft[];
}

/** Records sampled from a transcript to describe its session without reading it all. */
export interface TranscriptSample {
  path: string;
  /** First complete lines, in order. */
  head: unknown[];
  /** Last complete lines, in order (only when the format asks for them). */
  tail: unknown[];
}

export interface TranscriptFormat {
  id: HarnessId;
  label: string;
  /** Transcript files; a missing root yields none. */
  files(): Promise<string[]>;
  /** How many head lines `describe` needs. */
  headLines: number;
  /** Whether `describe` needs the tail of the file (titles that change over time). */
  readTail: boolean;
  describe(sample: TranscriptSample): { id?: string; title?: string; cwd?: string };
  createParser(): TranscriptParser;
}

export interface TranscriptAdapterOptions {
  /** Poll interval for following appends. */
  pollMs?: number;
  /** Quiet time after which held-back answers are emitted while following. */
  settleMs?: number;
}

const HEAD_MAX_BYTES = 4 << 20;
const TAIL_BYTES = 64 << 10;
const DESCRIBE_CONCURRENCY = 32;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function dateField(record: Record<string, unknown>, key: string): Date | undefined {
  const value = record[key];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Joins the non-empty `text` of content parts of the given type; a plain string counts as text. */
export function joinText(content: unknown, partType: string): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== partType || typeof part.text !== "string") continue;
    const text = part.text.trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

/** Lists `*.jsonl` files `depth` directory levels below `root` (0 = directly inside). */
export async function findJsonl(root: string, depth: number): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (depth === 0) {
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => join(root, entry.name));
  }
  const nested = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => findJsonl(join(root, entry.name), depth - 1)),
  );
  return nested.flat();
}

function parseLines(text: string): unknown[] {
  const records: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Broken line: ignored.
    }
  }
  return records;
}

async function sample(path: string, size: number, headLines: number, readTail: boolean): Promise<TranscriptSample> {
  const handle = await open(path, "r");
  try {
    const decoder = new TextDecoder();
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let newlines = 0;
    const buffer = new Uint8Array(64 << 10);
    while (offset < size && offset < HEAD_MAX_BYTES && newlines < headLines) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (bytesRead === 0) break;
      const chunk = buffer.slice(0, bytesRead);
      chunks.push(chunk);
      offset += bytesRead;
      for (const byte of chunk) if (byte === 0x0a) newlines++;
    }
    const headText = decoder.decode(Buffer.concat(chunks));
    const headComplete = headText.slice(0, headText.lastIndexOf("\n") + 1);
    const head = parseLines(headComplete).slice(0, headLines);

    let tail: unknown[] = [];
    if (readTail && size > offset) {
      const start = Math.max(offset, size - TAIL_BYTES);
      const tailBuffer = new Uint8Array(size - start);
      const { bytesRead } = await handle.read(tailBuffer, 0, tailBuffer.length, start);
      const tailText = decoder.decode(tailBuffer.subarray(0, bytesRead));
      // Drop the first (possibly cut) line unless the window starts right after the head.
      const firstBreak = start === offset ? 0 : tailText.indexOf("\n") + 1;
      tail = parseLines(tailText.slice(firstBreak, tailText.lastIndexOf("\n") + 1));
    } else if (readTail) {
      tail = parseLines(headComplete);
    }
    return { path, head, tail };
  } finally {
    await handle.close();
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Adapter for file-backed harnesses: lists transcripts, describes them from samples, follows one with `tailJsonl`. */
export function createTranscriptAdapter(format: TranscriptFormat, options: TranscriptAdapterOptions = {}): HarnessAdapter {
  const cache = new Map<string, { mtimeMs: number; size: number; ref: SessionRef }>();

  async function describe(path: string): Promise<SessionRef | undefined> {
    let stats;
    try {
      stats = await stat(path);
    } catch {
      return undefined; // Removed between listing and stat.
    }
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.ref;
    const info = format.describe(await sample(path, stats.size, format.headLines, format.readTail));
    const ref: SessionRef = {
      harness: format.id,
      id: info.id ?? basename(path, ".jsonl"),
      path,
      updatedAt: stats.mtime,
    };
    if (info.title) ref.title = info.title;
    if (info.cwd) ref.cwd = info.cwd;
    cache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, ref });
    return ref;
  }

  return {
    id: format.id,
    label: format.label,

    async sessions(filter) {
      const files = await format.files();
      const known = new Set(files);
      for (const path of cache.keys()) if (!known.has(path)) cache.delete(path);
      const refs = await mapLimit(files, DESCRIBE_CONCURRENCY, describe);
      const cwd = filter.cwd === undefined ? undefined : resolve(filter.cwd);
      return refs
        .filter((ref): ref is SessionRef => ref !== undefined && (cwd === undefined || (ref.cwd !== undefined && resolve(ref.cwd) === cwd)))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    },

    async *watch(session, signal) {
      if (!session.path) throw new Error(`${format.label} session ${session.id} has no transcript path`);
      let parser = format.createParser();
      let historical = true;
      const emitted = new Map<string, string>();
      const tail = tailJsonl(session.path, { signal, pollMs: options.pollMs, settleMs: options.settleMs });
      for await (const event of tail) {
        let drafts: MessageDraft[] = [];
        if (event.type === "record") drafts = parser.push(event.value, event.line);
        else if (event.type === "settled" || (event.type === "idle" && historical)) drafts = parser.flush();
        else if (event.type === "reset") parser = format.createParser();
        for (const draft of drafts) {
          const markdown = draft.markdown.trim();
          if (!markdown) continue;
          const key = `${format.id}:${session.id}:${draft.id}`;
          // Restarts re-read the file; already delivered answers are only re-sent when they changed.
          const signature = `${draft.commentary}\n${markdown}`;
          if (emitted.get(key) === signature) continue;
          emitted.set(key, signature);
          const message: HarnessMessage = {
            key,
            session,
            markdown,
            createdAt: draft.createdAt ?? session.updatedAt,
            final: true,
            historical,
            commentary: draft.commentary,
          };
          yield message;
        }
        if (event.type === "idle") historical = false;
      }
    },
  };
}
