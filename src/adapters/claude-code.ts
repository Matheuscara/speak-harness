import { join } from "node:path";
import type { HarnessAdapter } from "../core/types.ts";
import {
  createTranscriptAdapter,
  dateField,
  findJsonl,
  isRecord,
  joinText,
  stringField,
  type MessageDraft,
  type TranscriptAdapterOptions,
  type TranscriptParser,
  type TranscriptSample,
} from "./transcript.ts";

/*
 * Claude Code transcripts (verified on 2.1.238): ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * Every conversation line carries "cwd" and "sessionId" (= file name); titles are {"type":"ai-title","aiTitle"} lines.
 * One API response is written as several {"type":"assistant","message":{"id","content":[<one block>]}} lines that
 * share `message.id` (thinking, text and tool_use blocks each get a line). A response ends at the next line that
 * is not part of it (tool results, attachments, `system`, `last-prompt`, another response). Lines with
 * "isSidechain": true belong to subagents; "isApiErrorMessage": true lines are synthetic error notices.
 */

function describe(sample: TranscriptSample): { title?: string; cwd?: string } {
  let cwd: string | undefined;
  let title: string | undefined;
  for (const record of [...sample.head, ...sample.tail]) {
    if (!isRecord(record)) continue;
    cwd ??= stringField(record, "cwd");
    if (record.type === "ai-title") title = stringField(record, "aiTitle") ?? title;
  }
  return { cwd, title };
}

interface Response {
  id: string;
  parts: string[];
  /** Some block of the response is a `tool_use`. */
  toolUse: boolean;
  createdAt: Date | undefined;
}

function createParser(): TranscriptParser {
  let open: Response | undefined;
  // The last closed response, reopened when a late block with the same id shows up.
  let closed: Response | undefined;

  const close = (): MessageDraft[] => {
    const response = open;
    open = undefined;
    if (!response) return [];
    closed = response;
    if (!response.parts.length) return [];
    return [{ id: response.id, markdown: response.parts.join("\n\n"), commentary: response.toolUse, createdAt: response.createdAt }];
  };

  return {
    push(record, line) {
      if (!isRecord(record) || record.isSidechain === true) return [];
      if (record.type !== "assistant" || !isRecord(record.message) || record.isApiErrorMessage === true) return close();
      const id = stringField(record.message, "id") ?? stringField(record, "uuid") ?? `line-${line}`;
      const drafts = open && open.id !== id ? close() : [];
      if (!open) open = closed?.id === id ? closed : { id, parts: [], toolUse: false, createdAt: dateField(record, "timestamp") };
      const content = record.message.content;
      const text = joinText(content, "text");
      if (text) open.parts.push(text);
      if (Array.isArray(content) && content.some((part) => isRecord(part) && part.type === "tool_use")) open.toolUse = true;
      return drafts;
    },
    flush: close,
  };
}

export function createClaudeCodeAdapter(home: string, options?: TranscriptAdapterOptions): HarnessAdapter {
  const root = join(home, ".claude", "projects");
  return createTranscriptAdapter(
    {
      id: "claude-code",
      label: "Claude Code",
      files: () => findJsonl(root, 1),
      headLines: 16,
      readTail: true,
      describe,
      createParser,
    },
    options,
  );
}
