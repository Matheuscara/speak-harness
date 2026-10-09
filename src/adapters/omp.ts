import { join } from "node:path";
import type { HarnessAdapter } from "../core/types.ts";
import {
  createTranscriptAdapter,
  dateField,
  findJsonl,
  isRecord,
  joinText,
  stringField,
  type TranscriptAdapterOptions,
  type TranscriptFormat,
  type TranscriptParser,
  type TranscriptSample,
} from "./transcript.ts";

/*
 * OMP and Pi share one transcript format (verified on OMP 18.8 and Pi 0.84):
 *   <agentDir>/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl
 * OMP line 1: {"type":"title","title",...,"pad"} (rewritten in place), line 2: {"type":"session","id","cwd","title"?}.
 * Pi line 1: {"type":"session","id","cwd"}; the name comes from the latest {"type":"session_info","name"}.
 * Answers: {"type":"message","id","timestamp","message":{"role":"assistant","content":[{type:"text"|"thinking"|"toolCall"}]}}.
 * Directory names are an OMP/Pi implementation detail (home-relative, hashed, legacy `--abs--`), so cwd comes from the header.
 */

function describe(sample: TranscriptSample): { id?: string; title?: string; cwd?: string } {
  let id: string | undefined;
  let cwd: string | undefined;
  let headerTitle: string | undefined;
  let titleLine: string | undefined;
  for (const record of sample.head) {
    if (!isRecord(record)) continue;
    if (record.type === "title") titleLine = stringField(record, "title");
    else if (record.type === "session") {
      id = stringField(record, "id");
      cwd = stringField(record, "cwd");
      headerTitle = stringField(record, "title");
    }
  }
  let sessionName: string | undefined;
  for (const record of sample.tail) {
    if (isRecord(record) && record.type === "session_info") sessionName = typeof record.name === "string" ? record.name.trim() : undefined;
  }
  return { id, cwd, title: titleLine ?? (sessionName || undefined) ?? headerTitle };
}

function createParser(): TranscriptParser {
  return {
    push(record, line) {
      if (!isRecord(record) || record.type !== "message" || !isRecord(record.message)) return [];
      if (record.message.role !== "assistant") return [];
      const content = record.message.content;
      const markdown = joinText(content, "text");
      if (!markdown) return [];
      const commentary = Array.isArray(content) && content.some((part) => isRecord(part) && part.type === "toolCall");
      return [{ id: stringField(record, "id") ?? `line-${line}`, markdown, commentary, createdAt: dateField(record, "timestamp") }];
    },
    flush: () => [],
  };
}

function format(id: "omp" | "pi", label: string, sessionsRoot: string): TranscriptFormat {
  return {
    id,
    label,
    files: () => findJsonl(sessionsRoot, 1),
    headLines: 2,
    readTail: id === "pi",
    describe,
    createParser,
  };
}

export function createOmpAdapter(home: string, options?: TranscriptAdapterOptions): HarnessAdapter {
  return createTranscriptAdapter(format("omp", "OMP", join(home, ".omp", "agent", "sessions")), options);
}

export function createPiAdapter(home: string, options?: TranscriptAdapterOptions): HarnessAdapter {
  return createTranscriptAdapter(format("pi", "Pi", join(home, ".pi", "agent", "sessions")), options);
}
