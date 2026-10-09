import { basename, join } from "node:path";
import type { HarnessAdapter } from "../core/types.ts";
import {
  createTranscriptAdapter,
  dateField,
  findJsonl,
  firstValue,
  isRecord,
  joinText,
  latestDate,
  promptTitle,
  stringField,
  type TranscriptAdapterOptions,
  type TranscriptParser,
} from "./transcript.ts";

/** Role of a `response_item` message line. */
function role(record: Record<string, unknown>): unknown {
  return record.type === "response_item" && isRecord(record.payload) && record.payload.type === "message" ? record.payload.role : undefined;
}

/** Text the user typed; Codex also injects `<environment_context>` and AGENTS.md instructions as user messages. */
function typedPrompt(record: Record<string, unknown>): string | undefined {
  if (role(record) !== "user" || !isRecord(record.payload)) return undefined;
  const text = joinText(record.payload.content, "input_text");
  if (!text || text.startsWith("<") || text.startsWith("# AGENTS.md")) return undefined;
  return promptTitle(text);
}

/*
 * Codex rollouts (verified on codex-cli 0.159): ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl
 * Line 1: {"timestamp","type":"session_meta","payload":{"id","cwd",...}}.
 * Answers: {"timestamp","ordinal","type":"response_item","payload":{"type":"message","id","role":"assistant",
 *   "content":[{"type":"output_text","text"}],"phase":"commentary"|"final_answer"}}.
 * Reasoning, function/custom tool calls and their outputs are other payload types; `event_msg` lines duplicate
 * answers and are ignored.
 */

function createParser(): TranscriptParser {
  return {
    push(record, line) {
      if (!isRecord(record) || record.type !== "response_item" || !isRecord(record.payload)) return [];
      const payload = record.payload;
      if (payload.role !== "assistant" || (payload.type !== undefined && payload.type !== "message")) return [];
      const markdown = joinText(payload.content, "output_text");
      if (!markdown) return [];
      const ordinal = typeof record.ordinal === "number" ? `ordinal-${record.ordinal}` : undefined;
      return [
        {
          id: stringField(payload, "id") ?? ordinal ?? `line-${line}`,
          markdown,
          commentary: payload.phase === "commentary",
          createdAt: dateField(record, "timestamp"),
        },
      ];
    },
    flush: () => [],
  };
}

export function createCodexAdapter(home: string, options?: TranscriptAdapterOptions): HarnessAdapter {
  const root = join(home, ".codex", "sessions");
  return createTranscriptAdapter(
    {
      id: "codex",
      label: "Codex",
      files: async () => (await findJsonl(root, 3)).filter((path) => basename(path).startsWith("rollout-")),
      headLines: 40,
      readTail: true,
      describe(sample) {
        const meta = sample.head[0];
        if (!isRecord(meta) || meta.type !== "session_meta" || !isRecord(meta.payload)) return {};
        return {
          id: stringField(meta.payload, "id"),
          cwd: stringField(meta.payload, "cwd"),
          title: firstValue(sample.head, typedPrompt),
          lastActivity: latestDate(sample.tail, (record) => {
            const r = role(record);
            return r === "user" || r === "assistant" ? dateField(record, "timestamp") : undefined;
          }),
        };
      },
      createParser,
    },
    options,
  );
}
